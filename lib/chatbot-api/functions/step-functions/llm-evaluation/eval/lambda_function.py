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

GENERATE_RESPONSE_LAMBDA_NAME = os.environ['GENERATE_RESPONSE_LAMBDA_NAME']
BEDROCK_MODEL_ID = os.environ['BEDROCK_MODEL_ID']
TEST_CASES_BUCKET = os.environ['TEST_CASES_BUCKET']

# Initialize clients outside the loop
s3_client = boto3.client('s3')
lambda_client = boto3.client('lambda')

def lambda_handler(event, context): 
    print("in the handler function")
    try:  
        chunk_key = event["chunk_key"]
        evaluation_id = event["evaluation_id"]
        print("Processing chunk:", chunk_key)
        test_cases = read_chunk_from_s3(s3_client, TEST_CASES_BUCKET, chunk_key)

        # Arrays to collect results
        detailed_results = []
        total_similarity = 0
        total_relevance = 0
        total_correctness = 0
        #num_test_cases = len(test_cases)
        # num_test_cases = len(event)


        # Process each test case
        for test_case in test_cases:
            print("test_case: ", test_case)
            question = test_case['question']
            expected_response = test_case['expectedResponse']

            # Invoke generateResponseLambda to get the actual response
            actual_response = invoke_generate_response_lambda(lambda_client, question)

            # Evaluate the response using RAGAS
            response = evaluate_with_ragas(question, expected_response, actual_response)
            print("response: ", response)
            if response['status'] == 'error':
                print("error status going to next iteration")
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
        s3_client.put_object(
            Bucket=TEST_CASES_BUCKET,
            Key=partial_result_key,
            Body=json.dumps(partial_results)
        )

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

async def process_test_case(lambda_client, test_case):
    try:
        question = test_case['question']
        expected_response = test_case['expectedResponse']

        # Invoke generate response Lambda
        actual_response = invoke_generate_response_lambda(lambda_client, question)

        # Evaluate with RAGAS
        result = evaluate_with_ragas(question, expected_response, actual_response)
        if result['status'] == 'error':
            return None

        return {
            'question': question,
            'expectedResponse': expected_response,
            'actualResponse': actual_response,
            'similarity': result['scores']['similarity'],
            'relevance': result['scores']['relevance'],
            'correctness': result['scores']['correctness'],
        }
    except Exception as e:
        logging.error(f"Error processing test case: {e}")
        return None
    
async def process_all_test_cases(test_cases, lambda_client):
    tasks = [process_test_case(lambda_client, test_case) for test_case in test_cases]
    return await asyncio.gather(*tasks)

def invoke_generate_response_lambda(lambda_client, question):
    try:
        response = lambda_client.invoke(
            FunctionName=GENERATE_RESPONSE_LAMBDA_NAME,
            InvocationType='RequestResponse',
            Payload=json.dumps({'userMessage': question, 'chatHistory': []}),
        )
        print("response: ", response["Payload"])
        payload = response['Payload'].read().decode('utf-8')
        result = json.loads(payload)
        print("result: ", result)
        body = json.loads(result.get('body', {}))
        print("body: ", body)
        return body.get('modelResponse', '')
    except Exception as e:
        logging.error(f"Error invoking generateResponseLambda: {str(e)}")
        return ""

def evaluate_with_ragas(question, expected_response, actual_response):
    try:
        from datasets import Dataset
        from ragas import evaluate
        from ragas.metrics import answer_correctness, answer_similarity, answer_relevancy
        metrics = [answer_correctness, answer_similarity, answer_relevancy]

        # Prepare data for RAGAS
        data_sample = {
            "question": [question],
            "answer": [actual_response],
            "reference": [expected_response],
            "retrieved_contexts": [[expected_response]]
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
