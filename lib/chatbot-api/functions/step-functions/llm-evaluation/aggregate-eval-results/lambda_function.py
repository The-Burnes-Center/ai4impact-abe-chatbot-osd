import boto3
import os
import json
import logging
from datetime import datetime
from botocore.exceptions import ClientError

# Environment variables
TEST_CASES_BUCKET = os.environ['TEST_CASES_BUCKET']
EVAL_RESULTS_BUCKET = os.environ.get('EVAL_RESULTS_BUCKET', TEST_CASES_BUCKET)

# Initialize clients
s3_client = boto3.client('s3')


def lambda_handler(event, context):
    """
    Aggregate partial evaluation results from the eval Lambda (Docker/RAGAS).

    This Lambda reads partial results written to S3 by the eval Lambda, computes
    averages across all test cases, writes the aggregated detailed results to S3,
    and returns the summary metrics.

    The eval Lambda (Docker image with RAGAS) computes all metrics:
    - similarity, relevance, correctness (standard metrics)
    - context_precision, context_recall, response_relevancy, faithfulness (RAG metrics)

    This Lambda simply aggregates those pre-computed scores. It does NOT attempt
    to compute metrics locally (no sentence-transformers, no sklearn needed).
    """
    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger(__name__)
    logger.info(f"Lambda invoked with event: {json.dumps(event)}")

    try:
        # Extract required parameters
        evaluation_id = event.get('evaluation_id')
        if not evaluation_id:
            logger.error("Missing required evaluation_id parameter")
            return {
                'statusCode': 400,
                'body': json.dumps({"error": "Missing required evaluation_id parameter"}),
                'evaluation_id': None
            }

        evaluation_name = event.get('evaluation_name', f"Evaluation on {str(datetime.now())}")
        test_cases_key = event.get('test_cases_key')
        partial_result_keys = []

        # Handle different partial results formats from Step Functions Map state
        if 'partial_result_keys' in event:
            for pr in event.get('partial_result_keys', []):
                if isinstance(pr, dict) and 'partial_result_key' in pr:
                    partial_result_keys.append(pr['partial_result_key'])
                elif isinstance(pr, str):
                    partial_result_keys.append(pr)

        logger.info(f"Processing {len(partial_result_keys)} partial results for evaluation {evaluation_id}")

        if not partial_result_keys:
            logger.warning("No partial result keys provided")
            return {
                'evaluation_id': evaluation_id,
                'evaluation_name': evaluation_name,
                'average_similarity': 0,
                'average_relevance': 0,
                'average_correctness': 0,
                'total_questions': 0,
                'detailed_results_s3_key': '',
                'test_cases_key': test_cases_key or '',
                'average_context_precision': 0,
                'average_context_recall': 0,
                'average_response_relevancy': 0,
                'average_faithfulness': 0,
            }

        # Accumulators for all metrics
        total_similarity = 0
        total_relevance = 0
        total_correctness = 0
        total_context_precision = 0
        total_context_recall = 0
        total_response_relevancy = 0
        total_faithfulness = 0
        total_questions = 0
        detailed_results = []
        errors = []

        # Read and aggregate partial results from S3
        for partial_result_key in partial_result_keys:
            try:
                partial_result = read_partial_result_from_s3(s3_client, TEST_CASES_BUCKET, partial_result_key)

                num_cases = partial_result.get('num_test_cases', 0)
                if num_cases == 0:
                    logger.warning(f"Partial result {partial_result_key} has 0 test cases, skipping")
                    continue

                total_similarity += partial_result.get('total_similarity', 0)
                total_relevance += partial_result.get('total_relevance', 0)
                total_correctness += partial_result.get('total_correctness', 0)
                total_context_precision += partial_result.get('total_context_precision', 0)
                total_context_recall += partial_result.get('total_context_recall', 0)
                total_response_relevancy += partial_result.get('total_response_relevancy', 0)
                total_faithfulness += partial_result.get('total_faithfulness', 0)
                total_questions += num_cases
                detailed_results.extend(partial_result.get('detailed_results', []))

                logger.info(f"Aggregated partial result {partial_result_key}: {num_cases} test cases")

            except Exception as e:
                error_msg = f"Error processing partial result {partial_result_key}: {str(e)}"
                logger.error(error_msg)
                errors.append(error_msg)
                # Continue with other partial results

        if total_questions == 0:
            logger.error("No test cases were successfully evaluated across all partial results")
            return {
                'statusCode': 500,
                'evaluation_id': evaluation_id,
                'error': 'No test cases were successfully evaluated',
                'partial_errors': errors,
            }

        # Compute averages
        average_similarity = total_similarity / total_questions
        average_relevance = total_relevance / total_questions
        average_correctness = total_correctness / total_questions
        average_context_precision = total_context_precision / total_questions
        average_context_recall = total_context_recall / total_questions
        average_response_relevancy = total_response_relevancy / total_questions
        average_faithfulness = total_faithfulness / total_questions

        # Validate that scores are within expected ranges [0, 1]
        for name, score in [
            ('similarity', average_similarity),
            ('relevance', average_relevance),
            ('correctness', average_correctness),
            ('context_precision', average_context_precision),
            ('context_recall', average_context_recall),
            ('response_relevancy', average_response_relevancy),
            ('faithfulness', average_faithfulness),
        ]:
            if score < 0 or score > 1:
                logger.warning(f"Metric '{name}' is out of expected range [0,1]: {score:.4f}")

        # Write aggregated detailed results to S3
        detailed_results_s3_key = f'evaluations/{evaluation_id}/aggregated_results/detailed_results.json'
        try:
            s3_client.put_object(
                Bucket=EVAL_RESULTS_BUCKET,
                Key=detailed_results_s3_key,
                Body=json.dumps(detailed_results)
            )
            logger.info(f"Wrote aggregated results to S3: {EVAL_RESULTS_BUCKET}/{detailed_results_s3_key}")
        except Exception as e:
            logger.error(f"Error writing aggregated results to S3: {str(e)}")
            raise

        result = {
            'evaluation_id': evaluation_id,
            'evaluation_name': evaluation_name,
            'average_similarity': round(average_similarity, 4),
            'average_relevance': round(average_relevance, 4),
            'average_correctness': round(average_correctness, 4),
            'total_questions': total_questions,
            'detailed_results_s3_key': detailed_results_s3_key,
            'test_cases_key': test_cases_key or '',
            'average_context_precision': round(average_context_precision, 4),
            'average_context_recall': round(average_context_recall, 4),
            'average_response_relevancy': round(average_response_relevancy, 4),
            'average_faithfulness': round(average_faithfulness, 4),
        }

        if errors:
            result['partial_errors'] = errors

        logger.info(f"Aggregation complete for evaluation {evaluation_id}. Results: {json.dumps(result)}")
        return result

    except Exception as e:
        error_msg = f"Unhandled exception in lambda_handler: {str(e)}"
        logger.error(error_msg)
        return {
            'statusCode': 500,
            'evaluation_id': event.get('evaluation_id', 'unknown'),
            'error': str(e),
        }


def read_partial_result_from_s3(s3_client, bucket_name, key):
    """Read and parse a partial result JSON file from S3."""
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
