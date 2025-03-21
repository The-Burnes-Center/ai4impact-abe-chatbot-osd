from datetime import datetime
import json
import boto3
import os
import csv
import io
import uuid
import logging
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from botocore.exceptions import ClientError
import asyncio

# Import the API client for getting app responses
from api_client import get_app_response

GENERATE_RESPONSE_LAMBDA_NAME = os.environ.get('GENERATE_RESPONSE_LAMBDA_NAME')
BEDROCK_MODEL_ID = os.environ.get('BEDROCK_MODEL_ID', 'anthropic.claude-3-haiku-20240307-v1:0')  # Keep for compatibility
TEST_CASES_BUCKET = os.environ['TEST_CASES_BUCKET']
# Note: We're keeping partial results in TEST_CASES_BUCKET but retrieving this env var
# for future improvements where we might want to write directly to EVAL_RESULTS_BUCKET
EVAL_RESULTS_BUCKET = os.environ.get('EVAL_RESULTS_BUCKET', TEST_CASES_BUCKET)
# Chatbot API URL for websocket connection
CHATBOT_API_URL = os.environ.get('CHATBOT_API_URL', 'https://dcf43zj2k8alr.cloudfront.net')

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s'
)
logger = logging.getLogger(__name__)

# Initialize clients outside the loop
s3_client = boto3.client('s3')
lambda_client = boto3.client('lambda')

def lambda_handler(event, context): 
    try:  
        chunk_key = event["chunk_key"]
        evaluation_id = event["evaluation_id"]
        logging.info(f"Processing chunk: {chunk_key} for evaluation: {evaluation_id}")
        
        # Log environment variables for debugging
        logging.info(f"Environment variables: CHATBOT_API_URL={CHATBOT_API_URL}, TEST_CASES_BUCKET={TEST_CASES_BUCKET}")
        
        test_cases = read_chunk_from_s3(s3_client, TEST_CASES_BUCKET, chunk_key)
        logging.info(f"Successfully read test cases from S3. Count: {len(test_cases)}")

        # Arrays to collect results
        detailed_results = []
        total_similarity = 0
        total_relevance = 0
        total_correctness = 0

        # Initialize an event loop for async operations
        loop = asyncio.get_event_loop()
        
        # Set the API URL in the environment for the API client to use
        os.environ['CHATBOT_API_URL'] = CHATBOT_API_URL
        logging.info(f"Set CHATBOT_API_URL in environment to: {CHATBOT_API_URL}")

        # Process each test case
        for idx, test_case in enumerate(test_cases):
            try:
                question = test_case['question']
                expected_response = test_case['expectedResponse']

                logging.info(f"Processing test case {idx+1}/{len(test_cases)}: {question[:50]}...")

                # Get app's response using the API client
                app_response_data = loop.run_until_complete(get_app_response(question))
                
                # Check for errors in the response
                if app_response_data.get('error'):
                    logging.error(f"Error from API client for test case {idx+1}: {app_response_data.get('error')}")
                
                actual_response = app_response_data['response']
                retrieved_contexts = app_response_data['retrieved_contexts']

                logging.info(f"Got response from API, length: {len(actual_response)}, contexts: {len(retrieved_contexts)}")

                # Evaluate the response using RAGAS
                response = evaluate_with_ragas(question, expected_response, actual_response, retrieved_contexts)
                if response['status'] == 'error':
                    logging.warning(f"Error evaluating test case with question: {question[:50]}... Error: {response.get('error')}")
                    continue
                else:
                    similarity = response['scores']['similarity']
                    relevance = response['scores']['relevance']
                    correctness = response['scores']['correctness']
                    logging.info(f"Evaluation scores - similarity: {similarity}, relevance: {relevance}, correctness: {correctness}")

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
            except Exception as e:
                logging.error(f"Error processing test case {idx+1}: {str(e)}")
                logging.error(traceback.format_exc())
                # Add a failed result entry to avoid losing the test case
                detailed_results.append({
                    'question': test_case.get('question', 'Unknown'),
                    'expectedResponse': test_case.get('expectedResponse', 'Unknown'),
                    'actualResponse': f"Error: {str(e)}",
                    'retrievedContexts': [],
                    'sources': [],
                    'similarity': 0,
                    'relevance': 0,
                    'correctness': 0,
                    'error': str(e)
                })

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
            logging.error(traceback.format_exc())
            raise Exception(f"Failed to write partial results to S3. Bucket: {TEST_CASES_BUCKET}, Key: {partial_result_key}. Error: {str(e)}")

        # Return only the S3 key
        return {
            "partial_result_key": partial_result_key
        }
        
    except Exception as e:
        logging.error(f"Error in evaluation Lambda: {str(e)}")
        logging.error(traceback.format_exc())
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e),
                'traceback': traceback.format_exc()
            }),
        }

def evaluate_with_ragas(question, expected_response, actual_response, retrieved_contexts=None):
    """
    Evaluate the response using RAGAS metrics directly without using Bedrock models.
    """
    try:
        from datasets import Dataset
        from ragas.metrics import answer_correctness, answer_similarity, answer_relevancy
        import pandas as pd
        
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
        
        # Use the RAGAS metrics directly
        # Simplified similarity calculation using the RAGAS metric
        similarity = answer_similarity.score({"answer": actual_response, "reference": expected_response})
        
        # Simplified relevance calculation
        relevance = answer_relevancy.score({"answer": actual_response, "question": question, "contexts": contexts})
        
        # Simplified correctness calculation
        correctness = answer_correctness.score({"answer": actual_response, "reference": expected_response, "question": question})
        
        logging.info(f"Similarity: {similarity}, Relevance: {relevance}, Correctness: {correctness}")
        
        return {"status": "success", "scores": {"similarity": similarity, "relevance": relevance, "correctness": correctness}}
    except Exception as e:
        logging.error(f"Error in RAGAS evaluation: {str(e)}")
        logging.error(traceback.format_exc())
        return {"status": "error", "error": str(e)}
    
def read_chunk_from_s3(s3_client, bucket_name, key):
    try:
        response = s3_client.get_object(Bucket=bucket_name, Key=key)
        content = response['Body'].read().decode('utf-8')
        return json.loads(content)
    except Exception as e:
        logging.error(f"Error reading chunk from S3: {str(e)}")
        logging.error(f"Bucket: {bucket_name}, Key: {key}")
        logging.error(traceback.format_exc())
        raise
