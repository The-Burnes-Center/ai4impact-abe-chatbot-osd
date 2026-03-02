import os
import boto3
from botocore.exceptions import ClientError
import json
from boto3.dynamodb.conditions import Key
from datetime import datetime
from decimal import Decimal

EVALUATION_SUMMARIES_TABLE = os.environ.get("EVALUATION_SUMMARIES_TABLE") or os.environ.get("EVAL_SUMMARIES_TABLE")
EVALUATION_RESULTS_TABLE = os.environ.get("EVALUATION_RESULTS_TABLE") or os.environ.get("EVAL_RESULTS_TABLE")

dynamodb = boto3.resource("dynamodb", region_name='us-east-1')
sfn_client = boto3.client("stepfunctions", region_name='us-east-1')

summaries_table = dynamodb.Table(EVALUATION_SUMMARIES_TABLE)
results_table = dynamodb.Table(EVALUATION_RESULTS_TABLE)

def convert_from_decimal(item):
    if isinstance(item, list):
        return [convert_from_decimal(i) for i in item]
    elif isinstance(item, dict):
        return {k: convert_from_decimal(v) for k, v in item.items()}
    elif isinstance(item, Decimal):
        return float(item) 
    else:
        return item

# function to retrieve all summaries from DynamoDB
def get_evaluation_summaries(continuation_token=None, limit=10):
    try: 
        try:
            # First try with PartitionKey
            query_params = {
                "KeyConditionExpression": Key("PartitionKey").eq("Evaluation"),
                "ProjectionExpression": "#eid, #ts, #as, #ar, #ac, #tq, #en, #tk, #acp, #acr, #arr, #af, #ea",
                "ExpressionAttributeNames": {
                    "#eid": "EvaluationId",
                    "#ts": "Timestamp",
                    "#as": "average_similarity",
                    "#ar": "average_relevance",
                    "#ac": "average_correctness",
                    "#tq": "total_questions",
                    "#en": "evaluation_name",
                    "#tk": "test_cases_key",
                    "#acp": "average_context_precision",
                    "#acr": "average_context_recall",
                    "#arr": "average_response_relevancy",
                    "#af": "average_faithfulness",
                    "#ea": "executionArn",
                },
                "Limit": limit,
                "ScanIndexForward": False  # Get the most recent evaluations first
            }
            # Add continuation token if provided
            if continuation_token:
                query_params["ExclusiveStartKey"] = continuation_token
                
            response = summaries_table.query(**query_params)
            items = response.get('Items', [])
            last_evaluated_key = response.get('LastEvaluatedKey')
            
        except ClientError as partition_error:
            # Fallback to scan if PartitionKey doesn't exist
            scan_params = {
                "Limit": limit
            }
            if continuation_token:
                scan_params["ExclusiveStartKey"] = continuation_token
            
            response = summaries_table.scan(**scan_params)
            items = response.get('Items', [])
            last_evaluated_key = response.get('LastEvaluatedKey')

        # Sort items to return most recent evaluations first if Timestamp exists
        if items and 'Timestamp' in items[0]:
            items = sorted(items, key=lambda x: x.get('Timestamp', ''), reverse=True)
                
        response_body = {
            'Items': convert_from_decimal(items),
            'NextPageToken': last_evaluated_key
        }

        # Build response with correct headers
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps(response_body)
        }
    except ClientError as error:
        # Build error response with correct headers
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({"error": str(error), "table": EVALUATION_SUMMARIES_TABLE})
        }
    except Exception as e:
        import traceback
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({"error": str(e), "table": EVALUATION_SUMMARIES_TABLE})
        }

# function to retrieve detailed results for a specific evaluation from DynamoDB
def get_evaluation_results(evaluation_id, continuation_token=None, limit=10):
    try:
        query_params = {
            'KeyConditionExpression': boto3.dynamodb.conditions.Key('EvaluationId').eq(evaluation_id),
            'Limit': limit
        }
        if continuation_token:
            query_params['ExclusiveStartKey'] = continuation_token
        
        # Query the results table for the given evaluation_id
        response = results_table.query(**query_params)
        items = response.get('Items', [])
        last_evaluated_key = response.get('LastEvaluatedKey')

        # Sort items by QuestionId and build response body
        sorted_items = sorted(items, key=lambda x: int(x['QuestionId']))
        
        # Add question_id field for frontend compatibility
        for item in sorted_items:
            item['question_id'] = item['QuestionId']
            
        response_body = {
            'Items': convert_from_decimal(sorted_items),
            'NextPageToken': last_evaluated_key
        }

        # Build response with correct headers
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps(response_body)
        }
    except ClientError as error:
        # Build error response with correct headers
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({"error": str(error), "table": EVALUATION_RESULTS_TABLE})
        }
    except Exception as e:
        # For any other errors
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({"error": str(e), "table": EVALUATION_RESULTS_TABLE})
        }

