import os
import boto3
from boto3.dynamodb.conditions import Key
import json
from datetime import datetime, timedelta, timezone
from collections import defaultdict
from decimal import Decimal

DDB_TABLE_NAME = os.environ["DDB_TABLE_NAME"]
ANALYTICS_TABLE_NAME = os.environ.get("ANALYTICS_TABLE_NAME", "")

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(DDB_TABLE_NAME)
analytics_table = dynamodb.Table(ANALYTICS_TABLE_NAME) if ANALYTICS_TABLE_NAME else None


class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return float(o)
        return super().default(o)


def get_unique_users_count():
    try:
        unique_users = set()
        last_evaluated_key = None
        while True:
            params = {"ProjectionExpression": "user_id"}
            if last_evaluated_key:
                params["ExclusiveStartKey"] = last_evaluated_key
            response = table.scan(**params)
            for item in response.get("Items", []):
                unique_users.add(item["user_id"])
            last_evaluated_key = response.get("LastEvaluatedKey")
            if not last_evaluated_key:
                break
        return len(unique_users)
    except Exception as e:
        print(f"Error getting unique users count: {e}")
        return 0


def parse_timestamp(timestamp_str):
    if not timestamp_str:
        return None
    try:
        if "T" in timestamp_str:
            return datetime.fromisoformat(timestamp_str.replace("Z", "+00:00").split(".")[0])
        return datetime.strptime(timestamp_str.split(".")[0], "%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def get_traffic_metrics():
    try:
        total_sessions = 0
        total_messages = 0
        daily_stats = defaultdict(lambda: {"sessions": 0, "messages": 0})
        unique_users_daily = defaultdict(set)
        hourly_counts = defaultdict(int)
        session_msg_counts = []

        last_evaluated_key = None
        while True:
            params = {}
            if last_evaluated_key:
                params["ExclusiveStartKey"] = last_evaluated_key
            response = table.scan(**params)

            for item in response.get("Items", []):
                total_sessions += 1
                chat_history = item.get("chat_history", [])
                message_count = len(chat_history)
                total_messages += message_count
                session_msg_counts.append(message_count)

                dt = parse_timestamp(item.get("time_stamp", ""))
                if dt:
                    date_key = dt.strftime("%Y-%m-%d")
                    daily_stats[date_key]["sessions"] += 1
                    daily_stats[date_key]["messages"] += message_count
                    unique_users_daily[date_key].add(item.get("user_id"))
                    hourly_counts[dt.hour] += 1

            last_evaluated_key = response.get("LastEvaluatedKey")
            if not last_evaluated_key:
                break

        daily_breakdown = []
        for date, stats in sorted(daily_stats.items()):
            daily_breakdown.append({
                "date": date,
                "sessions": stats["sessions"],
                "messages": stats["messages"],
                "unique_users": len(unique_users_daily[date]),
            })

        avg_messages_per_session = (
            round(sum(session_msg_counts) / len(session_msg_counts), 1)
            if session_msg_counts else 0
        )

        peak_hour = max(hourly_counts, key=hourly_counts.get) if hourly_counts else None
        peak_hour_label = f"{peak_hour:02d}:00-{peak_hour+1:02d}:00" if peak_hour is not None else "N/A"

        return {
            "total_sessions": total_sessions,
            "total_messages": total_messages,
            "daily_breakdown": daily_breakdown,
            "avg_messages_per_session": avg_messages_per_session,
            "peak_hour": peak_hour_label,
            "hourly_distribution": [
                {"hour": f"{h:02d}:00", "sessions": hourly_counts.get(h, 0)}
                for h in range(24)
            ],
        }
    except Exception as e:
        print(f"Error getting traffic metrics: {e}")
        return {
            "total_sessions": 0,
            "total_messages": 0,
            "daily_breakdown": [],
            "avg_messages_per_session": 0,
            "peak_hour": "N/A",
            "hourly_distribution": [],
        }


def get_faq_insights(days=30):
    if not analytics_table:
        return {"topics": [], "total_classified": 0}

    try:
        start_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
        topic_counts = defaultdict(int)
        topic_samples = defaultdict(list)
        total = 0

        last_evaluated_key = None
        while True:
            params = {
                "IndexName": "DateIndex",
                "KeyConditionExpression": Key("date_key").gte(start_date),
                "ScanIndexForward": False,
            }
            if last_evaluated_key:
                params["ExclusiveStartKey"] = last_evaluated_key

            # DateIndex has date_key as PK -- need to scan dates in range
            # Since we can't do >= on a partition key, scan and filter instead
            scan_params = {
                "FilterExpression": Key("date_key").gte(start_date),
            }
            if last_evaluated_key:
                scan_params["ExclusiveStartKey"] = last_evaluated_key
            response = analytics_table.scan(**scan_params)

            for item in response.get("Items", []):
                topic = item.get("topic", "Other")
                question = item.get("question", "")
                topic_counts[topic] += 1
                total += 1
                if len(topic_samples[topic]) < 5:
                    topic_samples[topic].append(question)

            last_evaluated_key = response.get("LastEvaluatedKey")
            if not last_evaluated_key:
                break

        topics = sorted(
            [
                {
                    "topic": topic,
                    "count": count,
                    "sample_questions": topic_samples[topic],
                }
                for topic, count in topic_counts.items()
            ],
            key=lambda x: x["count"],
            reverse=True,
        )

        return {"topics": topics[:20], "total_classified": total}
    except Exception as e:
        print(f"Error getting FAQ insights: {e}")
        return {"topics": [], "total_classified": 0}


def lambda_handler(event, context):
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
    }

    admin = False
    try:
        claims = (
            event.get("requestContext", {})
            .get("authorizer", {})
            .get("jwt", {})
            .get("claims", {})
        )
        if claims:
            roles = json.loads(claims.get("custom:role", "[]"))
            if any("Admin" in role for role in roles):
                admin = True
    except Exception as e:
        print(f"Error checking admin status: {e}")

    http_method = event.get("routeKey", "")
    if "OPTIONS" in http_method:
        return {"statusCode": 200, "headers": headers, "body": json.dumps({})}

    if "GET" not in http_method:
        return {"statusCode": 405, "headers": headers, "body": json.dumps("Method Not Allowed")}

    if not admin:
        return {"statusCode": 403, "headers": headers, "body": json.dumps("Forbidden: Admin access required")}

    try:
        qs = event.get("queryStringParameters") or {}
        metric_type = qs.get("type", "overview")
        days = int(qs.get("days", "30"))

        if metric_type == "faq":
            response_data = get_faq_insights(days)
        elif metric_type == "traffic":
            traffic = get_traffic_metrics()
            response_data = {
                "daily_breakdown": traffic["daily_breakdown"],
                "hourly_distribution": traffic["hourly_distribution"],
                "avg_messages_per_session": traffic["avg_messages_per_session"],
                "peak_hour": traffic["peak_hour"],
            }
        else:
            unique_users = get_unique_users_count()
            traffic = get_traffic_metrics()
            response_data = {
                "unique_users": unique_users,
                "total_sessions": traffic["total_sessions"],
                "total_messages": traffic["total_messages"],
                "daily_breakdown": traffic["daily_breakdown"],
                "avg_messages_per_session": traffic["avg_messages_per_session"],
                "peak_hour": traffic["peak_hour"],
            }

        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps(response_data, cls=DecimalEncoder),
        }
    except Exception as e:
        print(f"Error in lambda_handler: {e}")
        import traceback
        traceback.print_exc()
        return {
            "statusCode": 500,
            "headers": headers,
            "body": json.dumps({"message": "Failed to retrieve metrics"}),
        }
