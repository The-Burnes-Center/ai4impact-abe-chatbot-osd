import boto3
import os
import json
import logging
import uuid
import time
import websocket
import requests
import numpy as np
from datetime import datetime
from botocore.exceptions import ClientError
from nltk.tokenize import sent_tokenize
from sklearn.metrics.pairwise import cosine_similarity
from sentence_transformers import SentenceTransformer

# Environment variables
TEST_CASES_BUCKET = os.environ['TEST_CASES_BUCKET']
EVAL_RESULTS_BUCKET = os.environ.get('EVAL_RESULTS_BUCKET', TEST_CASES_BUCKET)  # Fallback to TEST_CASES_BUCKET if not set
WEBSOCKET_ENDPOINT = os.environ.get('WEBSOCKET_ENDPOINT', '')
COGNITO_USER_POOL_ID = os.environ.get('COGNITO_USER_POOL_ID', '')
COGNITO_CLIENT_ID = os.environ.get('COGNITO_CLIENT_ID', '')
COGNITO_USERNAME = os.environ.get('COGNITO_USERNAME', '')
COGNITO_PASSWORD = os.environ.get('COGNITO_PASSWORD', '')

# Initialize clients
s3_client = boto3.client('s3')
# Initialize sentence transformer model for semantic similarity
model = None  # Will be lazily loaded when needed

