import json
import os
import boto3
from datetime import datetime

sqs = boto3.client("sqs", region_name="us-east-1")
QUEUE_URL = os.environ["QUEUE_URL"]

REQUIRED_FIELDS = ("prompt", "completion", "sessionId", "userId", "displayName")


def lambda_handler(event, context):
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "OPTIONS,POST",
    }

    try:
        body = json.loads(event.get("body", "{}"))
    except (json.JSONDecodeError, TypeError):
        return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": "Invalid JSON"})}

    missing = [f for f in REQUIRED_FIELDS if not body.get(f)]
    if missing:
        return {
            "statusCode": 400,
            "headers": headers,
            "body": json.dumps({"error": f"Missing required fields: {', '.join(missing)}"}),
        }

    body["submittedAt"] = datetime.utcnow().isoformat() + "Z"

    sqs.send_message(QueueUrl=QUEUE_URL, MessageBody=json.dumps(body))

    return {
        "statusCode": 200,
        "headers": headers,
        "body": json.dumps({"status": "queued"}),
    }
