import json
import boto3
import os
import re


# Allowed S3 key prefixes for deletion
ALLOWED_PREFIXES = ['']  # Empty prefix allows all keys in the bucket; restrict if needed

# Forbidden patterns in S3 keys
FORBIDDEN_PATTERNS = re.compile(r'(\.\./|\.\.\\)')


def lambda_handler(event, context):
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
        roles = json.loads(claims['custom:role'])
        if any('Admin' in role for role in roles):
            print("admin granted!")
        else:
            return {
                'statusCode': 403,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps('User is not authorized to perform this action')
            }
    except Exception as e:
        print(f"Caught error checking user role: {e}")
        return {
                'statusCode': 500,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps('Unable to check user role, please ensure you have Cognito configured correctly with a custom:role attribute.')
            }

    try:
        payload = json.loads(event['body'])
    except Exception as e:
        print(f"Caught error parsing request body: {e}")
        return {
            'statusCode': 400,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps('Invalid request body')
        }

    key = payload.get('KEY', '')

    # Validate S3 key - reject path traversal and empty keys
    if not key or FORBIDDEN_PATTERNS.search(key):
        return {
            'statusCode': 400,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps('Invalid file key')
        }

    try:
        s3 = boto3.resource('s3')
        s3.Object(os.environ['BUCKET'], key).delete()
        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps('File deleted successfully')
        }
    except Exception as e:
        print(f"Caught error deleting S3 object: {e}")
        return {
            'statusCode': 502,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps('Failed to delete file')
        }
