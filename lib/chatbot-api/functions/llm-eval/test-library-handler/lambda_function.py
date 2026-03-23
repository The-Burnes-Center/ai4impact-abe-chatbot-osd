import os
import re
import json
import uuid
import logging
import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from datetime import datetime
from decimal import Decimal
from abe_utils.text import strip_kb_citation_markers

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

TABLE_NAME = os.environ["TEST_LIBRARY_TABLE"]
dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
table = dynamodb.Table(TABLE_NAME)

PARTITION_KEY = "MASTER"


def normalize_question(q: str) -> str:
    text = q.strip().lower()
    return re.sub(r'\s+', ' ', text)


def convert_from_decimal(item):
    if isinstance(item, list):
        return [convert_from_decimal(i) for i in item]
    elif isinstance(item, dict):
        return {k: convert_from_decimal(v) for k, v in item.items()}
    elif isinstance(item, Decimal):
        return float(item)
    return item


def now_iso():
    return datetime.utcnow().isoformat() + "Z"


def find_by_normalized(normalized: str):
    resp = table.query(
        IndexName="NormalizedQuestionIndex",
        KeyConditionExpression=Key("questionNormalized").eq(normalized),
        Limit=1,
    )
    items = resp.get("Items", [])
    if items:
        qid = items[0]["QuestionId"]
        full = table.get_item(Key={"PartitionKey": PARTITION_KEY, "QuestionId": qid})
        return full.get("Item")
    return None


def upsert_item(question: str, expected_response: str, source: str):
    normalized = normalize_question(question)
    existing = find_by_normalized(normalized)
    ts = now_iso()

    if existing:
        if existing.get("expectedResponse", "") == expected_response:
            return "unchanged", existing["QuestionId"]

        versions = existing.get("versions", [])
        versions.insert(0, {
            "expectedResponse": existing.get("expectedResponse", ""),
            "source": existing.get("source", ""),
            "updatedAt": existing.get("updatedAt", existing.get("createdAt", "")),
        })

        table.update_item(
            Key={"PartitionKey": PARTITION_KEY, "QuestionId": existing["QuestionId"]},
            UpdateExpression="SET expectedResponse = :er, #src = :src, updatedAt = :ua, versions = :v",
            ExpressionAttributeNames={"#src": "source"},
            ExpressionAttributeValues={
                ":er": expected_response,
                ":src": source,
                ":ua": ts,
                ":v": versions,
            },
        )
        return "updated", existing["QuestionId"]
    else:
        qid = f"Q#{uuid.uuid4()}"
        table.put_item(Item={
            "PartitionKey": PARTITION_KEY,
            "QuestionId": qid,
            "question": question.strip(),
            "questionNormalized": normalized,
            "expectedResponse": expected_response,
            "source": source,
            "createdAt": ts,
            "updatedAt": ts,
            "versions": [],
        })
        return "added", qid


# --- Operations ---

def op_list(data, headers):
    limit = data.get("limit", 25)
    search = data.get("search", "").strip().lower()
    continuation_token = data.get("continuation_token")

    params = {
        "KeyConditionExpression": Key("PartitionKey").eq(PARTITION_KEY),
        "Limit": limit,
        "ScanIndexForward": True,
    }
    if continuation_token:
        params["ExclusiveStartKey"] = continuation_token

    resp = table.query(**params)
    items = convert_from_decimal(resp.get("Items", []))

    if search:
        items = [i for i in items if search in i.get("question", "").lower()]

    for item in items:
        item.pop("versions", None)
        item["versionCount"] = 0
    full_items = resp.get("Items", [])
    for idx, fi in enumerate(full_items):
        if idx < len(items):
            items[idx]["versionCount"] = len(fi.get("versions", []))

    body = {
        "Items": items,
        "NextPageToken": resp.get("LastEvaluatedKey"),
    }
    return {"statusCode": 200, "headers": headers, "body": json.dumps(body)}


def op_get(data, headers):
    qid = data.get("question_id")
    if not qid:
        return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": "question_id required"})}

    resp = table.get_item(Key={"PartitionKey": PARTITION_KEY, "QuestionId": qid})
    item = resp.get("Item")
    if not item:
        return {"statusCode": 404, "headers": headers, "body": json.dumps({"error": "Not found"})}

    return {"statusCode": 200, "headers": headers, "body": json.dumps(convert_from_decimal(item))}


def op_create(data, headers):
    question = data.get("question", "").strip()
    expected_response = strip_kb_citation_markers(data.get("expectedResponse", "").strip())
    if not question or not expected_response:
        return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": "question and expectedResponse required"})}

    action, qid = upsert_item(question, expected_response, "manual")
    return {"statusCode": 200, "headers": headers, "body": json.dumps({"action": action, "questionId": qid})}


