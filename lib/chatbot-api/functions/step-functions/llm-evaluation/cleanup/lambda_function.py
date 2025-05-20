import boto3
import os
import logging
import json

# Configure logging
logging.basicConfig(level=logging.INFO)

TEST_CASE_BUCKET = os.environ['TEST_CASES_BUCKET']
EVAL_RESULTS_BUCKET = os.environ.get('EVAL_RESULTS_BUCKET', TEST_CASE_BUCKET)  # Fallback to TEST_CASE_BUCKET if not set

def lambda_handler(event, context):
    s3_client = boto3.client('s3')
    logging.info(f"Received event: {json.dumps(event)}")
    
    # Extract evaluation_id directly from the event
    evaluation_id = event.get("evaluation_id")
    test_cases_key = event.get("test_cases_key")
    
    # Alternatively check if it's nested in 'body'
    if not evaluation_id and 'body' in event:
        data = event.get("body", {})
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except json.JSONDecodeError:
                logging.error("Failed to parse body as JSON")
                data = {}
        evaluation_id = data.get("evaluation_id")
    
    if not evaluation_id:
        logging.error("evaluation_id parameter is required but not found in the event")
        return {
            'statusCode': 400,
            'body': json.dumps({"error": "evaluation_id parameter is required"}),
            'evaluation_id': None  # Return None to prevent Step Function from failing
        }

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

        logging.info(f"Cleanup completed for evaluation_id: {evaluation_id}")
        return {
            'statusCode': 200,
            'body': json.dumps({
                "message": f"Cleanup completed for evaluation_id: {evaluation_id}",
                "evaluation_id": evaluation_id
            }),
            'evaluation_id': evaluation_id  # Return evaluation_id to ensure Step Function completes properly
        }

    except Exception as e:
        logging.error(f"Error during cleanup: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                "error": f"Error during cleanup: {str(e)}",
                "evaluation_id": evaluation_id
            }),
            'evaluation_id': evaluation_id  # Return evaluation_id even in case of error
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
        # Don't raise the exception, just log it
        # This ensures the cleanup function doesn't fail if one prefix fails
