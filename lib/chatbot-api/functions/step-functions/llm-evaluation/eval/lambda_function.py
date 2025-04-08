from datetime import datetime
import json
import boto3
import os
import io
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
import pandas as pd

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

from langchain_aws import ChatBedrock as BedrockChat
from langchain_aws import BedrockEmbeddings

# Required environment variables
GENERATE_RESPONSE_LAMBDA_NAME = os.environ['GENERATE_RESPONSE_LAMBDA_NAME']
BEDROCK_MODEL_ID = os.environ['BEDROCK_MODEL_ID']
TEST_CASES_BUCKET = os.environ['TEST_CASES_BUCKET']
# Note: We're keeping partial results in TEST_CASES_BUCKET but retrieving this env var
# for future improvements where we might want to write directly to EVAL_RESULTS_BUCKET
EVAL_RESULTS_BUCKET = os.environ.get('EVAL_RESULTS_BUCKET', TEST_CASES_BUCKET)
# Set max workers for ThreadPoolExecutor - default to 10 or less if fewer test cases
MAX_WORKERS = 10

# Initialize clients outside the loop with proper configuration
s3_client = boto3.client('s3')
lambda_client = boto3.client('lambda')

def lambda_handler(event, context): 
    try:  
        chunk_key = event["chunk_key"]
        evaluation_id = event["evaluation_id"]
        logging.info(f"Processing chunk: {chunk_key} for evaluation: {evaluation_id}")
        test_cases = read_chunk_from_s3(s3_client, TEST_CASES_BUCKET, chunk_key)
        
        logging.info(f"Retrieved {len(test_cases)} test cases to evaluate")
        
        # Validate test cases
        for idx, test_case in enumerate(test_cases):
            if 'question' not in test_case or 'expectedResponse' not in test_case:
                logging.error(f"Invalid test case at index {idx}: missing required fields")
                test_cases[idx] = {'question': f"Invalid test case {idx}", 'expectedResponse': ""}

        # Use ThreadPoolExecutor for parallel processing
        detailed_results = []
        total_similarity = 0
        total_relevance = 0
        total_correctness = 0
        total_context_precision = 0
        total_context_recall = 0
        total_response_relevancy = 0
        total_faithfulness = 0
        
        # Set workers to min of MAX_WORKERS or number of test cases
        workers = min(MAX_WORKERS, len(test_cases))
        
        with ThreadPoolExecutor(max_workers=workers) as executor:
            # Submit all tasks
            future_to_idx = {executor.submit(process_test_case, idx, test_case): idx 
                             for idx, test_case in enumerate(test_cases)}
            
            # Process results as they complete
            for future in as_completed(future_to_idx):
                idx = future_to_idx[future]
                try:
                    result = future.result()
                    detailed_results.append(result)
                    
                    # Add to totals
                    total_similarity += result['similarity']
                    total_relevance += result['relevance']
                    total_correctness += result['correctness']
                    total_context_precision += result['context_precision']
                    total_context_recall += result['context_recall']
                    total_response_relevancy += result['response_relevancy']
                    total_faithfulness += result['faithfulness']
                    
                except Exception as e:
                    logging.error(f"Error processing test case {idx+1}: {str(e)}")
                    # Add error entry
                    test_case = test_cases[idx]
                    detailed_results.append({
                        'question': test_case.get('question', f"Question {idx+1}"),
                        'expectedResponse': test_case.get('expectedResponse', ''),
                        'actualResponse': 'Error during evaluation',
                        'similarity': 0.0,
                        'relevance': 0.0,
                        'correctness': 0.0,
                        'context_precision': 0.0,
                        'context_recall': 0.0,
                        'response_relevancy': 0.0,
                        'faithfulness': 0.0,
                        'error': str(e)
                    })

        # Ensure at least one result is available
        num_results = len(detailed_results)
        if num_results == 0:
            logging.warning(f"No test cases were successfully evaluated for chunk: {chunk_key}")
            # Create a partial result with zeros
            partial_results = {
                "detailed_results": [],
                "total_similarity": 0,
                "total_relevance": 0,
                "total_correctness": 0,
                "num_test_cases": 0,
                "total_context_precision": 0,
                "total_context_recall": 0,
                "total_response_relevancy": 0,
                "total_faithfulness": 0
            }
        else:
            partial_results = {
                "detailed_results": detailed_results,
                "total_similarity": total_similarity,
                "total_relevance": total_relevance,
                "total_correctness": total_correctness, 
                "num_test_cases": num_results,
                "total_context_precision": total_context_precision,
                "total_context_recall": total_context_recall,
                "total_response_relevancy": total_response_relevancy,
                "total_faithfulness": total_faithfulness
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
            # Continue even if S3 write fails, so we can return the partial_result_key
            
        # Return the partial results key and also include the evaluation_id to ensure it's passed through the state machine
        return {
            "partial_result_key": partial_result_key,
            "evaluation_id": evaluation_id,  # Ensure the evaluation_id is included in the response
            "num_test_cases": num_results
        }
        
    except Exception as e:
        logging.error(f"Error in evaluation Lambda: {str(e)}")
        # Return a structured error that preserves the evaluation_id
        return {
            'statusCode': 500,
            'body': json.dumps({
                'error': str(e),
                'evaluation_id': event.get("evaluation_id")  # Return the evaluation_id even in case of error
            }),
            'evaluation_id': event.get("evaluation_id")  # Also include it at the top level
        }

def process_test_case(idx, test_case):
    """Process a single test case with proper error handling"""
    try:
        question = test_case['question']
        expected_response = test_case['expectedResponse']
        
        logging.info(f"Processing test case {idx+1}: {question[:50]}...")

        # Invoke generateResponseLambda to get the actual response
        actual_response = invoke_generate_response_lambda(lambda_client, question)
        if not actual_response:
            logging.warning(f"Empty response received for question: {question[:50]}...")
            actual_response = "No response generated."

        # Get the context for evaluation
        retrieved_context = invoke_generate_response_lambda(lambda_client, question, get_context_only=True)

        # Evaluate the response using RAGAS
        logging.info(f"Evaluating response for test case {idx+1}")
        result = evaluate_with_ragas(question, expected_response, actual_response, retrieved_context)
        
        return {
            'question': question,
            'expectedResponse': expected_response,
            'actualResponse': actual_response,
            'similarity': result['scores']['similarity'],
            'relevance': result['scores']['relevance'],
            'correctness': result['scores']['correctness'],
            'context_precision': result['scores']['context_precision'],
            'context_recall': result['scores']['context_recall'],
            'response_relevancy': result['scores']['response_relevancy'],
            'faithfulness': result['scores']['faithfulness'],
            'retrieved_context': retrieved_context
        }
    except Exception as e:
        logging.error(f"Error in process_test_case for case {idx}: {str(e)}")
        raise

def invoke_generate_response_lambda(lambda_client, question, get_context_only=False):
    try:
        logging.info(f"Invoking generate-response Lambda for question: {question[:50]}...")
        
        # Call the generate-response Lambda function with authorization
        payload = {'userMessage': question, 'chatHistory': []}
        if get_context_only:
            payload['get_context_only'] = True
            
        response = lambda_client.invoke(
            FunctionName=GENERATE_RESPONSE_LAMBDA_NAME,
            InvocationType='RequestResponse',
            Payload=json.dumps(payload),
        )
        
        logging.info("Response received from Lambda")
        payload = response['Payload'].read().decode('utf-8')
        result = json.loads(payload)
        
        # Check if there's an error in the response
        if result.get('statusCode', 200) != 200:
            logging.error(f"Error response from Lambda: {result}")
            return ""
            
        body = json.loads(result.get('body', '{}'))
        
        if get_context_only:
            context = body.get('context', '')
            logging.info(f"Received context of length: {len(context)} characters")
            return context
        else:
            response_text = body.get('modelResponse', '')
            logging.info(f"Received response of length: {len(response_text)} characters")
            return response_text
    except Exception as e:
        logging.error(f"Error invoking generateResponseLambda: {str(e)}")
        return ""

def evaluate_with_ragas(question, expected_response, actual_response, retrieved_context):
    try:
        from datasets import Dataset
        from ragas import evaluate
        from ragas.metrics import answer_correctness, answer_similarity, answer_relevancy, context_precision, context_recall, faithfulness

        # Include all the metrics
        metrics = [answer_correctness, answer_similarity, answer_relevancy, context_precision, context_recall, faithfulness]
        
        # Prepare data for RAGAS
        data_sample = {
            "question": [question],
            "answer": [actual_response],
            "reference": [expected_response],
            "retrieved_contexts": [[retrieved_context]]
        }
        data_samples = Dataset.from_dict(data_sample)

        # Load LLM and embeddings with proper credentials
        bedrock_model = BedrockChat(
            endpoint_url="https://bedrock-runtime.us-east-1.amazonaws.com", 
            model_id=BEDROCK_MODEL_ID,
            model_kwargs={
                "max_tokens": 4096,  # Keeping hardcoded values as requested
                "temperature": 0.0,
                "top_p": 1.0
            }
        )
        bedrock_embeddings = BedrockEmbeddings(
            model_id='amazon.titan-embed-text-v1'
        )

        logging.info("Starting RAGAS evaluation")
        # Evaluate
        result = evaluate(data_samples, metrics=metrics, llm=bedrock_model, embeddings=bedrock_embeddings)
        scores = result.to_pandas().iloc[0]

        # Check for NaN scores and raise exception if found
        if scores.isnull().values.any():
            nan_metrics = [col for col in scores.index if pd.isna(scores[col])]
            error_msg = f"RAGAS evaluation returned NaN scores for: {', '.join(nan_metrics)}"
            logging.error(error_msg)
            raise ValueError(error_msg)
        
        logging.info("RAGAS evaluation completed successfully")
        return {
            "status": "success", 
            "scores": {
                "similarity": scores['semantic_similarity'], 
                "relevance": scores['answer_relevancy'], 
                "correctness": scores['answer_correctness'],
                "context_precision": scores.get('context_precision', 0),
                "context_recall": scores.get('context_recall', 0),
                "response_relevancy": scores.get('answer_relevancy', 0),
                "faithfulness": scores.get('faithfulness', 0)
            }
        }
    except Exception as e:
        logging.error(f"Error in RAGAS evaluation: {str(e)}")
        raise
    
def read_chunk_from_s3(s3_client, bucket_name, key):
    try:
        logging.info(f"Reading file from S3: {bucket_name}/{key}")
        response = s3_client.get_object(Bucket=bucket_name, Key=key)
        content = response['Body'].read().decode('utf-8')
        data = json.loads(content)
        logging.info(f"Successfully read file from S3, size: {len(content)} bytes")
        return data
    except Exception as e:
        logging.error(f"Error reading file from S3: {str(e)}")
        raise
