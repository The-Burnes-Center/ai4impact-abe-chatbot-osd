import json
import os
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

from abe_utils import get_logger, is_admin_request, json_response, parse_json_body


dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(os.environ.get("FEEDBACK_TABLE"))
logger = get_logger(__name__)


def lambda_handler(event, context):
    route_key = event.get("routeKey", "")
    is_admin = is_admin_request(event)

    if "POST" in route_key:
        if event.get("rawPath") == "/user-feedback/download-feedback" and is_admin:
            return download_feedback(event)
        return post_feedback(event)
    if "GET" in route_key and is_admin:
        return get_feedback(event)
    if "DELETE" in route_key and is_admin:
        return delete_feedback(event)
    return json_response(405, "Method Not Allowed")


def post_feedback(event):
    try:
        payload = parse_json_body(event)
        feedback_data = payload["feedbackData"]
        feedback_id = str(uuid.uuid4())
        timestamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

        item = {
            "FeedbackID": feedback_id,
            "SessionID": feedback_data["sessionId"],
            "UserPrompt": feedback_data["prompt"],
            "FeedbackComments": feedback_data.get("comment", ""),
            "Topic": feedback_data.get("topic", "N/A (Good Response)"),
            "Problem": feedback_data.get("problem", ""),
            "Feedback": feedback_data["feedback"],
            "ChatbotMessage": feedback_data["completion"],
            "Sources": feedback_data["sources"],
            "CreatedAt": timestamp,
            "Any": "YES",
        }
        table.put_item(Item=item)
        return json_response(200, {"FeedbackID": feedback_id})
    except Exception as error:
        logger.exception("Failed to store feedback")
        return json_response(500, f"Failed to store feedback: {str(error)}")


def download_feedback(event):
    try:
        payload = parse_json_body(event)
        start_time = payload.get("startTime")
        end_time = payload.get("endTime")
        topic = payload.get("topic")
    except json.JSONDecodeError:
        return json_response(400, "Invalid JSON request body")

    if not topic or topic == "any":
        query_kwargs = {
            "IndexName": "AnyIndex",
            "KeyConditionExpression": Key("Any").eq("YES") & Key("CreatedAt").between(start_time, end_time),
        }
    else:
        query_kwargs = {
            "KeyConditionExpression": Key("Topic").eq(topic) & Key("CreatedAt").between(start_time, end_time),
        }

    try:
        response = table.query(**query_kwargs)
    except Exception as error:
        logger.exception("Failed to load feedback for download")
        return json_response(500, f"Failed to retrieve feedback for download: {str(error)}")

    def clean_csv(field):
        return str(field).replace('"', '""').replace("\n", " ").replace(",", " ")

    csv_content = "FeedbackID,SessionID,UserPrompt,FeedbackComment,Topic,Problem,Feedback,ChatbotMessage,CreatedAt\n"
    for item in response.get("Items", []):
        csv_content += (
            f"{clean_csv(item['FeedbackID'])},{clean_csv(item['SessionID'])},{clean_csv(item['UserPrompt'])},"
            f"{clean_csv(item['FeedbackComments'])},{clean_csv(item['Topic'])},{clean_csv(item['Problem'])},"
            f"{clean_csv(item['Feedback'])},{clean_csv(item['ChatbotMessage'])},{clean_csv(item['CreatedAt'])}\n"
        )

    s3 = boto3.client("s3")
    bucket_name = os.environ["FEEDBACK_S3_DOWNLOAD"]
    try:
        file_name = f"feedback-{start_time}-{end_time}.csv"
        s3.put_object(Bucket=bucket_name, Key=file_name, Body=csv_content)
        presigned_url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket_name, "Key": file_name},
            ExpiresIn=3600,
        )
    except Exception as error:
        logger.exception("Failed to generate feedback download link")
        return json_response(500, f"Failed to retrieve feedback for download: {str(error)}")

    return json_response(200, {"download_url": presigned_url})


def get_feedback(event):
    try:
        query_params = event.get("queryStringParameters", {}) or {}
        start_time = query_params.get("startTime")
        end_time = query_params.get("endTime")
        topic = query_params.get("topic")
        next_page_token = query_params.get("nextPageToken")

        if not topic or topic == "any":
            query_kwargs = {
                "IndexName": "AnyIndex",
                "KeyConditionExpression": Key("Any").eq("YES") & Key("CreatedAt").between(start_time, end_time),
                "ScanIndexForward": False,
                "Limit": 10,
            }
        else:
            query_kwargs = {
                "KeyConditionExpression": Key("Topic").eq(topic) & Key("CreatedAt").between(start_time, end_time),
                "ScanIndexForward": False,
                "Limit": 10,
            }

        if next_page_token:
            query_kwargs["ExclusiveStartKey"] = json.loads(next_page_token)

        response = table.query(**query_kwargs)
        body = {"Items": response.get("Items", [])}
        if "LastEvaluatedKey" in response:
            body["NextPageToken"] = json.dumps(response["LastEvaluatedKey"])
        return json_response(200, body)
    except Exception as error:
        logger.exception("Failed to retrieve feedback")
        return json_response(500, f"Failed to retrieve feedback: {str(error)}")


def delete_feedback(event):
    try:
        query_params = event.get("queryStringParameters", {}) or {}
        topic = query_params.get("topic")
        created_at = query_params.get("createdAt")
        if not topic or not created_at:
            return json_response(400, "Missing topic or createdAt")

        table.delete_item(Key={"Topic": topic, "CreatedAt": created_at})
        return json_response(200, {"message": "Feedback deleted successfully"})
    except Exception as error:
        logger.exception("Failed to delete feedback")
        return json_response(500, f"Failed to delete feedback: {str(error)}")