def lambda_handler(event, context):
    # Configure logging
    logging.basicConfig(level=logging.INFO)
    logging.info(f"Lambda invoked with event: {json.dumps(event)}")
    
    try:
        # Extract partial result keys - handle both array of strings and array of objects
        partial_result_keys = []
        for pr in event.get('partial_result_keys', []):
            if isinstance(pr, dict) and 'partial_result_key' in pr:
                partial_result_keys.append(pr['partial_result_key'])
            else:
                partial_result_keys.append(pr)
                
        evaluation_id = event['evaluation_id']
        test_cases_key = event['test_cases_key']
        evaluation_name = event.get('evaluation_name', f"Evaluation on {str(datetime.now())}")
        
        # Determine if we should perform live evaluation with the chatbot
        perform_live_evaluation = event.get('perform_live_evaluation', False)
        
        # Check for retrieval-based evaluation flag
        perform_retrieval_evaluation = event.get('perform_retrieval_evaluation', False)
        
        logging.info(f"Processing {len(partial_result_keys)} partial results for evaluation {evaluation_id}")
        
        # If either live or retrieval evaluation is requested, we'll need to query the chatbot
        need_chatbot_query = perform_live_evaluation or perform_retrieval_evaluation
        
        # Load test cases if we need to query the chatbot
        test_cases = []
        chatbot_config = {}
        
        if need_chatbot_query:
            # Load test cases
            test_cases = load_test_cases_from_s3(test_cases_key)
            
            # Configure chatbot client
            chatbot_config = {
                'ws_endpoint': WEBSOCKET_ENDPOINT,
                'cognito_user_pool_id': COGNITO_USER_POOL_ID,
                'cognito_client_id': COGNITO_CLIENT_ID,
                'username': COGNITO_USERNAME,
                'password': COGNITO_PASSWORD
            }
            
            # Validate chatbot configuration
            if not all([chatbot_config['ws_endpoint'], chatbot_config['cognito_user_pool_id'], 
                       chatbot_config['cognito_client_id'], chatbot_config['username'], 
                       chatbot_config['password']]):
                logging.warning("Missing required chatbot configuration. Skipping live evaluation.")
                perform_live_evaluation = False
                perform_retrieval_evaluation = False
                need_chatbot_query = False

        # Initialize accumulators for standard metrics
        total_similarity = 0
        total_relevance = 0
        total_correctness = 0
        total_questions = 0
        detailed_results = []
        
        # Initialize accumulators for retrieval-based metrics
        total_context_precision = 0  # How precise/relevant the retrieved context is to the question
        total_context_recall = 0     # How well the retrieved context covers the reference answer
        total_response_relevancy = 0 # How relevant the response is to the question
        total_faithfulness = 0       # How faithful/grounded the response is to the retrieved context
        
        # First, read partial results from S3 to get existing evaluations
        for partial_result_key in partial_result_keys:
            try:
                partial_result = read_partial_result_from_s3(s3_client, TEST_CASES_BUCKET, partial_result_key)
                
                # Only add standard metrics from partial results if we're not doing live evaluation
                if not perform_live_evaluation:
                    total_similarity += partial_result['total_similarity']
                    total_relevance += partial_result['total_relevance']
                    total_correctness += partial_result['total_correctness']
                
                total_questions += partial_result['num_test_cases']
                detailed_results.extend(partial_result['detailed_results'])
                
                # Add retrieval metrics if they exist and we're not doing retrieval evaluation
                if not perform_retrieval_evaluation:
                    if 'total_context_precision' in partial_result:
                        total_context_precision += partial_result.get('total_context_precision', 0)
                    if 'total_context_recall' in partial_result:
                        total_context_recall += partial_result.get('total_context_recall', 0)
                    if 'total_response_relevancy' in partial_result:
                        total_response_relevancy += partial_result.get('total_response_relevancy', 0)
                    if 'total_faithfulness' in partial_result:
                        total_faithfulness += partial_result.get('total_faithfulness', 0)
                
            except Exception as e:
                logging.error(f"Error processing partial result {partial_result_key}: {str(e)}")
                # Continue with other partial results even if one fails
        
        # If we need to query the chatbot (live or retrieval evaluation)
        if need_chatbot_query and test_cases:
            logging.info(f"Performing live evaluation with chatbot on {len(test_cases)} test cases")
            
            # Reset totals if we're doing live evaluation
            if perform_live_evaluation:
                total_similarity = 0
                total_relevance = 0
                total_correctness = 0
            
            # Reset retrieval metrics if we're doing retrieval evaluation
            if perform_retrieval_evaluation:
                total_context_precision = 0
                total_context_recall = 0
                total_response_relevancy = 0
                total_faithfulness = 0
            
            # Process each test case
            for test_case in test_cases:
                try:
                    # Query the chatbot with the test question
                    query_result = query_chatbot_with_chunks(
                        query=test_case['question'],
                        config=chatbot_config
                    )
                    
                    # Get the response and sources
                    response = query_result['response']
                    sources = query_result['sources']
                    
                    # Extract text from sources to create context
                    context_text = "\n".join([source.get('title', '') for source in sources])
                    
                    # Find the matching result in detailed_results
                    matching_result = next((r for r in detailed_results if r['question'] == test_case['question']), None)
                    
                    # If we're doing live evaluation, calculate standard metrics
                    if perform_live_evaluation and matching_result:
                        # Update the chatbot response in the detailed results
                        matching_result['chatbot_response'] = response
                        
                        # Calculate standard metrics
                        similarity = calculate_similarity(response, test_case.get('reference_answer', ''))
                        relevance = calculate_relevance(test_case['question'], response)
                        correctness = calculate_correctness(response, test_case.get('reference_answer', ''))
                        
                        # Update detailed results
                        matching_result['similarity'] = similarity
                        matching_result['relevance'] = relevance
                        matching_result['correctness'] = correctness
                        
                        # Add to totals
                        total_similarity += similarity
                        total_relevance += relevance
                        total_correctness += correctness
                    
                    # If we're doing retrieval evaluation, calculate retrieval metrics
                    if perform_retrieval_evaluation and matching_result:
                        # Calculate RAG evaluation metrics
                        context_precision = calculate_context_precision(test_case['question'], context_text)
                        context_recall = calculate_context_recall(test_case.get('reference_answer', ''), context_text)
                        response_relevancy = calculate_response_relevancy(test_case['question'], response)
                        faithfulness = calculate_faithfulness(response, context_text)
                        
                        # Update detailed results
                        matching_result['context_precision'] = context_precision
                        matching_result['context_recall'] = context_recall
                        matching_result['response_relevancy'] = response_relevancy
                        matching_result['faithfulness'] = faithfulness
                        matching_result['retrieved_context'] = context_text
                        if 'chatbot_response' not in matching_result:
                            matching_result['chatbot_response'] = response
                        
                        # Add to totals
                        total_context_precision += context_precision
                        total_context_recall += context_recall
                        total_response_relevancy += response_relevancy
                        total_faithfulness += faithfulness
                
                except Exception as e:
                    logging.error(f"Error evaluating test case {test_case['question']}: {str(e)}")
                    # Continue with other test cases even if one fails
        
        # Compute averages for standard metrics
        average_similarity = total_similarity / total_questions if total_questions > 0 else 0
        average_relevance = total_relevance / total_questions if total_questions > 0 else 0
        average_correctness = total_correctness / total_questions if total_questions > 0 else 0
        
        # Compute averages for retrieval metrics
        average_context_precision = total_context_precision / total_questions if total_questions > 0 else 0
        average_context_recall = total_context_recall / total_questions if total_questions > 0 else 0
        average_response_relevancy = total_response_relevancy / total_questions if total_questions > 0 else 0
        average_faithfulness = total_faithfulness / total_questions if total_questions > 0 else 0

        # Write aggregated detailed results to S3 in the EVAL_RESULTS_BUCKET
        detailed_results_s3_key = f'evaluations/{evaluation_id}/aggregated_results/detailed_results.json'
        try:
            s3_client.put_object(
                Bucket=EVAL_RESULTS_BUCKET,
                Key=detailed_results_s3_key,
                Body=json.dumps(detailed_results)
            )
            logging.info(f"Successfully wrote aggregated results to S3: {EVAL_RESULTS_BUCKET}/{detailed_results_s3_key}")
        except Exception as e:
            logging.error(f"Error writing aggregated results to S3: {str(e)}")
            raise

        # Return aggregated results including both standard and retrieval metrics
        result = {
            'evaluation_id': evaluation_id, 
            'evaluation_name': evaluation_name,
            'average_similarity': round(average_similarity, 4),
            'average_relevance': round(average_relevance, 4),
            'average_correctness': round(average_correctness, 4),
            'total_questions': total_questions,
            'detailed_results_s3_key': detailed_results_s3_key,
            'test_cases_key': test_cases_key
        }
        
        # Add retrieval metrics 
        result.update({
            'average_context_precision': round(average_context_precision, 4),
            'average_context_recall': round(average_context_recall, 4),
            'average_response_relevancy': round(average_response_relevancy, 4),
            'average_faithfulness': round(average_faithfulness, 4)
        })
        
        logging.info(f"Aggregation complete for evaluation {evaluation_id}. Results: {json.dumps(result)}")
        
        return result
    except Exception as e:
        error_msg = f"Unhandled exception in lambda_handler: {str(e)}"
        logging.error(error_msg)
        
        # Return a structured error that preserves the evaluation ID
        return {
            'statusCode': 500,
            'evaluation_id': event.get('evaluation_id', 'unknown'),
            'error': str(e)
        }

