import json
import os
import logging

import boto3
from boto3.dynamodb.conditions import Key

logger = logging.getLogger()
logger.setLevel(logging.INFO)

scheduler = boto3.client("scheduler")
lambda_client = boto3.client("lambda")
s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

SCHEDULE_NAME = os.environ["SCHEDULE_NAME"]
SCHEDULE_GROUP = os.environ["SCHEDULE_GROUP"]
STAGING_BUCKET = os.environ["STAGING_BUCKET"]
INDEX_REGISTRY_TABLE = os.environ["INDEX_REGISTRY_TABLE"]
SYNC_HISTORY_TABLE = os.environ["SYNC_HISTORY_TABLE"]
ORCHESTRATOR_LAMBDA_ARN = os.environ["ORCHESTRATOR_LAMBDA_ARN"]

history_table = dynamodb.Table(SYNC_HISTORY_TABLE)
registry_table = dynamodb.Table(INDEX_REGISTRY_TABLE)

CORS_HEADERS = {"Access-Control-Allow-Origin": "*"}

DAYS_OF_WEEK = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
DAY_LABELS = {
    "SUN": "Sunday", "MON": "Monday", "TUE": "Tuesday", "WED": "Wednesday",
    "THU": "Thursday", "FRI": "Friday", "SAT": "Saturday",
}


def _check_admin(event):
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
        roles = json.loads(claims["custom:role"])
        if not any("Admin" in role for role in roles):
            return False
    except Exception:
        return False
    return True


def _ok(body):
    return {"statusCode": 200, "headers": CORS_HEADERS, "body": json.dumps(body)}


def _err(status, msg):
    return {"statusCode": status, "headers": CORS_HEADERS, "body": json.dumps({"error": msg})}


def _parse_cron(schedule_expr: str) -> dict | None:
    """Parse 'cron(M H ? * DOW *)' into {minute, hour, dayOfWeek}."""
    if not schedule_expr.startswith("cron("):
        return None
    inner = schedule_expr[5:-1]
    parts = inner.split()
    if len(parts) < 5:
        return None
    return {"minute": int(parts[0]), "hour": int(parts[1]), "dayOfWeek": parts[4]}


def _build_cron(day_of_week: str, hour: int, minute: int) -> str:
    return f"cron({minute} {hour} ? * {day_of_week} *)"


def _human_schedule(cron_parts: dict) -> str:
    h = cron_parts["hour"]
    m = cron_parts["minute"]
    h_et = (h - 5) % 24
    ampm = "AM" if h_et < 12 else "PM"
    h12 = h_et % 12 or 12
    day = DAY_LABELS.get(cron_parts["dayOfWeek"], cron_parts["dayOfWeek"])
    time_str = f"{h12}:{m:02d} {ampm} ET"
    return f"Every {day} at {time_str}"


def handle_get_schedule(event):
    try:
        resp = scheduler.get_schedule(Name=SCHEDULE_NAME, GroupName=SCHEDULE_GROUP)
        expr = resp.get("ScheduleExpression", "")
        state = resp.get("State", "ENABLED")
        cron_parts = _parse_cron(expr)

        body = {
            "scheduleExpression": expr,
            "state": state,
            "enabled": state == "ENABLED",
        }
        if cron_parts:
            body["dayOfWeek"] = cron_parts["dayOfWeek"]
            body["hourUtc"] = cron_parts["hour"]
            body["minute"] = cron_parts["minute"]
            body["humanReadable"] = _human_schedule(cron_parts)

        return _ok(body)
    except scheduler.exceptions.ResourceNotFoundException:
        return _ok({"enabled": False, "state": "NOT_FOUND"})
    except Exception as e:
        logger.error("Error getting schedule: %s", e, exc_info=True)
        return _err(500, str(e))


