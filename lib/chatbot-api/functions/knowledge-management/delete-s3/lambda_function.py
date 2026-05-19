import json
import boto3
import os
import re
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Forbidden patterns in S3 keys
FORBIDDEN_PATTERNS = re.compile(r'(\.\./|\.\.\\)')

BUCKET = os.environ['BUCKET']
KB_ID = os.environ.get('KB_ID')
DATA_SOURCE_ID = os.environ.get('DATA_SOURCE_ID')


def delete_kb_chunks(key: str):
    """
    Tell Bedrock to remove the document's chunks from the KB so the
    chatbot can't cite content from a file the admin just removed.
    Bedrock processes the delete asynchronously; the API call accepting
    the request is enough -- we don't wait for chunks to actually drop
    from OpenSearch. Raises on transport / permission errors so the
    caller can abort before deleting the S3 source.
    """
    if not KB_ID or not DATA_SOURCE_ID:
        # Defensive: if the Lambda env wasn't wired up, log and continue
        # so admins can still delete the S3 file. A full KB re-ingest
        # will eventually prune the chunks.
        logger.warning("KB_ID or DATA_SOURCE_ID not configured; skipping KB chunk cleanup")
        return
    bedrock_agent = boto3.client('bedrock-agent')
    s3_uri = f's3://{BUCKET}/{key}'
    logger.info(f"Removing KB document: {s3_uri}")
    response = bedrock_agent.delete_knowledge_base_documents(
        knowledgeBaseId=KB_ID,
        dataSourceId=DATA_SOURCE_ID,
        documentIdentifiers=[
            {
                'dataSourceType': 'S3',
                's3': {'uri': s3_uri},
            }
        ],
    )
    # Per-doc status comes back in documentDetails; log any that didn't
    # accept so we have a breadcrumb if chunks linger after a delete.
    for doc in response.get('documentDetails', []) or []:
        status = doc.get('status')
        if status not in ('DELETING', 'PENDING', 'DELETED', None):
            logger.warning(f"Bedrock returned unexpected status for {s3_uri}: {doc}")


def lambda_handler(event, context):
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
        roles = json.loads(claims['custom:role'])
        if not (isinstance(roles, list) and 'Admin' in roles):
            return {
                'statusCode': 403,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps('User is not authorized to perform this action')
            }
    except Exception as e:
        logger.error(f"Error checking user role: {e}")
        return {
            'statusCode': 500,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps('Unable to check user role, please ensure you have Cognito configured correctly with a custom:role attribute.')
        }

    try:
        payload = json.loads(event['body'])
    except Exception as e:
        logger.error(f"Error parsing request body: {e}")
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

    # Step 1: remove the doc's chunks from Bedrock KB. Doing this *before*
    # the S3 delete means a failure here leaves the file in place so the
    # admin can retry, instead of stranding orphaned chunks in OpenSearch
    # that the chatbot would keep citing.
    try:
        delete_kb_chunks(key)
    except Exception as e:
        logger.error(f"Failed to remove document from KB: {e}", exc_info=True)
        return {
            'statusCode': 502,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps('Failed to remove document from knowledge base; please try again')
        }

    # Step 2: delete the S3 source. The bucket's ObjectRemoved event
    # triggers the metadata-handler Lambda, which automatically rebuilds
    # metadata.txt to drop this file's entry -- so the per-doc summary
    # registry and S3 object metadata are handled without an explicit
    # call here.
    try:
        s3 = boto3.resource('s3')
        s3.Object(BUCKET, key).delete()
        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps('File deleted successfully')
        }
    except Exception as e:
        logger.error(f"Error deleting S3 object: {e}", exc_info=True)
        return {
            'statusCode': 502,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps('Failed to delete file')
        }
