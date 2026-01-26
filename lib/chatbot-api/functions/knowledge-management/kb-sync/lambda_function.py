import json
import boto3
import os
import logging

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Retrieve environment variables for Knowledge Base index and source index
kb_index = os.environ['KB_ID']
source_index = os.environ['SOURCE']

# Initialize a Bedrock Agent client
client = boto3.client('bedrock-agent')

def check_running():
    """
    Check if any sync jobs for the specified data source and index are currently running.

    Returns:
        bool: True if there are any ongoing sync or sync-indexing jobs, False otherwise.
    """
    logger.info(f"Checking for running sync jobs. KB_ID: {kb_index}, Source: {source_index}")
    
    # List ongoing sync jobs with status 'SYNCING'
    syncing = client.list_ingestion_jobs(
        dataSourceId=source_index,
        knowledgeBaseId=kb_index,
        filters=[{
            'attribute': 'STATUS',
            'operator': 'EQ',
            'values': [
                'IN_PROGRESS',
            ]
        }]
    )
    
    # List ongoing sync jobs with status 'STARTING'
    starting = client.list_ingestion_jobs(
        dataSourceId=source_index,
        knowledgeBaseId=kb_index,
        filters=[{
            'attribute': 'STATUS',
            'operator': 'EQ',
            'values': [
                'STARTING',
            ]
        }]
    )
    
    # Combine the history of both job types
    hist = starting['ingestionJobSummaries'] + syncing['ingestionJobSummaries']
    
    logger.info(f"Found {len(hist)} running sync job(s)")
    
    # Check if there are any jobs in the history
    if len(hist) > 0:
        return True
    return False

def get_last_sync():    
    logger.info(f"Getting last sync time. KB_ID: {kb_index}, Source: {source_index}")
    
    try:
        syncs = client.list_ingestion_jobs(
            dataSourceId=source_index,
            knowledgeBaseId=kb_index,
            filters=[{
                'attribute': 'STATUS',
                'operator': 'EQ',
                'values': [
                    'COMPLETE',
                ]
            }]
        )
        hist = syncs["ingestionJobSummaries"]
        
        if len(hist) == 0:
            logger.warning("No completed sync jobs found")
            return {
                'statusCode': 200,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps('No sync history available')
            }
        
        # Sort by updatedAt descending to get the most recent sync job
        # The API might not return results in chronological order
        hist_sorted = sorted(hist, key=lambda x: x["updatedAt"], reverse=True)
        most_recent = hist_sorted[0]
        
        logger.info(f"Found {len(hist)} completed sync job(s). Most recent: {most_recent.get('ingestionJobId', 'N/A')}")
        logger.info(f"Most recent sync updatedAt: {most_recent['updatedAt']}")
        
        time = most_recent["updatedAt"].strftime('%B %d, %Y, %I:%M%p UTC')
        logger.info(f"Last sync time formatted: {time}")
        
        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps(time)
        }
    except Exception as e:
        logger.error(f"Error getting last sync: {str(e)}", exc_info=True)
        return {
            'statusCode': 500,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps(f'Error retrieving last sync: {str(e)}')
        }


def lambda_handler(event, context):
    """
    AWS Lambda handler function for handling requests.

    Args:
        event (dict): The event dictionary containing request data.
        context (dict): The context dictionary containing information about the Lambda function execution.

    Returns:
        dict: A response dictionary with a status code, headers, and body.
    """
    
    # Retrieve the resource path from the event dictionary
    resource_path = event.get('rawPath', '')
    logger.info(f"Received request for path: {resource_path}")
    
    # Check admin access    
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
        roles = json.loads(claims['custom:role'])
        if any('Admin' in role for role in roles):
            logger.info("Admin access granted")
        else:
            logger.warning("Access denied: User does not have Admin role")
            return {
                'statusCode': 403,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps('User is not authorized to perform this action')
            }
    except Exception as e:
        logger.error(f"Error checking admin access: {str(e)}", exc_info=True)
        return {
                'statusCode': 500,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps('Unable to check user role, please ensure you have Cognito configured correctly with a custom:role attribute.')
            }    
        
    # Check if the request is for syncing Knowledge Base
    if "sync-kb" in resource_path:
        logger.info("Processing sync-kb request")
        if check_running():
            logger.info("Sync already in progress, returning STILL SYNCING")
            return {
                'statusCode': 200,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps('STILL SYNCING')
            }
        else:
            logger.info("No sync in progress, starting new sync job")
            try:
                response = client.start_ingestion_job(
                    dataSourceId=source_index,
                    knowledgeBaseId=kb_index
                )
                logger.info(f"Sync job started successfully. Job ID: {response.get('ingestionJob', {}).get('ingestionJobId', 'N/A')}")
            except Exception as e:
                logger.error(f"Error starting sync job: {str(e)}", exc_info=True)
                return {
                    'statusCode': 500,
                    'headers': {'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps(f'Error starting sync: {str(e)}')
                }
        
            return {
                'statusCode': 200,
                'headers': {
                'Access-Control-Allow-Origin': '*'
                },
                'body': json.dumps('STARTED SYNCING')
            }
   
    # Check if the request is for checking the sync status        
    elif "still-syncing" in resource_path:
        logger.info("Processing still-syncing status check")
        is_running = check_running()
        status_msg = 'STILL SYNCING' if is_running else 'DONE SYNCING'
        logger.info(f"Sync status: {status_msg}")
        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps(status_msg)
            }
    elif "last-sync" in resource_path:
        logger.info("Processing last-sync request")
        return get_last_sync()
    else:
        logger.warning(f"Unknown resource path: {resource_path}")
        return {
            'statusCode': 404,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps('Endpoint not found')
        }