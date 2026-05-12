import json
import os
import logging
from datetime import datetime, time, timedelta, timezone

import boto3
from boto3.dynamodb.conditions import Key
from zoneinfo import ZoneInfo

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

# EventBridge scheduler DOW tokens
DAYS_OF_WEEK = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
DAY_LABELS = {
    "SUN": "Sunday",
    "MON": "Monday",
    "TUE": "Tuesday",
    "WED": "Wednesday",
    "THU": "Thursday",
    "FRI": "Friday",
    "SAT": "Saturday",
}

# Python date.weekday(): Monday=0 … Sunday=6
_AWS_DOW_TO_PY = {
    "MON": 0,
    "TUE": 1,
    "WED": 2,
    "THU": 3,
    "FRI": 4,
    "SAT": 5,
    "SUN": 6,
}
_PY_TO_AWS_DOW = {v: k for k, v in _AWS_DOW_TO_PY.items()}

TARGET_SCHEDULE_TZ = "America/New_York"


def _check_admin(event):
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
        roles = json.loads(claims["custom:role"])
        if "Admin" not in roles:
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


def _human_local_eastern(cron_parts: dict) -> str:
    h = cron_parts["hour"]
    m = cron_parts["minute"]
    day = DAY_LABELS.get(cron_parts["dayOfWeek"], cron_parts["dayOfWeek"])
    return f"Every {day} at {h:02d}:{m:02d} Eastern Time"


def _next_utc_cron_instant(aws_dow: str, hour: int, minute: int) -> datetime:
    """Next fire time for a weekly rule that is expressed in UTC (legacy)."""
    py_w = _AWS_DOW_TO_PY[aws_dow]
    now = datetime.now(timezone.utc)
    today = now.date()
    for d in range(0, 8 * 7):
        cand_d = today + timedelta(days=d)
        if cand_d.weekday() != py_w:
            continue
        t = datetime.combine(cand_d, time(hour, minute, tzinfo=timezone.utc))
        if t > now:
            return t
    return now + timedelta(days=7)


def _legacy_utc_body(cron_parts: dict) -> dict:
    nxt = _next_utc_cron_instant(
        cron_parts["dayOfWeek"], cron_parts["hour"], cron_parts["minute"]
    )
    ny = nxt.astimezone(ZoneInfo(TARGET_SCHEDULE_TZ))
    aws_dow_ny = _PY_TO_AWS_DOW[ny.weekday()]
    human = (
        f"Every {DAY_LABELS[cron_parts['dayOfWeek']]} at "
        f"{cron_parts['hour']:02d}:{cron_parts['minute']:02d} UTC "
        f"(next run in Eastern: {ny.strftime('%b %d, %Y %I:%M %p %Z')})"
    )
    return {
        "dayOfWeek": aws_dow_ny,
        "hour": ny.hour,
        "minute": ny.minute,
        "hourUtc": cron_parts["hour"],
        "minuteUtc": cron_parts["minute"],
        "dayOfWeekUtc": cron_parts["dayOfWeek"],
        "scheduleTimezone": "UTC",
        "legacyUtc": True,
        "humanReadable": human,
    }


def handle_get_schedule(event):
    try:
        resp = scheduler.get_schedule(Name=SCHEDULE_NAME, GroupName=SCHEDULE_GROUP)
        expr = resp.get("ScheduleExpression", "")
        state = resp.get("State", "ENABLED")
        sched_tz = resp.get("ScheduleExpressionTimezone") or "UTC"
        cron_parts = _parse_cron(expr)

        body: dict = {
            "scheduleExpression": expr,
            "state": state,
            "enabled": state == "ENABLED",
            "scheduleTimezone": sched_tz,
        }

        if not cron_parts:
            return _ok(body)

        if sched_tz == TARGET_SCHEDULE_TZ:
            body["dayOfWeek"] = cron_parts["dayOfWeek"]
            body["hour"] = cron_parts["hour"]
            body["minute"] = cron_parts["minute"]
            body["humanReadable"] = _human_local_eastern(cron_parts)
        else:
            # Legacy UTC — show next run in Eastern so the form matches history formatting
            leg = _legacy_utc_body(cron_parts)
            body.update(leg)

        return _ok(body)
    except scheduler.exceptions.ResourceNotFoundException:
        return _ok({"enabled": False, "state": "NOT_FOUND"})
    except Exception as e:
        logger.error("Error getting schedule: %s", e, exc_info=True)
        return _err(500, str(e))