def get_eval_status(evaluation_id):
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
    }
    try:
        resp = summaries_table.query(
            KeyConditionExpression=Key("PartitionKey").eq("Evaluation"),
            FilterExpression="EvaluationId = :eid",
            ExpressionAttributeValues={":eid": evaluation_id},
            ScanIndexForward=False,
        )
        items = resp.get("Items", [])
        if not items:
            return {"statusCode": 404, "headers": headers, "body": json.dumps({"error": "Evaluation not found"})}

        item = items[0]
        execution_arn = item.get("executionArn")
        if not execution_arn:
            status = "SUCCEEDED" if item.get("average_correctness") is not None else "UNKNOWN"
            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({"evaluationId": evaluation_id, "status": status, "steps": [], "message": "No executionArn recorded"})
            }

        desc = sfn_client.describe_execution(executionArn=execution_arn)
        overall_status = desc.get("status", "UNKNOWN")
        start_date = desc.get("startDate")

        elapsed_seconds = 0
        if start_date:
            from datetime import timezone
            elapsed_seconds = int((datetime.now(timezone.utc) - start_date).total_seconds())

        history = sfn_client.get_execution_history(executionArn=execution_arn, reverseOrder=True, maxResults=200)
        events = history.get("events", [])

        steps = [
            {"name": "Splitting Test Cases", "status": "pending"},
            {"name": "Evaluating Test Cases", "status": "pending", "chunksCompleted": 0, "chunksTotal": 0},
            {"name": "Aggregating Results", "status": "pending"},
            {"name": "Saving Results", "status": "pending"},
            {"name": "Cleanup", "status": "pending"},
        ]
        current_step = "pending"

        step_name_map = {
            "Split Test Cases": 0,
            "Aggregate Results": 2,
            "Save Results": 3,
            "CleanupChunks": 4,
            "Cleanup Chunks": 4,
        }

        map_started = False
        map_exited = False
        iter_started = 0
        iter_succeeded = 0
        iter_failed = 0

        for evt in events:
            evt_type = evt.get("type", "")
            detail = evt.get("stateEnteredEventDetails", {}) or evt.get("stateExitedEventDetails", {})
            name = detail.get("name", "")

            if evt_type == "TaskStateEntered" and name in step_name_map:
                idx = step_name_map[name]
                if steps[idx]["status"] == "pending":
                    steps[idx]["status"] = "running"
                    current_step = steps[idx]["name"]
            elif evt_type == "TaskStateExited" and name in step_name_map:
                idx = step_name_map[name]
                steps[idx]["status"] = "completed"

            elif evt_type == "MapStateEntered":
                map_started = True
                steps[1]["status"] = "running"
                current_step = "Evaluating Test Cases"
            elif evt_type == "MapStateExited":
                map_exited = True
                steps[1]["status"] = "completed"
            elif evt_type == "MapIterationStarted":
                iter_started += 1
            elif evt_type == "MapIterationSucceeded":
                iter_succeeded += 1
            elif evt_type == "MapIterationFailed":
                iter_failed += 1

            elif evt_type == "ExecutionSucceeded":
                for s in steps:
                    s["status"] = "completed"
                current_step = "completed"
            elif evt_type == "ExecutionFailed":
                current_step = "failed"

        if map_started:
            steps[0]["status"] = "completed"
        if map_started and not map_exited:
            steps[1]["chunksTotal"] = iter_started
            steps[1]["chunksCompleted"] = iter_succeeded

        result = {
            "evaluationId": evaluation_id,
            "status": overall_status,
            "currentStep": current_step,
            "steps": steps,
            "startedAt": start_date.isoformat() if start_date else None,
            "elapsedSeconds": elapsed_seconds,
        }
        return {"statusCode": 200, "headers": headers, "body": json.dumps(result)}

    except ClientError as e:
        return {"statusCode": 500, "headers": headers, "body": json.dumps({"error": str(e)})}
    except Exception as e:
        return {"statusCode": 500, "headers": headers, "body": json.dumps({"error": str(e)})}


def lambda_handler(event, context):
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Methods': 'OPTIONS,POST,GET',
    }
    
    # Handle OPTIONS request (preflight)
    if event.get('httpMethod') == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps({'message': 'CORS preflight request successful'})
        }
    
    try:
        data = json.loads(event['body']) if 'body' in event else event
        operation = data.get('operation')
        evaluation_id = data.get('evaluation_id')
        continuation_token = data.get('continuation_token')
        limit = data.get('limit', 10)

        if operation == 'get_evaluation_summaries':
            result = get_evaluation_summaries(continuation_token, limit)
            if 'headers' in result:
                result['headers'].update(headers)
            else:
                result['headers'] = headers
            return result
        elif operation == 'get_evaluation_results':
            if not evaluation_id:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps('evaluation_id is required for retrieving evaluation results.')
                }
            result = get_evaluation_results(evaluation_id, continuation_token, limit)
            if 'headers' in result:
                result['headers'].update(headers)
            else:
                result['headers'] = headers
            return result
        elif operation == 'get_eval_status':
            if not evaluation_id:
                return {
                    'statusCode': 400,
                    'headers': headers,
                    'body': json.dumps({'error': 'evaluation_id is required'})
                }
            result = get_eval_status(evaluation_id)
            if 'headers' in result:
                result['headers'].update(headers)
            else:
                result['headers'] = headers
            return result
        else:
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps(f'Operation not found/allowed! Operation Sent: {operation}')
            }
    except Exception as e:
        import traceback
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({
                'message': 'Internal server error', 
                'error': str(e),
                'summaries_table': EVALUATION_SUMMARIES_TABLE,
                'results_table': EVALUATION_RESULTS_TABLE
            })
        }