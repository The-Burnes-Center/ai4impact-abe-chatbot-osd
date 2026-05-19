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

def get_active_job():
    """
    Return the most recent in-progress or starting ingestion job summary, or
    None if no sync is running. Bedrock's list_ingestion_jobs filter only
    accepts one status value per call, so we make two calls and merge.
    """
    logger.info(f"Checking for running sync jobs. KB_ID: {kb_index}, Source: {source_index}")

    syncing = client.list_ingestion_jobs(
        dataSourceId=source_index,
        knowledgeBaseId=kb_index,
        filters=[{'attribute': 'STATUS', 'operator': 'EQ', 'values': ['IN_PROGRESS']}]
    )
    starting = client.list_ingestion_jobs(
        dataSourceId=source_index,
        knowledgeBaseId=kb_index,
        filters=[{'attribute': 'STATUS', 'operator': 'EQ', 'values': ['STARTING']}]
    )
    hist = starting['ingestionJobSummaries'] + syncing['ingestionJobSummaries']
    logger.info(f"Found {len(hist)} running sync job(s)")
    if not hist:
        return None
    return sorted(hist, key=lambda j: j['startedAt'], reverse=True)[0]


def check_running():
    """Backwards-compatible boolean wrapper used by the sync-start handler."""
    return get_active_job() is not None


def get_job_progress(job_summary):
    """
    Pull the live statistics dict off the active ingestion job. Bedrock's
    list_ingestion_jobs response includes statistics on the summary itself,
    so we don't need an extra get_ingestion_job call; if the field is
    missing for any reason we fall back to a get_ingestion_job lookup.
    """
    stats = job_summary.get('statistics')
    if not stats:
        try:
            detail = client.get_ingestion_job(
                knowledgeBaseId=kb_index,
                dataSourceId=source_index,
                ingestionJobId=job_summary['ingestionJobId'],
            )
            stats = detail.get('ingestionJob', {}).get('statistics') or {}
        except Exception as e:
            logger.warning(f"Could not fetch ingestion job stats: {e}")
            stats = {}
    return {
        'scanned': stats.get('numberOfDocumentsScanned', 0),
        'indexed': stats.get('numberOfNewDocumentsIndexed', 0),
        'modified': stats.get('numberOfModifiedDocumentsIndexed', 0),
        'deleted': stats.get('numberOfDocumentsDeleted', 0),
        'failed': stats.get('numberOfDocumentsFailed', 0),
    }

def get_last_sync():
    logger.info(f"Getting last sync time. KB_ID: {kb_index}, Source: {source_index}")

    try:
        # Include FAILED jobs alongside COMPLETE so the UI can show a "Failed"
        # state when the most recent ingestion attempt didn't succeed.
        # Previously this only returned COMPLETE jobs, so a failed ingestion
        # was invisible -- the chip kept showing the previous successful sync
        # as if everything were fine.
        syncs = client.list_ingestion_jobs(
            dataSourceId=source_index,
            knowledgeBaseId=kb_index,
            filters=[{
                'attribute': 'STATUS',
                'operator': 'EQ',
                'values': [
                    'COMPLETE',
                    'FAILED',
                ]
            }]
        )
        hist = syncs["ingestionJobSummaries"]

        if len(hist) == 0:
            logger.warning("No completed or failed sync jobs found")
            return {
                'statusCode': 200,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({
                    'status': 'NO_SYNC_HISTORY',
                    'message': 'No sync history available',
                    'startedAt': None,
                    'completedAt': None
                })
            }

        # Sort by updatedAt descending to get the most recent sync job
        # The API might not return results in chronological order
        # For COMPLETE jobs, updatedAt represents the completion time
        hist_sorted = sorted(hist, key=lambda x: x["updatedAt"], reverse=True)
        most_recent = hist_sorted[0]
        most_recent_status = most_recent.get('status', 'COMPLETE')

        logger.info(f"Found {len(hist)} terminal sync job(s). Most recent: {most_recent.get('ingestionJobId', 'N/A')} status={most_recent_status}")
        logger.info(f"Most recent sync startedAt: {most_recent.get('startedAt')}")
        logger.info(f"Most recent sync updatedAt (completion): {most_recent['updatedAt']}")

        from datetime import timezone
        started_at = most_recent.get('startedAt')
        completed_at = most_recent['updatedAt']

        if started_at and started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        if completed_at.tzinfo is None:
            completed_at = completed_at.replace(tzinfo=timezone.utc)

        started_at_iso = started_at.isoformat().replace('+00:00', 'Z') if started_at else None
        completed_at_iso = completed_at.isoformat().replace('+00:00', 'Z')

        # For FAILED jobs, surface the failure reason if Bedrock provided one
        # so the dashboard can show it inline next to the chip.
        failure_reasons = most_recent.get('failureReasons') or []
        failure_message = '; '.join(failure_reasons) if failure_reasons else None

        response_data = {
            'status': most_recent_status,  # 'COMPLETE' or 'FAILED'
            'startedAt': started_at_iso,
            'completedAt': completed_at_iso,
            'failureMessage': failure_message,
        }
        
        logger.info(f"Returning sync data: {response_data}")
        
        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps(response_data)
        }
    except Exception as e:
        logger.error(f"Error getting last sync: {str(e)}", exc_info=True)
        return {
            'statusCode': 500,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({
                'status': 'ERROR',
                'message': f'Error retrieving last sync: {str(e)}',
                'startedAt': None,
                'completedAt': None
            })
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
        if isinstance(roles, list) and 'Admin' in roles:
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
        active = get_active_job()
        if active is None:
            return {
                'statusCode': 200,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'status': 'DONE_SYNCING'})
            }
        progress = get_job_progress(active)
        logger.info(f"Sync in progress: {progress}")
        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({
                'status': 'STILL_SYNCING',
                'statistics': progress,
            })
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