def read_partial_result_from_s3(s3_client, bucket_name, key):
    try:
        response = s3_client.get_object(Bucket=bucket_name, Key=key)
        content = response['Body'].read().decode('utf-8')
        return json.loads(content)
    except ClientError as e:
        error_code = e.response['Error']['Code']
        error_message = e.response['Error']['Message']
        raise Exception(f"Failed to read partial result from S3: {error_code} - {error_message}. Bucket: {bucket_name}, Key: {key}")
    except json.JSONDecodeError as e:
        raise Exception(f"Failed to decode JSON from S3 object. Bucket: {bucket_name}, Key: {key}. Error: {str(e)}")

def load_test_cases_from_s3(test_cases_key):
    """Load test cases from S3"""
    try:
        response = s3_client.get_object(Bucket=TEST_CASES_BUCKET, Key=test_cases_key)
        content = response['Body'].read().decode('utf-8')
        return json.loads(content)
    except Exception as e:
        logging.error(f"Error loading test cases from S3: {str(e)}")
        raise Exception(f"Failed to load test cases from S3: {str(e)}")

def get_sentence_transformer_model():
    """Lazily load the sentence transformer model"""
    global model
    if model is None:
        # Use a smaller model suitable for Lambda
        model = SentenceTransformer('all-MiniLM-L6-v2')
    return model

def calculate_similarity(response, reference_answer):
    """Calculate similarity between response and reference answer"""
    if not response or not reference_answer:
        return 0.0
        
    model = get_sentence_transformer_model()
    
    # Get embeddings for the full texts
    response_embedding = model.encode([response])
    reference_embedding = model.encode([reference_answer])
    
    # Calculate cosine similarity
    similarity = cosine_similarity(response_embedding, reference_embedding)[0][0]
    
    return float(similarity)

