import boto3
import json
import urllib.parse
import os
from botocore.exceptions import ClientError

s3 = boto3.client('s3')
BUCKET = os.environ['BUCKET']


# Can be modified later to add filter to work well with agent setup
def filter_metadata(metadata_content, category="memos"):
    try:
        metadata = json.loads(metadata_content)
        if category:
            filtered_metadata = {
                k: v for k, v in metadata.items() 
                if v.get('tag_category') == category
            }
            print(f"Returning filtered metadata for category '{category}':\n{filtered_metadata}")
            return filtered_metadata
        
        print(f"Returning full metadata:\n{metadata}")
        return metadata
    except json.JSONDecodeError:
        print("Error: Invalid JSON format in metadata content")
        return {}
    except Exception as e:
        print(f"Error processing metadata: {str(e)}")
        return {}

def lambda_handler(event, context):
    filter_key = event.get('filter_key', None)
    try:
        response = s3.get_object(Bucket=BUCKET, Key='metadata.txt')
        metadata_content = response['Body'].read().decode('utf-8')
        # Apply filtering logic based on filter_key
        filtered_metadata = filter_metadata(metadata_content, category=filter_key)
        return {
            'statusCode': 200,
            'body': json.dumps({'metadata': filtered_metadata})
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }

