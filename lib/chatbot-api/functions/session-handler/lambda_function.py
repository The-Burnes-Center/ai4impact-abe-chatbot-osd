import json
import os
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

from abe_utils import get_logger, json_response, parse_json_body, truncate_text


DDB_TABLE_NAME = os.environ["DDB_TABLE_NAME"]

dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
table = dynamodb.Table(DDB_TABLE_NAME)
logger = get_logger(__name__)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def get_session(session_id, user_id):
    try:
        response = table.get_item(Key={"user_id": user_id, "session_id": session_id})
        return json_response(200, response.get("Item", {}))
    except ClientError as error:
        logger.exception("DynamoDB error while reading session")
        if error.response["Error"]["Code"] == "ResourceNotFoundException":
            return json_response(404, f"No record found with session id: {session_id}")
        return json_response(500, "An unexpected error occurred")


def add_session(session_id, user_id, title, new_chat_entry):
    title_text = truncate_text(title or f"Chat on {utc_now_iso()}", 80).strip() or f"Chat on {utc_now_iso()}"
    try:
        table.put_item(
            Item={
                "user_id": user_id,
                "session_id": session_id,
                "chat_history": [new_chat_entry],
                "title": title_text,
                "time_stamp": utc_now_iso(),
            },
            ConditionExpression="attribute_not_exists(user_id) AND attribute_not_exists(session_id)",
        )
        return json_response(200, {"created": True, "title": title_text})
    except ClientError as error:
        logger.exception("DynamoDB error while creating session")
        if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return json_response(409, f"Session already exists: {session_id}")
        if error.response["Error"]["Code"] == "ResourceNotFoundException":
            return json_response(404, f"No record found with session id: {session_id}")
        return json_response(500, "Failed to create the session due to a database error.")


def update_session(session_id, user_id, new_chat_entry):
    try:
        response = table.update_item(
            Key={"user_id": user_id, "session_id": session_id},
            UpdateExpression="SET chat_history = list_append(if_not_exists(chat_history, :empty), :new_entry), time_stamp = :ts",
            ExpressionAttributeValues={
                ":new_entry": [new_chat_entry],
                ":empty": [],
                ":ts": utc_now_iso(),
            },
            ConditionExpression="attribute_exists(user_id) AND attribute_exists(session_id)",
            ReturnValues="UPDATED_NEW",
        )
        return json_response(200, response.get("Attributes", {}))
    except ClientError as error:
        logger.exception("DynamoDB error while updating session")
        error_code = error.response["Error"]["Code"]
        if error_code in ("ResourceNotFoundException", "ConditionalCheckFailedException"):
            return json_response(404, f"No record found with session id: {session_id}")
        return json_response(500, "Failed to update the session due to a database error.")


def append_chat_entry(session_id, user_id, new_chat_entry, title):
    title_text = truncate_text(title or f"Chat on {utc_now_iso()}", 80).strip() or f"Chat on {utc_now_iso()}"
    try:
        response = table.update_item(
            Key={"user_id": user_id, "session_id": session_id},
            UpdateExpression=(
                "SET chat_history = list_append(if_not_exists(chat_history, :empty), :new_entry), "
                "time_stamp = :ts, #title = if_not_exists(#title, :title)"
            ),
            ExpressionAttributeNames={"#title": "title"},
            ExpressionAttributeValues={
                ":empty": [],
                ":new_entry": [new_chat_entry],
                ":title": title_text,
                ":ts": utc_now_iso(),
            },
            ReturnValues="ALL_OLD",
        )
        return json_response(
            200,
            {
                "created": not bool(response.get("Attributes")),
                "title": title_text,
            },
        )
    except ClientError:
        logger.exception("DynamoDB error while appending session entry")
        return json_response(500, "Failed to save the session due to a database error.")


def delete_session(session_id, user_id):
    try:
        table.delete_item(Key={"user_id": user_id, "session_id": session_id})
        return json_response(200, {"id": session_id, "deleted": True})
    except ClientError as error:
        logger.exception("DynamoDB error while deleting session")
        if error.response["Error"]["Code"] == "ResourceNotFoundException":
            return json_response(404, {"id": session_id, "deleted": False})
        return json_response(500, {"id": session_id, "deleted": False})