def handle_put_schedule(event):
    try:
        body = json.loads(event.get("body", "{}"))
    except (json.JSONDecodeError, TypeError):
        return _err(400, "Invalid JSON body")

    day = body.get("dayOfWeek", "SUN").upper()
    if day not in DAYS_OF_WEEK:
        return _err(400, f"Invalid dayOfWeek: {day}")

    hour_utc = int(body.get("hourUtc", 6))
    minute = int(body.get("minute", 0))
    if not (0 <= hour_utc <= 23) or not (0 <= minute <= 59):
        return _err(400, "Invalid hour/minute")

    enabled = body.get("enabled", True)
    cron_expr = _build_cron(day, hour_utc, minute)

    try:
        current = scheduler.get_schedule(Name=SCHEDULE_NAME, GroupName=SCHEDULE_GROUP)
        scheduler.update_schedule(
            Name=SCHEDULE_NAME,
            GroupName=SCHEDULE_GROUP,
            ScheduleExpression=cron_expr,
            ScheduleExpressionTimezone="UTC",
            State="ENABLED" if enabled else "DISABLED",
            FlexibleTimeWindow={"Mode": "OFF"},
            Target=current["Target"],
        )
    except Exception as e:
        logger.error("Error updating schedule: %s", e, exc_info=True)
        return _err(500, str(e))

    cron_parts = {"dayOfWeek": day, "hour": hour_utc, "minute": minute}
    return _ok({
        "scheduleExpression": cron_expr,
        "state": "ENABLED" if enabled else "DISABLED",
        "enabled": enabled,
        "dayOfWeek": day,
        "hourUtc": hour_utc,
        "minute": minute,
        "humanReadable": _human_schedule(cron_parts),
    })


def handle_get_destinations(event):
    indexes = []
    try:
        resp = registry_table.scan(
            FilterExpression=Key("sk").eq("META"),
        )
        for item in resp.get("Items", []):
            indexes.append({
                "indexName": item["pk"],
                "displayName": item.get("display_name", item["pk"]),
                "path": f"s3://{STAGING_BUCKET}/indexes/{item['pk']}/latest.xlsx",
            })
    except Exception as e:
        logger.error("Error reading index registry: %s", e, exc_info=True)

    staged_docs = 0
    try:
        resp = s3.list_objects_v2(Bucket=STAGING_BUCKET, Prefix="documents/", MaxKeys=1000)
        staged_docs = sum(1 for o in resp.get("Contents", []) if not o["Key"].endswith("/"))
    except Exception:
        pass

    return _ok({
        "stagingBucket": STAGING_BUCKET,
        "kbDocuments": {
            "path": f"s3://{STAGING_BUCKET}/documents/",
            "stagedCount": staged_docs,
        },
        "indexes": indexes,
    })


def handle_get_history(event):
    limit = 20
    try:
        qs = event.get("queryStringParameters") or {}
        if "limit" in qs:
            limit = min(int(qs["limit"]), 100)
    except Exception:
        pass

    try:
        resp = history_table.query(
            KeyConditionExpression=Key("pk").eq("RUN"),
            ScanIndexForward=False,
            Limit=limit,
        )
        items = resp.get("Items", [])
        for item in items:
            for k in ("kbDocsCount", "indexFilesCount", "durationMs", "expiresAt"):
                if k in item:
                    item[k] = int(item[k])
        return _ok({"runs": items})
    except Exception as e:
        logger.error("Error querying sync history: %s", e, exc_info=True)
        return _err(500, str(e))


def handle_sync_now(event):
    try:
        lambda_client.invoke(
            FunctionName=ORCHESTRATOR_LAMBDA_ARN,
            InvocationType="Event",
        )
        return _ok({"status": "STARTED"})
    except Exception as e:
        logger.error("Error invoking orchestrator: %s", e, exc_info=True)
        return _err(500, str(e))


def lambda_handler(event, context):
    path = event.get("rawPath", "")
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    logger.info("sync-schedule: %s %s", method, path)

    if not _check_admin(event):
        return _err(403, "Admin access required")

    if "sync-schedule" in path:
        if method == "PUT":
            return handle_put_schedule(event)
        return handle_get_schedule(event)
    elif "sync-destinations" in path:
        return handle_get_destinations(event)
    elif "sync-history" in path:
        return handle_get_history(event)
    elif "sync-now" in path:
        return handle_sync_now(event)
    else:
        return _err(404, "Unknown endpoint")
