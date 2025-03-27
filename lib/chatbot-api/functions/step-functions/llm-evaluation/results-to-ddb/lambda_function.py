import os
import boto3
from botocore.exceptions import ClientError
import json
from datetime import datetime
from decimal import Decimal

# Retrieve DynamoDB table names from environment variables
EVALUATION_SUMMARIES_TABLE = os.environ.get("EVAL_SUMMARIES_TABLE")
EVALUATION_RESULTS_TABLE = os.environ.get("EVAL_RESULTS_TABLE")
TEST_CASES_BUCKET = os.environ["TEST_CASES_BUCKET"]
EVAL_RESULTS_BUCKET = os.environ.get("EVAL_RESULTS_BUCKET", TEST_CASES_BUCKET)  # Fallback to TEST_CASES_BUCKET if not set

# Initialize a DynamoDB resource using boto3
dynamodb = boto3.resource("dynamodb", region_name='us-east-1')

# Connect to the specified DynamoDB tables
summaries_table = dynamodb.Table(EVALUATION_SUMMARIES_TABLE)
results_table = dynamodb.Table(EVALUATION_RESULTS_TABLE)

def convert_from_decimal(item):
    if isinstance(item, list):
        return [convert_from_decimal(i) for i in item]
    elif isinstance(item, dict):
        return {k: convert_from_decimal(v) for k, v in item.items()}
    elif isinstance(item, Decimal):
        return float(item)  # Convert Decimal to float
    else:
        return item

# function to add a new evaluation (summary and detailed results) to DynamoDB
def add_evaluation(evaluation_id, evaluation_name, average_similarity,
                   average_relevance, average_correctness, total_questions, 
                   detailed_results, test_cases_key, 
                   average_context_precision=None, average_context_recall=None, 
                   average_response_relevancy=None, average_faithfulness=None):
    try:
        timestamp = str(datetime.now())
        # Add evaluation summary
        summary_item = {
            'EvaluationId': evaluation_id,
            'Timestamp': timestamp,
            'average_similarity': Decimal(str(average_similarity)),
            'average_relevance': Decimal(str(average_relevance)),
            'average_correctness': Decimal(str(average_correctness)),
            'total_questions': total_questions,
            'evaluation_name': evaluation_name.strip() if evaluation_name else None,
            'test_cases_key': test_cases_key,
            'PartitionKey': "Evaluation" 
        }
        
        # Add the RAG metrics if they exist
        if average_context_precision is not None:
            summary_item['average_context_precision'] = Decimal(str(average_context_precision))
        if average_context_recall is not None:
            summary_item['average_context_recall'] = Decimal(str(average_context_recall))
        if average_response_relevancy is not None:
            summary_item['average_response_relevancy'] = Decimal(str(average_response_relevancy))
        if average_faithfulness is not None:
            summary_item['average_faithfulness'] = Decimal(str(average_faithfulness))

        # Remove None values
        summary_item = {k: v for k, v in summary_item.items() if v is not None}

        summaries_table.put_item(Item=summary_item)

        # Add detailed results (batch write)
        with results_table.batch_writer() as batch:
            for idx, result in enumerate(detailed_results):
                result_item = {
                    'EvaluationId': evaluation_id,
                    'QuestionId': str(idx),
                    'question': result['question'],
                    'expected_response': result['expectedResponse'],
                    'actual_response': result['actualResponse'],
                    'similarity': Decimal(str(result['similarity'])),
                    'relevance': Decimal(str(result['relevance'])),
                    'correctness': Decimal(str(result['correctness'])),
                    'test_cases_key': test_cases_key
                }
                
                # Add RAG metrics if they exist in the detailed results
                if 'context_precision' in result:
                    result_item['context_precision'] = Decimal(str(result['context_precision']))
                if 'context_recall' in result:
                    result_item['context_recall'] = Decimal(str(result['context_recall']))
                if 'response_relevancy' in result:
                    result_item['response_relevancy'] = Decimal(str(result['response_relevancy']))
                if 'faithfulness' in result:
                    result_item['faithfulness'] = Decimal(str(result['faithfulness']))
                if 'retrieved_context' in result:
                    result_item['retrieved_context'] = result['retrieved_context']
                
                batch.put_item(Item=result_item)

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': 'https://dcf43zj2k8alr.cloudfront.net',
                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET',
                'Access-Control-Allow-Credentials': 'true'
            },
            'body': json.dumps({
                'message': 'Evaluation added successfully',
                'evaluation_id': evaluation_id
                })
        }
    except ClientError as error:
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': 'https://dcf43zj2k8alr.cloudfront.net',
                'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET',
                'Access-Control-Allow-Credentials': 'true'
            },
            'body': json.dumps(str(error))
        }
    
