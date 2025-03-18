from datetime import datetime
import json
import boto3
import os
import csv
import io
import uuid
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from botocore.exceptions import ClientError
import asyncio

#from langchain_community.chat_models import BedrockChat
from langchain_aws import ChatBedrock as BedrockChat
#from langchain_community.embeddings import BedrockEmbeddings
from langchain_aws import BedrockEmbeddings
#from langchain.chat_models import ChatBedrock as BedrockChat
#from langchain.embeddings import BedrockEmbeddings

# Import the API client for getting app responses
from api_client import get_app_response

GENERATE_RESPONSE_LAMBDA_NAME = os.environ.get('GENERATE_RESPONSE_LAMBDA_NAME')
BEDROCK_MODEL_ID = os.environ['BEDROCK_MODEL_ID']
TEST_CASES_BUCKET = os.environ['TEST_CASES_BUCKET']
# Note: We're keeping partial results in TEST_CASES_BUCKET but retrieving this env var
# for future improvements where we might want to write directly to EVAL_RESULTS_BUCKET
EVAL_RESULTS_BUCKET = os.environ.get('EVAL_RESULTS_BUCKET', TEST_CASES_BUCKET)
# Chatbot API URL for websocket connection
CHATBOT_API_URL = os.environ.get('CHATBOT_API_URL', 'https://dcf43zj2k8alr.cloudfront.net')

# Initialize clients outside the loop
s3_client = boto3.client('s3')
lambda_client = boto3.client('lambda')

def lambda_handler(event, context): 
    try:  
        chunk_key = event["chunk_key"]
        evaluation_id = event["evaluation_id"]
        logging.info(f"Processing chunk: {chunk_key} for evaluation: {evaluation_id}")
        test_cases = read_chunk_from_s3(s3_client, TEST_CASES_BUCKET, chunk_key)

        # Arrays to collect results
        detailed_results = []
        total_similarity = 0
        total_relevance = 0
        total_correctness = 0

        # Initialize an event loop for async operations
        loop = asyncio.get_event_loop()
        
        # Set the API URL in the environment for the API client to use
        os.environ['CHATBOT_API_URL'] = CHATBOT_API_URL

        # Process each test case
        for test_case in test_cases:
            question = test_case['question']
            expected_response = test_case['expectedResponse']

            # Get app's response using the API client
            app_response_data = loop.run_until_complete(get_app_response(question))
            
            actual_response = app_response_data['response']
            retrieved_contexts = app_response_data['retrieved_contexts']

            # Evaluate the response using RAGAS
            response = evaluate_with_ragas(question, expected_response, actual_response, retrieved_contexts)
            if response['status'] == 'error':
                logging.warning(f"Error evaluating test case with question: {question[:50]}...")
                continue
            else:
                similarity = response['scores']['similarity']
                relevance = response['scores']['relevance']
                correctness = response['scores']['correctness']

            # Collect results
            detailed_results.append({
                'question': question,
                'expectedResponse': expected_response,
                'actualResponse': actual_response,
                'retrievedContexts': retrieved_contexts,
                'sources': app_response_data.get('sources', []),
                'similarity': similarity,
                'relevance': relevance,
                'correctness': correctness,
            })

            total_similarity += similarity
            total_relevance += relevance
            total_correctness += correctness

        partial_results = {
            "detailed_results": detailed_results,
            "total_similarity": total_similarity,
            "total_relevance": total_relevance,
            "total_correctness": total_correctness, 
            "num_test_cases": len(detailed_results),
        }
        # Write partial_results to S3
        partial_result_key = f"evaluations/{evaluation_id}/partial_results/{os.path.basename(chunk_key)}"
        try:
            s3_client.put_object(
                Bucket=TEST_CASES_BUCKET,
                Key=partial_result_key,
                Body=json.dumps(partial_results)
            )
            logging.info(f"Successfully wrote partial results to S3: {TEST_CASES_BUCKET}/{partial_result_key}")
        except Exception as e:
            logging.error(f"Error writing partial results to S3: {str(e)}")
            raise Exception(f"Failed to write partial results to S3. Bucket: {TEST_CASES_BUCKET}, Key: {partial_result_key}. Error: {str(e)}")

        # Return only the S3 key
        return {
            "partial_result_key": partial_result_key
        }
        
    except Exception as e:
        logging.error(f"Error in evaluation Lambda: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e),
            }),
        }

def evaluate_with_ragas(question, expected_response, actual_response, retrieved_contexts=None):
    try:
        from datasets import Dataset
        from ragas import evaluate
        from ragas.metrics import answer_correctness, answer_similarity, answer_relevancy
        metrics = [answer_correctness, answer_similarity, answer_relevancy]

        # Prepare data for RAGAS
        if retrieved_contexts and len(retrieved_contexts) > 0:
            contexts = retrieved_contexts
        else:
            contexts = [expected_response]  # Fallback to using expected response as context

        data_sample = {
            "question": [question],
            "answer": [actual_response],
            "reference": [expected_response],
            "retrieved_contexts": [contexts]
        }
        data_samples = Dataset.from_dict(data_sample)

        # Load LLM and embeddings
        region_name = 'us-east-1'
        bedrock_model = BedrockChat(region_name=region_name, endpoint_url=f"https://bedrock-runtime.{region_name}.amazonaws.com", model_id=BEDROCK_MODEL_ID)
        bedrock_embeddings = BedrockEmbeddings(region_name=region_name, model_id='amazon.titan-embed-text-v1')

        # Evaluate
        result = evaluate(data_samples, metrics=metrics, llm=bedrock_model, embeddings=bedrock_embeddings)
        scores = result.to_pandas().iloc[0]

        # if any score is nan, return error
        if scores.isnull().values.any():
            raise ValueError("RAGAS evaluation returned NaN scores")
        
        return {"status": "success", "scores": {"similarity": scores['semantic_similarity'], "relevance": scores['answer_relevancy'], "correctness": scores['answer_correctness']}}
    except Exception as e:
        logging.error(f"Error in RAGAS evaluation: {str(e)}")
        return {"status": "error", "error": str(e)}
    
def read_chunk_from_s3(s3_client, bucket_name, key):
    response = s3_client.get_object(Bucket=bucket_name, Key=key)
    content = response['Body'].read().decode('utf-8')
    return json.loads(content)
