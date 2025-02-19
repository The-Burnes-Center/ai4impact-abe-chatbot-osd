import boto3
import csv
import io
import os
import uuid
import json
from datetime import datetime

TEST_CASE_BUCKET = os.environ['TEST_CASES_BUCKET']

def lambda_handler(event, context):
    s3_client = boto3.client('s3')
    test_cases_key = event.get('testCasesKey')
    if not test_cases_key:
        raise ValueError("testCasesKey parameter is required in the event.")
    
    print("event: ", event)
    eval_name = event.get('evalName')
    print("eval_name: ", eval_name)
    if not eval_name:
        eval_name = f"Evaluation on {str(datetime.now())}"

    eval_id = str(uuid.uuid4())
    
    # Read test cases from S3 
    test_cases = read_test_cases_from_s3(s3_client, TEST_CASE_BUCKET, test_cases_key)
    
    # Split into chunks
    chunk_size = 15  # Adjust based on testing
    chunks = [test_cases[i:i + chunk_size] for i in range(0, len(test_cases), chunk_size)]
    chunk_infos = save_chunks_to_s3(s3_client, eval_id, chunks)
     
    return {
        'chunk_keys': chunk_infos,
        'evaluation_id': eval_id,
        'evaluation_name': eval_name,
        'test_cases_key': test_cases_key
    }

def read_test_cases_from_s3(s3_client, bucket_name, key):
    response = s3_client.get_object(Bucket=bucket_name, Key=key)
    content = response['Body'].read().decode('utf-8-sig')
    test_cases = []
    reader = csv.DictReader(io.StringIO(content))
    for row in reader:
        test_cases.append({
            'question': row['question'],
            'expectedResponse': row['expectedResponse'],
        })
    return test_cases

def save_chunks_to_s3(s3_client, evaluation_id, chunks):
    chunk_infos = []
    for idx, chunk in enumerate(chunks):
        chunk_key = f"evaluations/{evaluation_id}/chunks/chunk_{idx}.json"
        s3_client.put_object(
            Bucket=TEST_CASE_BUCKET,
            Key=chunk_key,
            Body=json.dumps(chunk)
        )
        chunk_infos.append({
            'chunk_key': chunk_key,
            'evaluation_id': evaluation_id
        })
    return chunk_infos
