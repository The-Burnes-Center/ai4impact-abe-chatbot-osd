import boto3
import os
import logging
import json

TEST_CASE_BUCKET = os.environ['TEST_CASES_BUCKET']
EVAL_RESULTS_BUCKET = os.environ.get('EVAL_RESULTS_BUCKET', TEST_CASE_BUCKET)  # Fallback to TEST_CASE_BUCKET if not set

def lambda_handler(event, context):
    s3_client = boto3.client('s3')
    data = event.get("body", {})
    print(data)
    if isinstance(data, str):
        data = json.loads(data)
    evaluation_id = data.get("evaluation_id")
    if not evaluation_id:
        raise ValueError("evaluation_id parameter is required in the event.")

    try:
        prefixes_to_delete = [
            f"evaluations/{evaluation_id}/chunks/",
            f"evaluations/{evaluation_id}/partial_results/",
            f"evaluations/{evaluation_id}/aggregated_results/",
        ]

        for prefix in prefixes_to_delete:
            delete_objects_in_prefix(s3_client, TEST_CASE_BUCKET, prefix)
        
        # Also clean up from EVAL_RESULTS_BUCKET if it's different
        if EVAL_RESULTS_BUCKET != TEST_CASE_BUCKET:
            for prefix in prefixes_to_delete:
                delete_objects_in_prefix(s3_client, EVAL_RESULTS_BUCKET, prefix)

        return {
            'statusCode': 200,
            'body': f"Cleanup completed for evaluation_id: {evaluation_id}"
        }

    except Exception as e:
        logging.error(f"Error during cleanup: {str(e)}")
        return {
            'statusCode': 500,
            'body': f"Error during cleanup: {str(e)}"
        }

def delete_objects_in_prefix(s3_client, bucket, prefix):
    try:
        # List objects with the specified prefix
        response = s3_client.list_objects_v2(
            Bucket=bucket,
            Prefix=prefix
        )
        
        # If there are no objects with this prefix, just return
        if 'Contents' not in response:
            logging.info(f"No objects found in {bucket}/{prefix}")
            return
        
        # Create a list of objects to delete
        objects_to_delete = [{'Key': obj['Key']} for obj in response['Contents']]
        
        # Delete the objects
        if objects_to_delete:
            s3_client.delete_objects(
                Bucket=bucket,
                Delete={
                    'Objects': objects_to_delete,
                    'Quiet': True
                }
            )
            logging.info(f"Deleted {len(objects_to_delete)} objects from {bucket}/{prefix}")
        
        # Check if there are more objects to delete (pagination)
        while response.get('IsTruncated', False):
            response = s3_client.list_objects_v2(
                Bucket=bucket,
                Prefix=prefix,
                ContinuationToken=response['NextContinuationToken']
            )
            
            if 'Contents' in response:
                objects_to_delete = [{'Key': obj['Key']} for obj in response['Contents']]
                if objects_to_delete:
                    s3_client.delete_objects(
                        Bucket=bucket,
                        Delete={
                            'Objects': objects_to_delete,
                            'Quiet': True
                        }
                    )
                    logging.info(f"Deleted additional {len(objects_to_delete)} objects from {bucket}/{prefix}")
    except Exception as e:
        logging.error(f"Error deleting objects in {bucket}/{prefix}: {str(e)}")
        raise
