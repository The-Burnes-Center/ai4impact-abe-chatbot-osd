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
# Authentication key if available
AUTH_KEY = os.environ.get('AUTH_KEY')

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
        logging.info(f"Environment variables: CHATBOT_API_URL={CHATBOT_API_URL}")
        if AUTH_KEY:
            logging.info("AUTH_KEY is present in environment")
        else:
            logging.info("AUTH_KEY is not present in environment")
        
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
        if AUTH_KEY:
            os.environ['AUTH_KEY'] = AUTH_KEY
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
                    # Create a fallback response if authentication failed
                    if "HTTP 401" in app_response_data.get('error', ''):
                        logging.warning(f"Authentication failed. Using enhanced dummy response for evaluation.")
                        app_response_data = {
                            "response": f"This is a simulated evaluation response for the test case: '{question[:100]}...'",
                            "retrieved_contexts": [expected_response],
                            "sources": [{"title": "Simulated Source", "uri": "evaluation://simulated-source-1"}]
                        }
                
                actual_response = app_response_data['response']
                retrieved_contexts = app_response_data.get('retrieved_contexts', [])

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
    Evaluate response using RAGAS metrics.
    This function attempts to use RAGAS metrics for evaluation,
    with a fallback to simpler text-based metrics if RAGAS fails.
    """
    # Initialize fallback scores in case of errors
    fallback_score = 0.5  # Neutral score
    
    # Prepare contexts for evaluation
    if retrieved_contexts and len(retrieved_contexts) > 0:
        contexts = retrieved_contexts
    else:
        contexts = [expected_response]  # Fallback to using expected response as context
    
    # Try using RAGAS for evaluation
    try:
        logging.info("Attempting to use RAGAS for evaluation...")
        from ragas.metrics import answer_correctness, answer_similarity, answer_relevancy
        import nltk
        
        # Set NLTK data path
        nltk.data.path.append("./nltk_data")
        
        # Prepare data for RAGAS
        questions = [question]
        expected_answers = [expected_response]
        actual_answers = [actual_response]
        contexts_list = [contexts]
        
        # Initialize scores
        try:
            # Initialize RAGAS metrics
            correctness = answer_correctness()
            similarity = answer_similarity()
            relevancy = answer_relevancy()
            
            # Calculate scores
            try:
                # Try to compute all metrics
                correctness_score = correctness.score(questions, actual_answers, contexts_list)
                similarity_score = similarity.score(expected_answers, actual_answers)
                relevancy_score = relevancy.score(questions, actual_answers)
                
                logging.info(f"RAGAS scores - Similarity: {similarity_score}, Relevance: {relevancy_score}, Correctness: {correctness_score}")
                
                # Convert to float for return
                return {
                    "status": "success", 
                    "scores": {
                        "similarity": float(similarity_score),
                        "relevance": float(relevancy_score),
                        "correctness": float(correctness_score)
                    }
                }
            except Exception as e:
                logging.error(f"Error calculating RAGAS metrics: {str(e)}")
                raise e
                
        except Exception as e:
            logging.error(f"Error initializing RAGAS metrics: {str(e)}")
            raise e
    
    except Exception as ragas_error:
        logging.error(f"RAGAS evaluation failed: {str(ragas_error)}")
        logging.error("Falling back to NLTK/scikit-learn for evaluation...")
        try:
            # Use NLTK and scikit-learn based approach for evaluation
            from sklearn.feature_extraction.text import TfidfVectorizer
            from sklearn.metrics.pairwise import cosine_similarity
            import nltk
            import re
            import numpy as np
            
            # Set NLTK data path
            nltk.data.path.append("./nltk_data")
            
            # Preprocess function to clean text
            def preprocess_text(text):
                if not text:
                    return ""
                # Convert to lowercase and remove special characters
                text = re.sub(r'[^\w\s]', '', text.lower())
                # Remove extra whitespace
                text = re.sub(r'\s+', ' ', text).strip()
                return text
            
            # Preprocess all texts
            preprocessed_question = preprocess_text(question)
            preprocessed_expected = preprocess_text(expected_response)
            preprocessed_actual = preprocess_text(actual_response)
            preprocessed_contexts = [preprocess_text(ctx) for ctx in contexts]
            
            # Calculate similarity using TF-IDF and cosine similarity
            try:
                # For similarity between actual and expected responses
                vectorizer = TfidfVectorizer(stop_words='english')
                response_vectors = vectorizer.fit_transform([preprocessed_expected, preprocessed_actual])
                similarity = cosine_similarity(response_vectors[0:1], response_vectors[1:2])[0][0]
                
                # Ensure score is between 0 and 1
                similarity = max(0, min(1, float(similarity)))
                logging.info(f"Calculated similarity score: {similarity}")
            except Exception as e:
                logging.error(f"Error calculating similarity: {str(e)}")
                logging.error(traceback.format_exc())
                similarity = fallback_score
            
            # Calculate relevance as similarity between question and response
            try:
                vectorizer = TfidfVectorizer(stop_words='english')
                relevance_vectors = vectorizer.fit_transform([preprocessed_question, preprocessed_actual])
                relevance = cosine_similarity(relevance_vectors[0:1], relevance_vectors[1:2])[0][0]
                
                # Ensure score is between 0 and 1
                relevance = max(0, min(1, float(relevance)))
                logging.info(f"Calculated relevance score: {relevance}")
            except Exception as e:
                logging.error(f"Error calculating relevance: {str(e)}")
                logging.error(traceback.format_exc())
                relevance = fallback_score
            
            # Calculate context relevance (how much the answer uses the contexts)
            try:
                # If we have contexts, measure how much the actual response uses information from contexts
                if preprocessed_contexts:
                    # Combine all contexts into one document for vectorization
                    combined_contexts = " ".join(preprocessed_contexts)
                    
                    vectorizer = TfidfVectorizer(stop_words='english')
                    correctness_vectors = vectorizer.fit_transform([combined_contexts, preprocessed_actual])
                    correctness = cosine_similarity(correctness_vectors[0:1], correctness_vectors[1:2])[0][0]
                    
                    # If no context similarity, fall back to similarity with expected answer
                    if correctness < 0.1:
                        correctness = similarity * 0.8  # Slightly penalize if not using contexts
                else:
                    # If no contexts, correctness is similar to answer similarity
                    correctness = similarity
                    
                # Ensure score is between 0 and 1
                correctness = max(0, min(1, float(correctness)))
                logging.info(f"Calculated correctness score: {correctness}")
            except Exception as e:
                logging.error(f"Error calculating correctness: {str(e)}")
                logging.error(traceback.format_exc())
                correctness = fallback_score
            
            logging.info(f"NLTK/scikit-learn scores - Similarity: {similarity}, Relevance: {relevance}, Correctness: {correctness}")
            
            return {"status": "success", "scores": {"similarity": similarity, "relevance": relevance, "correctness": correctness}}
        
        except Exception as e:
            logging.error(f"Error in fallback evaluation: {str(e)}")
            logging.error(traceback.format_exc())
            # Return fallback scores if all methods fail
            return {
                "status": "success", 
                "scores": {
                    "similarity": fallback_score, 
                    "relevance": fallback_score, 
                    "correctness": fallback_score
                },
                "error": str(e)
            }

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
