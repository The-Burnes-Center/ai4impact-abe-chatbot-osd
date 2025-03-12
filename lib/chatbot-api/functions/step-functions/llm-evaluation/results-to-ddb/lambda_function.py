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
                   average_relevance, average_correctness, total_questions, detailed_results, test_cases_key):
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
        'Access-Control-Allow-Origin': 'https://dcf43zj2k8alr.cloudfront.net',
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
        
    data = json.loads(event['body']) if 'body' in event else event
    evaluation_id = data.get('evaluation_id')
    evaluation_name = data.get('evaluation_name', f"Evaluation on {str(datetime.now())}")
    average_similarity = data.get('average_similarity')
    average_relevance = data.get('average_relevance')
    average_correctness = data.get('average_correctness')
    detailed_results_s3_key = data.get('detailed_results_s3_key')
    total_questions = data.get('total_questions')
    test_cases_key = data.get('test_cases_key')

    vals = [average_similarity, average_relevance, average_correctness, total_questions, detailed_results_s3_key, test_cases_key] 
    flags = [elem if elem != 0 else 1 for elem in vals]
    if not all(flags):        
        return {
            'statusCode': 400,
            'headers': headers,
            'body': json.dumps('Missing required parameters for adding evaluation.')
        }
    
    try:
        detailed_results = read_detailed_results_from_s3(detailed_results_s3_key)
        return add_evaluation(
            evaluation_id,
            evaluation_name,
            average_similarity,
            average_relevance,
            average_correctness,
            total_questions,
            detailed_results, 
            test_cases_key
        )
    except Exception as e:
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
