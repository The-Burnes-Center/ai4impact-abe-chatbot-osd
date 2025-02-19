import boto3
import os
import logging
import json

TEST_CASE_BUCKET = os.environ['TEST_CASES_BUCKET']

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
    # List all objects under the prefix
    objects_to_delete = []
    paginator = s3_client.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        contents = page.get('Contents', [])
        for obj in contents:
            objects_to_delete.append({'Key': obj['Key']})

    # Delete objects if there are any
    if objects_to_delete:
        # S3 supports deleting up to 1000 objects in a single request
        for i in range(0, len(objects_to_delete), 1000):
            response = s3_client.delete_objects(
                Bucket=bucket,
                Delete={'Objects': objects_to_delete[i:i+1000]}
            )
        print(f"Deleted {len(objects_to_delete)} objects from {bucket}/{prefix}")
    else:
        print(f"No objects found under {bucket}/{prefix}")
