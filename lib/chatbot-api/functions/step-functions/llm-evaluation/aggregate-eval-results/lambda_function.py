import boto3
import os
import json
import logging
from datetime import datetime

TEST_CASES_BUCKET = os.environ['TEST_CASES_BUCKET']
s3_client = boto3.client('s3')

def lambda_handler(event, context): 
    try:
        partial_result_keys = [pr['partial_result_key'] for pr in event['partial_result_keys']]
        evaluation_id = event['evaluation_id']
        test_cases_key = event['test_cases_key']
        evaluation_name = event.get('evaluation_name', f"Evaluation on {str(datetime.now())}")

        # Initialize accumulators
        total_similarity = 0
        total_relevance = 0
        total_correctness = 0
        total_questions = 0
        detailed_results = []

        # Read each partial result from S3
        for partial_result_key in partial_result_keys:
            partial_result = read_partial_result_from_s3(s3_client, TEST_CASES_BUCKET, partial_result_key)
            total_similarity += partial_result['total_similarity']
            total_relevance += partial_result['total_relevance']
            total_correctness += partial_result['total_correctness']
            total_questions += partial_result['num_test_cases']
            detailed_results.extend(partial_result['detailed_results'])

        # Compute averages
        average_similarity = total_similarity / total_questions if total_questions > 0 else 0
        average_relevance = total_relevance / total_questions if total_questions > 0 else 0
        average_correctness = total_correctness / total_questions if total_questions > 0 else 0

        # Write aggregated detailed results to S3
        detailed_results_s3_key = f'evaluations/{evaluation_id}/aggregated_results/detailed_results.json'
        s3_client.put_object(
            Bucket=TEST_CASES_BUCKET,
            Key=detailed_results_s3_key,
            Body=json.dumps(detailed_results)
        )

        # Return aggregated results
        return {
            'evaluation_id': evaluation_id, 
            'evaluation_name': evaluation_name,
            'average_similarity': average_similarity,
            'average_relevance': average_relevance,
            'average_correctness': average_correctness,
            'total_questions': total_questions,
            'detailed_results_s3_key': detailed_results_s3_key,
            'test_cases_key': test_cases_key
        }
    except Exception as e:
        logging.error(f"Error in aggregation Lambda: {str(e)}")
        return {
            "status_code": 500,
            "error": str(e)
        }

def read_partial_result_from_s3(s3_client, bucket_name, key):
    response = s3_client.get_object(Bucket=bucket_name, Key=key)
    content = response['Body'].read().decode('utf-8')
    return json.loads(content)