def read_detailed_results_from_s3(detailed_results_s3_key):
    try:
        s3_client = boto3.client('s3')
        # First try to read from the EVAL_RESULTS_BUCKET
        try:
            response = s3_client.get_object(Bucket=EVAL_RESULTS_BUCKET, Key=detailed_results_s3_key)
            content = response['Body'].read().decode('utf-8')
            return json.loads(content)
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchKey' and EVAL_RESULTS_BUCKET != TEST_CASES_BUCKET:
                # If the key doesn't exist in EVAL_RESULTS_BUCKET, try TEST_CASES_BUCKET as a fallback
                response = s3_client.get_object(Bucket=TEST_CASES_BUCKET, Key=detailed_results_s3_key)
                content = response['Body'].read().decode('utf-8')
                return json.loads(content)
            else:
                # Re-raise the error if it's not a NoSuchKey error
                raise
    except ClientError as e:
        error_code = e.response['Error']['Code']
        error_message = e.response['Error']['Message']
        raise Exception(f"Failed to read detailed results from S3: {error_code} - {error_message}. Primary bucket: {EVAL_RESULTS_BUCKET}, Key: {detailed_results_s3_key}")
    except json.JSONDecodeError as e:
        raise Exception(f"Failed to decode JSON from S3 object. Bucket: {EVAL_RESULTS_BUCKET}, Key: {detailed_results_s3_key}. Error: {str(e)}")
    
def lambda_handler(event, context):
    # Get headers from request or use default
    headers = {
        'Access-Control-Allow-Origin': '*',  # Updated to allow all origins for testing
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Methods': 'OPTIONS,POST,GET',
        'Access-Control-Allow-Credentials': 'true'
    }
    
    # Handle OPTIONS request if needed
    if event.get('httpMethod') == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps({'message': 'CORS preflight request successful'})
        }
    
    try:
        # Extract data from event
        if isinstance(event, dict) and 'body' in event and event['body']:
            data = json.loads(event['body']) if isinstance(event['body'], str) else event['body']
        else:
            data = event
        
        # Log received data
        print(f"Received data: {json.dumps(data)}")
            
        evaluation_id = data.get('evaluation_id')
        if not evaluation_id:
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({'message': 'Missing evaluation_id'})
            }
            
        # Check if we received an error status from previous step
        if data.get('statusCode') == 500:
            return {
                'statusCode': 500,
                'headers': headers,
                'body': json.dumps({
                    'message': 'Error received from previous step',
                    'error': data.get('error', 'Unknown error'),
                    'evaluation_id': evaluation_id
                })
            }
        
        evaluation_name = data.get('evaluation_name', f"Evaluation on {str(datetime.now())}")
        average_similarity = data.get('average_similarity', 0)
        average_relevance = data.get('average_relevance', 0)
        average_correctness = data.get('average_correctness', 0)
        detailed_results_s3_key = data.get('detailed_results_s3_key')
        total_questions = data.get('total_questions', 0)
        test_cases_key = data.get('test_cases_key')
        
        # Get RAG metrics if available
        average_context_precision = data.get('average_context_precision', 0)
        average_context_recall = data.get('average_context_recall', 0)
        average_response_relevancy = data.get('average_response_relevancy', 0)
        average_faithfulness = data.get('average_faithfulness', 0)

        # Validate required fields
        required_fields = [evaluation_id, detailed_results_s3_key, test_cases_key]
        if not all(required_fields):
            missing_fields = [field for field, value in {
                'evaluation_id': evaluation_id,
                'detailed_results_s3_key': detailed_results_s3_key,
                'test_cases_key': test_cases_key
            }.items() if not value]
            
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({
                    'message': 'Missing required parameters for adding evaluation',
                    'missing_fields': missing_fields
                })
            }
        
        try:
            # Read detailed results
            detailed_results = read_detailed_results_from_s3(detailed_results_s3_key)
            
            # Add evaluation to DynamoDB
            response = add_evaluation(
                evaluation_id,
                evaluation_name,
                average_similarity,
                average_relevance,
                average_correctness,
                total_questions,
                detailed_results, 
                test_cases_key,
                average_context_precision,
                average_context_recall,
                average_response_relevancy,
                average_faithfulness
            )
            
            return response
        except Exception as e:
            print(f"Error processing evaluation results: {str(e)}")
            return {
                'statusCode': 500,
                'headers': headers,
                'body': json.dumps({
                    'message': 'Failed to process evaluation results',
                    'error': str(e),
                    'evaluation_id': evaluation_id,
                    'detailed_results_s3_key': detailed_results_s3_key,
                    'results_bucket': EVAL_RESULTS_BUCKET,
                    'test_cases_bucket': TEST_CASES_BUCKET
                })
            }
    except Exception as e:
        print(f"Unhandled exception in lambda_handler: {str(e)}")
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({
                'message': 'Unhandled exception in lambda handler',
                'error': str(e)
            })
        }