def list_sessions_by_user_id(user_id, limit=50):
    items = []

    try:
        last_evaluated_key = None
        while len(items) < limit:
            query_kwargs = {
                "IndexName": "TimeIndex",
                "ProjectionExpression": "session_id, title, time_stamp",
                "KeyConditionExpression": "user_id = :user_id",
                "ExpressionAttributeValues": {":user_id": user_id},
                "ScanIndexForward": False,
                "Limit": limit - len(items),
            }
            if last_evaluated_key:
                query_kwargs["ExclusiveStartKey"] = last_evaluated_key

            response = table.query(**query_kwargs)
            items.extend(response.get("Items", []))
            last_evaluated_key = response.get("LastEvaluatedKey")
            if not last_evaluated_key:
                break
    except ClientError as error:
        logger.exception("DynamoDB error while listing sessions")
        error_code = error.response["Error"]["Code"]
        if error_code == "ResourceNotFoundException":
            return json_response(404, f"No record found for user id: {user_id}")
        if error_code == "ProvisionedThroughputExceededException":
            return json_response(429, "Request limit exceeded")
        if error_code == "ValidationException":
            return json_response(400, "Invalid input parameters")
        return json_response(500, "Internal server error")
    except Exception as error:
        logger.exception("Unexpected error while listing sessions")
        return json_response(500, f"An unexpected error occurred: {str(error)}")

    sorted_items = sorted(items, key=lambda item: item["time_stamp"], reverse=True)
    sessions = [
        {
            "time_stamp": item["time_stamp"],
            "session_id": item["session_id"],
            "title": (item.get("title") or "").strip(),
        }
        for item in sorted_items
    ]
    return json_response(200, sessions)


def delete_user_sessions(user_id):
    sessions_response = list_sessions_by_user_id(user_id, limit=1000)
    if sessions_response["statusCode"] != 200:
        return sessions_response

    sessions = json.loads(sessions_response["body"])
    deleted = []
    for session in sessions:
        result = delete_session(session["session_id"], user_id)
        deleted.append({"id": session["session_id"], "deleted": result["statusCode"] == 200})
    return json_response(200, deleted)


def fetch_metadata(filter_key=None):
    try:
        s3 = boto3.client("s3")
        bucket_name = os.environ.get("METADATA_BUCKET")
        response = s3.get_object(Bucket=bucket_name, Key="metadata.txt")
        metadata = json.loads(response["Body"].read().decode("utf-8"))

        if filter_key:
            filtered_metadata = {
                key: value
                for key, value in metadata.items()
                if filter_key in key or filter_key in json.dumps(value)
            }
            return json_response(200, {"metadata": filtered_metadata})

        return json_response(200, {"metadata": metadata})
    except Exception as error:
        logger.exception("Error fetching metadata")
        return json_response(500, {"error": f"Failed to fetch metadata: {str(error)}"})


def lambda_handler(event, context):
    try:
        data = parse_json_body(event)
    except json.JSONDecodeError:
        return json_response(400, "Invalid JSON request body")

    operation = data.get("operation")
    user_id = data.get("user_id")
    session_id = data.get("session_id")
    new_chat_entry = data.get("new_chat_entry")
    title = data.get("title")
    filter_key = data.get("filter_key")

    if operation == "fetch_metadata":
        return fetch_metadata(filter_key)
    if operation == "add_session":
        return add_session(session_id, user_id, title, new_chat_entry)
    if operation == "get_session":
        return get_session(session_id, user_id)
    if operation == "update_session":
        return update_session(session_id, user_id, new_chat_entry)
    if operation == "append_chat_entry":
        return append_chat_entry(session_id, user_id, new_chat_entry, title)
    if operation == "list_sessions_by_user_id":
        return list_sessions_by_user_id(user_id)
    if operation == "list_all_sessions_by_user_id":
        return list_sessions_by_user_id(user_id, limit=100)
    if operation == "delete_session":
        return delete_session(session_id, user_id)
    if operation == "delete_user_sessions":
        return delete_user_sessions(user_id)
    return json_response(400, f"Operation not found/allowed! Operation Sent: {operation}")