def handle_put_schedule(event):
    try:
        body_in = json.loads(event.get("body", "{}"))
    except (json.JSONDecodeError, TypeError):
        return _err(400, "Invalid JSON body")

    day = body_in.get("dayOfWeek", "SUN").upper()
    if day not in DAYS_OF_WEEK:
        return _err(400, f"Invalid dayOfWeek: {day}")

    hour = int(body_in.get("hour", 1))
    minute = int(body_in.get("minute", 0))
    if not (0 <= hour <= 23) or not (0 <= minute <= 59):
        return _err(400, "Invalid hour/minute")

    enabled = body_in.get("enabled", True)
    cron_expr = _build_cron(day, hour, minute)

    try:
        current = scheduler.get_schedule(Name=SCHEDULE_NAME, GroupName=SCHEDULE_GROUP)
        scheduler.update_schedule(
            Name=SCHEDULE_NAME,
            GroupName=SCHEDULE_GROUP,
            ScheduleExpression=cron_expr,
            ScheduleExpressionTimezone=TARGET_SCHEDULE_TZ,
            State="ENABLED" if enabled else "DISABLED",
            FlexibleTimeWindow={"Mode": "OFF"},
            Target=current["Target"],
        )
    except Exception as e:
        logger.error("Error updating schedule: %s", e, exc_info=True)
        return _err(500, str(e))

    cron_parts = {"dayOfWeek": day, "hour": hour, "minute": minute}
    return _ok(
        {
            "scheduleExpression": cron_expr,
            "state": "ENABLED" if enabled else "DISABLED",
            "enabled": enabled,
            "dayOfWeek": day,
            "hour": hour,
            "minute": minute,
            "scheduleTimezone": TARGET_SCHEDULE_TZ,
            "legacyUtc": False,
            "humanReadable": _human_local_eastern(cron_parts),
        }
    )


def handle_get_destinations(event):
    """Registry items use pk=TOOLS and sk=<index_name> (see excel-index/parser/tool_registry.py)."""
    indexes = []
    try:
        items = []
        resp = registry_table.query(
            KeyConditionExpression=Key("pk").eq("TOOLS"),
        )
        items.extend(resp.get("Items", []))
        while resp.get("LastEvaluatedKey"):
            resp = registry_table.query(
                KeyConditionExpression=Key("pk").eq("TOOLS"),
                ExclusiveStartKey=resp["LastEvaluatedKey"],
            )
            items.extend(resp.get("Items", []))
        for item in items:
            idx_name = item.get("index_name") or item.get("sk", "")
            if not idx_name:
                continue
            indexes.append(
                {
                    "indexName": idx_name,
                    "displayName": item.get("display_name", idx_name),
                    "path": f"s3://{STAGING_BUCKET}/indexes/{idx_name}/latest.xlsx",
                }
            )
    except Exception as e:
        logger.error("Error reading index registry: %s", e, exc_info=True)

    staged_docs = 0
    try:
        resp = s3.list_objects_v2(
            Bucket=STAGING_BUCKET, Prefix="documents/", MaxKeys=1000
        )
        staged_docs = sum(
            1 for o in resp.get("Contents", []) if not o["Key"].endswith("/")
        )
    except Exception:
        pass

    return _ok(
        {
            "stagingBucket": STAGING_BUCKET,
            "kbDocuments": {
                "path": f"s3://{STAGING_BUCKET}/documents/",
                "stagedCount": staged_docs,
            },
            "indexes": indexes,
        }
    )


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