def calculate_relevance(question, response):
    """Calculate relevance of response to the question"""
    # This is the same as response_relevancy
    return calculate_response_relevancy(question, response)

def calculate_correctness(response, reference_answer):
    """
    Calculate correctness as a combination of factual accuracy and completeness
    This is a more comprehensive metric than just similarity
    """
    if not response or not reference_answer:
        return 0.0
        
    model = get_sentence_transformer_model()
    
    # Split into sentences for more granular comparison
    response_sentences = sent_tokenize(response)
    reference_sentences = sent_tokenize(reference_answer)
    
    if not response_sentences or not reference_sentences:
        return 0.0
    
    # Encode sentences
    response_embeddings = model.encode(response_sentences)
    reference_embeddings = model.encode(reference_sentences)
    
    # Calculate best matching reference sentence for each response sentence
    response_to_reference_scores = []
    for resp_emb in response_embeddings:
        similarities = cosine_similarity([resp_emb], reference_embeddings)[0]
        response_to_reference_scores.append(np.max(similarities))
    
    # Calculate best matching response sentence for each reference sentence
    reference_to_response_scores = []
    for ref_emb in reference_embeddings:
        similarities = cosine_similarity([ref_emb], response_embeddings)[0]
        reference_to_response_scores.append(np.max(similarities))
    
    # Average the precision (response_to_reference) and recall (reference_to_response)
    precision = np.mean(response_to_reference_scores) if response_to_reference_scores else 0
    recall = np.mean(reference_to_response_scores) if reference_to_response_scores else 0
    
    # F1-score as harmonic mean of precision and recall
    if precision + recall > 0:
        correctness = 2 * precision * recall / (precision + recall)
    else:
        correctness = 0.0
    
    return float(correctness)

def calculate_context_precision(question, context):
    """
    Calculate Context Precision: How relevant/precise the retrieved context is to the question.
    Measures if the retrieved chunks are focused and relevant to what was asked.
    """
    if not context:
        return 0.0
        
    model = get_sentence_transformer_model()
    question_embedding = model.encode([question])
    context_sentences = sent_tokenize(context)
    
    if not context_sentences:
        return 0.0
        
    context_embeddings = model.encode(context_sentences)
    
    # Calculate cosine similarity between question and each context sentence
    similarities = cosine_similarity(question_embedding, context_embeddings)[0]
    
    # Return the average of top 3 similarities or all if less than 3
    top_k = min(3, len(similarities))
    return float(np.mean(sorted(similarities, reverse=True)[:top_k]))

def calculate_context_recall(reference_answer, context):
    """
    Calculate Context Recall: How well the retrieved context covers the information 
    needed to answer correctly (based on reference answer).
    Measures if all the necessary information was retrieved.
    """
    if not context or not reference_answer:
        return 0.0
        
    model = get_sentence_transformer_model()
    
    # Split reference answer into sentences
    ref_sentences = sent_tokenize(reference_answer)
    context_sentences = sent_tokenize(context)
    
    if not ref_sentences or not context_sentences:
        return 0.0
    
    # Encode sentences
    ref_embeddings = model.encode(ref_sentences)
    context_embeddings = model.encode(context_sentences)
    
    # Calculate max similarity for each reference sentence with any context sentence
    max_similarities = []
    for ref_emb in ref_embeddings:
        similarities = cosine_similarity([ref_emb], context_embeddings)[0]
        max_similarities.append(np.max(similarities))
    
    # Calculate recall as average of max similarities
    return float(np.mean(max_similarities))

def calculate_response_relevancy(question, response):
    """
    Calculate Response Relevancy: How relevant the response is to the original question.
    Measures if the response addresses what was asked.
    """
    if not response or not question:
        return 0.0
        
    model = get_sentence_transformer_model()
    
    # Get embeddings for the question and response
    question_embedding = model.encode([question])
    response_embedding = model.encode([response])
    
    # Calculate cosine similarity
    similarity = cosine_similarity(question_embedding, response_embedding)[0][0]
    
    return float(similarity)