def op_update(data, headers):
    qid = data.get("question_id")
    expected_response = strip_kb_citation_markers(data.get("expectedResponse", "").strip())
    if not qid or not expected_response:
        return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": "question_id and expectedResponse required"})}

    existing = table.get_item(Key={"PartitionKey": PARTITION_KEY, "QuestionId": qid}).get("Item")
    if not existing:
        return {"statusCode": 404, "headers": headers, "body": json.dumps({"error": "Not found"})}

    if existing.get("expectedResponse", "") == expected_response:
        return {"statusCode": 200, "headers": headers, "body": json.dumps({"action": "unchanged"})}

    versions = existing.get("versions", [])
    versions.insert(0, {
        "expectedResponse": existing.get("expectedResponse", ""),
        "source": existing.get("source", ""),
        "updatedAt": existing.get("updatedAt", existing.get("createdAt", "")),
    })

    ts = now_iso()
    table.update_item(
        Key={"PartitionKey": PARTITION_KEY, "QuestionId": qid},
        UpdateExpression="SET expectedResponse = :er, #src = :src, updatedAt = :ua, versions = :v",
        ExpressionAttributeNames={"#src": "source"},
        ExpressionAttributeValues={
            ":er": expected_response,
            ":src": "manual",
            ":ua": ts,
            ":v": versions,
        },
    )
    return {"statusCode": 200, "headers": headers, "body": json.dumps({"action": "updated"})}


def op_revert(data, headers):
    qid = data.get("question_id")
    version_index = data.get("version_index", 0)
    if not qid:
        return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": "question_id required"})}

    existing = table.get_item(Key={"PartitionKey": PARTITION_KEY, "QuestionId": qid}).get("Item")
    if not existing:
        return {"statusCode": 404, "headers": headers, "body": json.dumps({"error": "Not found"})}

    versions = existing.get("versions", [])
    if version_index < 0 or version_index >= len(versions):
        return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": "Invalid version_index"})}

    target = versions[version_index]

    new_versions = list(versions)
    new_versions.insert(0, {
        "expectedResponse": existing.get("expectedResponse", ""),
        "source": existing.get("source", ""),
        "updatedAt": existing.get("updatedAt", ""),
    })
    new_versions.pop(version_index + 1)

    ts = now_iso()
    table.update_item(
        Key={"PartitionKey": PARTITION_KEY, "QuestionId": qid},
        UpdateExpression="SET expectedResponse = :er, #src = :src, updatedAt = :ua, versions = :v",
        ExpressionAttributeNames={"#src": "source"},
        ExpressionAttributeValues={
            ":er": target["expectedResponse"],
            ":src": f"revert:{target.get('source', 'unknown')}",
            ":ua": ts,
            ":v": new_versions,
        },
    )
    return {"statusCode": 200, "headers": headers, "body": json.dumps({"action": "reverted"})}


def op_delete(data, headers):
    qid = data.get("question_id")
    if not qid:
        return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": "question_id required"})}

    table.delete_item(Key={"PartitionKey": PARTITION_KEY, "QuestionId": qid})
    return {"statusCode": 200, "headers": headers, "body": json.dumps({"action": "deleted"})}


def op_bulk_import(data, headers):
    items = data.get("items", [])
    source = data.get("source", "import")
    if not items:
        return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": "items array required"})}

    added = 0
    updated = 0
    unchanged = 0

    for item in items:
        q = item.get("question", "").strip()
        er = strip_kb_citation_markers(item.get("expectedResponse", "").strip())
        if not q or not er:
            continue
        action, _ = upsert_item(q, er, source)
        if action == "added":
            added += 1
        elif action == "updated":
            updated += 1
        else:
            unchanged += 1

    return {"statusCode": 200, "headers": headers, "body": json.dumps({"added": added, "updated": updated, "unchanged": unchanged})}


def op_export(data, headers):
    items = []
    params = {"KeyConditionExpression": Key("PartitionKey").eq(PARTITION_KEY)}
    while True:
        resp = table.query(**params)
        for item in resp.get("Items", []):
            items.append({
                "question": item.get("question", ""),
                "expectedResponse": item.get("expectedResponse", ""),
            })
        if "LastEvaluatedKey" not in resp:
            break
        params["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    return {"statusCode": 200, "headers": headers, "body": json.dumps({"items": items, "count": len(items)})}


def op_stats(data, headers):
    total = 0
    sources = {}
    params = {
        "KeyConditionExpression": Key("PartitionKey").eq(PARTITION_KEY),
        "ProjectionExpression": "#src",
        "ExpressionAttributeNames": {"#src": "source"},
    }
    while True:
        resp = table.query(**params)
        for item in resp.get("Items", []):
            total += 1
            src = item.get("source", "unknown")
            category = "manual" if src == "manual" else "upload"
            sources[category] = sources.get(category, 0) + 1
        if "LastEvaluatedKey" not in resp:
            break
        params["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    return {"statusCode": 200, "headers": headers, "body": json.dumps({"total": total, "sources": sources})}


OPERATIONS = {
    "list": op_list,
    "get": op_get,
    "create": op_create,
    "update": op_update,
    "revert": op_revert,
    "delete": op_delete,
    "bulk_import": op_bulk_import,
    "export": op_export,
    "stats": op_stats,
}


def lambda_handler(event, context):
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
    }

    if event.get("httpMethod") == "OPTIONS" or event.get("requestContext", {}).get("http", {}).get("method") == "OPTIONS":
        return {"statusCode": 200, "headers": headers, "body": ""}

    try:
        body_raw = event.get("body", "{}")
        data = json.loads(body_raw) if isinstance(body_raw, str) else body_raw or {}
        operation = data.get("operation", "")

        handler = OPERATIONS.get(operation)
        if not handler:
            return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": f"Unknown operation: {operation}"})}

        return handler(data, headers)

    except Exception as e:
        logger.error(f"Error in test-library-handler: {str(e)}")
        return {"statusCode": 500, "headers": headers, "body": json.dumps({"error": str(e)})}