def calculate_faithfulness(response, context):
    """
    Calculate Faithfulness: How faithful/grounded the response is to the retrieved context.
    Measures if the response contains only information from the context without hallucination.
    """
    if not response or not context:
        return 0.0
        
    model = get_sentence_transformer_model()
    
    # Split response into sentences
    response_sentences = sent_tokenize(response)
    context_sentences = sent_tokenize(context)
    
    if not response_sentences or not context_sentences:
        return 0.0
    
    # Encode sentences
    response_embeddings = model.encode(response_sentences)
    context_embeddings = model.encode(context_sentences)
    
    # Calculate max similarity for each response sentence with any context sentence
    # This checks if each part of the response is grounded in the context
    sentence_scores = []
    for resp_emb in response_embeddings:
        similarities = cosine_similarity([resp_emb], context_embeddings)[0]
        sentence_scores.append(np.max(similarities))
    
    # Calculate faithfulness as average of sentence scores
    # A high score means most response sentences are closely tied to context (faithful)
    return float(np.mean(sentence_scores))

def query_chatbot_with_chunks(query, config=None, chat_history=None, retrieval_source="all"):
    if config is None:
        config = {}
    
    region = config.get('region', 'us-east-1')
    ws_endpoint = config.get('ws_endpoint')
    cognito_user_pool_id = config.get('cognito_user_pool_id')
    cognito_client_id = config.get('cognito_client_id')
    username = config.get('username')
    password = config.get('password')
    
    logging.info(f"WebSocket endpoint: {ws_endpoint}")
    
    # Validate required configuration
    if not all([ws_endpoint, cognito_user_pool_id, cognito_client_id, username, password]):
        error_msg = "Missing required configuration parameters for WebSocket"
        logging.error(error_msg)
        raise ValueError(error_msg)
    
    # Initialize chat history if None
    if chat_history is None:
        chat_history = []
    
    # Set up session ID
    session_id = str(uuid.uuid4())
    
    # Authenticate with Cognito
    logging.info("Authenticating with Cognito")
    cognito_client = boto3.client('cognito-idp', region_name=region)
    try:
        auth_response = cognito_client.initiate_auth(
            AuthFlow='USER_PASSWORD_AUTH',
            ClientId=cognito_client_id,
            AuthParameters={
                'USERNAME': username,
                'PASSWORD': password
            }
        )
        token = auth_response['AuthenticationResult']['IdToken']
        logging.info("Authentication successful")
    except Exception as e:
        error_msg = f"Authentication failed: {str(e)}"
        logging.error(error_msg)
        raise Exception(error_msg)
    
    # Connect to WebSocket API
    ws_url = f"{ws_endpoint}?Authorization={token}"
    logging.info(f"Connecting to WebSocket: {ws_url[:50]}...")
    
    # Set up result variables
    response_text = ""
    sources = []
    is_metadata = False
    connection_success = False
    ws_error = None
    ws_closed = False
    
    # Define WebSocket callbacks
    def on_message(ws, message):
        nonlocal response_text, sources, is_metadata, connection_success, ws_error
        
        try:
            # Connection is successful if we get a message
            connection_success = True
            
            # Log message receipt (truncated for large messages)
            if len(message) > 100:
                logging.info(f"Received message: {message[:100]}...")
            else:
                logging.info(f"Received message: {message}")
            
            # Check for error message
            if "<!ERROR!>:" in message:
                ws_error = message.replace("<!ERROR!>:", "")
                logging.error(f"WebSocket error message: {ws_error}")
                ws.close()
                return
            
            # Check for end of response marker
            if message == "!<|EOF_STREAM|>!":
                logging.info("End of response stream received")
                is_metadata = True
                return
            
            if not is_metadata:
                # This is the chatbot's response text
                response_text += message
            else:
                # This is the source/chunks metadata
                try:
                    source_data = json.loads(message)
                    logging.info(f"Received sources data with {len(source_data)} items")
                    
                    # Process and clean up source data
                    processed_sources = []
                    for item in source_data:
                        if item.get("title") == "":
                            uri = item.get("uri", "")
                            title = uri.split("/")[-1] if uri else ""
                            processed_sources.append({
                                "title": title,
                                "uri": uri
                            })
                        else:
                            processed_sources.append(item)
                    sources = processed_sources
                    # Close the connection once we have the sources
                    ws.close()
                except json.JSONDecodeError as e:
                    error_msg = f"Failed to parse source data: {str(e)}"
                    logging.error(error_msg)
                    ws_error = error_msg
                    ws.close()
                except Exception as e:
                    error_msg = f"Error processing source data: {str(e)}"
                    logging.error(error_msg)
                    ws_error = error_msg
                    ws.close()
        except Exception as e:
            error_msg = f"Error in on_message handler: {str(e)}"
            logging.error(error_msg)
            ws_error = error_msg
            ws.close()
    
    def on_error(ws, error):
        nonlocal ws_error
        ws_error = str(error)
        logging.error(f"WebSocket error: {ws_error}")
        ws.close()
    
    def on_close(ws, close_status_code, close_reason):
        nonlocal ws_closed
        ws_closed = True
        logging.info(f"WebSocket connection closed: {close_status_code} - {close_reason}")
    
    def on_open(ws):
        nonlocal connection_success, ws_error
        connection_success = True
        logging.info("WebSocket connection opened, sending message")
        
        try:
            # Format the request
            message = json.dumps({
                "action": "getChatbotResponse",
                "data": {
                    "userMessage": query,
                    "session_id": session_id,
                    "user_id": username,
                    "chatHistory": chat_history,
                    "retrievalSource": retrieval_source
                }
            })
            logging.info(f"Sending message: {message[:100]}...")
            ws.send(message)
            logging.info("Message sent successfully")
        except Exception as e:
            error_msg = f"Error sending message: {str(e)}"
            logging.error(error_msg)
            ws_error = error_msg
            ws.close()
    
    # Create and connect WebSocket
    websocket.enableTrace(False)
    ws = websocket.WebSocketApp(
        ws_url,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close
    )
    
    # Set up timeout
    timeout = 60  # 60 seconds timeout
    
    # Run the WebSocket connection in a separate thread
    import threading
    def run_ws():
        nonlocal ws_error
        try:
            ws.run_forever()
        except Exception as e:
            ws_error = f"WebSocket run_forever error: {str(e)}"
            logging.error(ws_error)
    
    ws_thread = threading.Thread(target=run_ws)
    ws_thread.daemon = True
    
    try:
        logging.info("Starting WebSocket thread")
        ws_thread.start()
        
        # Wait for timeout or completion
        start_time = time.time()
        connection_timeout = 5  # 5 seconds to establish connection
        
        # First wait for connection to be established
        while time.time() - start_time < connection_timeout and not connection_success and not ws_error:
            time.sleep(0.1)
        
        if not connection_success and not ws_error:
            ws_error = "Failed to establish WebSocket connection within timeout"
            logging.error(ws_error)
            ws.close()
        
        # Then wait for response or timeout
        while time.time() - start_time < timeout and not ws_closed and not ws_error:
            time.sleep(0.1)
        
        # If timeout occurs but connection is still open
        if not ws_closed and not ws_error:
            ws_error = "Request timed out waiting for response"
            logging.error(ws_error)
            ws.close()
        
        # Wait for thread to finish
        ws_thread.join(timeout=5)
        
        # Check for errors
        if ws_error:
            raise Exception(f"WebSocket error: {ws_error}")
        
        # Check if we got a response
        if not response_text:
            raise Exception("No response received from chatbot")
        
        logging.info(f"Successfully received response of length {len(response_text)} and {len(sources)} sources")
        
        # Return the results
        return {
            "response": response_text,
            "sources": sources
        }
    except Exception as e:
        logging.error(f"Error in WebSocket request: {str(e)}")
        # Try to close the connection if still open
        try:
            if not ws_closed and ws.sock and ws.sock.connected:
                ws.close()
        except:
            pass
        
        # Wait for thread to finish if it's still running
        try:
            if ws_thread.is_alive():
                ws_thread.join(timeout=2)
        except:
            pass
        
        raise Exception(f"WebSocket request failed: {str(e)}")

# Example usage:
# config = {
#     'ws_endpoint': 'wss://abcdefghij.execute-api.us-east-1.amazonaws.com/prod',
#     'cognito_user_pool_id': 'us-east-1_aBcDeFgHi',
#     'cognito_client_id': '1a2b3c4d5e6f7g8h9i0j',
#     'username': 'test-user',
#     'password': 'test-password',
#     'region': 'us-east-1'
# }
# 
# result = query_chatbot_with_chunks(
#     query="What are the procurement guidelines for laptops?",
#     config=config
# )
# print("Response:", result["response"])
# print("Sources:", result["sources"])
