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


def _scan_analytics(start_date):
    """Scan analytics table for records on or after start_date. Returns list of items."""
    items = []
    last_evaluated_key = None
    while True:
        scan_params = {"FilterExpression": Key("date_key").gte(start_date)}
        if last_evaluated_key:
            scan_params["ExclusiveStartKey"] = last_evaluated_key
        response = analytics_table.scan(**scan_params)
        items.extend(response.get("Items", []))
        last_evaluated_key = response.get("LastEvaluatedKey")
        if not last_evaluated_key:
            break
    return items


def get_agency_breakdown(days=30):
    """Aggregate analytics by agency (excludes Unknown). Returns message counts, unique users, top topics."""
    if not analytics_table:
        return {"agencies": [], "total_messages": 0}

    try:
        start_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
        items = _scan_analytics(start_date)

        agency_stats = defaultdict(lambda: {
            "messages": 0, "users": set(), "topics": defaultdict(int), "daily": defaultdict(int),
        })
        total = 0

        for item in items:
            ag = item.get("agency", "") or ""
            if not ag or ag == "Unknown":
                continue
            uid = item.get("user_id", "")
            topic = item.get("topic", "Other")
            date_key = item.get("date_key", "")
            agency_stats[ag]["messages"] += 1
            agency_stats[ag]["users"].add(uid)
            agency_stats[ag]["topics"][topic] += 1
            if date_key:
                agency_stats[ag]["daily"][date_key] += 1
            total += 1

        agencies = sorted(
            [
                {
                    "agency": ag,
                    "messages": stats["messages"],
                    "unique_users": len(stats["users"]),
                    "top_topics": sorted(
                        [{"topic": t, "count": c} for t, c in stats["topics"].items()],
                        key=lambda x: x["count"], reverse=True,
                    )[:5],
                    "daily_breakdown": sorted(
                        [{"date": d, "messages": c} for d, c in stats["daily"].items()],
                        key=lambda x: x["date"],
                    ),
                }
                for ag, stats in agency_stats.items()
            ],
            key=lambda x: x["messages"], reverse=True,
        )

        return {"agencies": agencies, "total_messages": total}
    except Exception as e:
        print(f"Error getting agency breakdown: {e}")
        return {"agencies": [], "total_messages": 0}


def get_faq_insights(days=30, agency_filter=None):
    if not analytics_table:
        return {"topics": [], "total_classified": 0}

    try:
        start_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
        topic_counts = defaultdict(int)
        topic_samples = defaultdict(list)
        topic_seen_questions = defaultdict(set)
        total = 0

        if agency_filter:
            items = []
            last_evaluated_key = None
            while True:
                query_params = {
                    "IndexName": "AgencyIndex",
                    "KeyConditionExpression": Key("agency").eq(agency_filter) & Key("timestamp").gte(start_date),
                }
                if last_evaluated_key:
                    query_params["ExclusiveStartKey"] = last_evaluated_key
                response = analytics_table.query(**query_params)
                items.extend(response.get("Items", []))
                last_evaluated_key = response.get("LastEvaluatedKey")
                if not last_evaluated_key:
                    break
        else:
            items = _scan_analytics(start_date)

        for item in items:
            topic = item.get("topic", "Other")
            question = item.get("question", "")
            display_name = item.get("display_name", "")
            agency = item.get("agency", "")
            topic_counts[topic] += 1
            total += 1
            q_lower = question.strip().lower()
            if q_lower and q_lower not in topic_seen_questions[topic] and len(topic_samples[topic]) < 5:
                topic_seen_questions[topic].add(q_lower)
                sample = {"question": question}
                if display_name:
                    sample["display_name"] = display_name
                if agency:
                    sample["agency"] = agency
                topic_samples[topic].append(sample)

        topics = sorted(
            [
                {
                    "topic": topic,
                    "count": count,
                    "sample_questions": topic_samples[topic],
                }
                for topic, count in topic_counts.items()
            ],
            key=lambda x: x["count"], reverse=True,
        )

        return {"topics": topics[:20], "total_classified": total}
    except Exception as e:
        print(f"Error getting FAQ insights: {e}")
        return {"topics": [], "total_classified": 0}


def get_user_breakdown(days=30):
    """Per-user analytics: message count, agency, topics, recent questions."""
    if not analytics_table:
        return {"users": [], "total_messages": 0}

    try:
        start_date = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
        items = _scan_analytics(start_date)

        user_stats = defaultdict(lambda: {
            "messages": 0, "display_name": "", "agency": "",
            "topics": defaultdict(int), "questions": [],
            "seen_questions": set(),
        })
        total = 0

        for item in items:
            uid = item.get("user_id", "") or "unknown"
            display_name = item.get("display_name", "")
            agency = item.get("agency", "")
            topic = item.get("topic", "Other")
            question = item.get("question", "")
            timestamp = item.get("timestamp", "")

            user_stats[uid]["messages"] += 1
            if display_name:
                user_stats[uid]["display_name"] = display_name
            if agency:
                user_stats[uid]["agency"] = agency
            user_stats[uid]["topics"][topic] += 1
            q_lower = question.strip().lower()
            if q_lower and q_lower not in user_stats[uid]["seen_questions"] and len(user_stats[uid]["questions"]) < 10:
                user_stats[uid]["seen_questions"].add(q_lower)
                user_stats[uid]["questions"].append({
                    "question": question, "topic": topic, "timestamp": timestamp,
                })
            total += 1

        users = sorted(
            [
                {
                    "user_id": uid,
                    "display_name": stats["display_name"] or uid[:20],
                    "agency": stats["agency"] or "Unknown",
                    "messages": stats["messages"],
                    "top_topics": sorted(
                        [{"topic": t, "count": c} for t, c in stats["topics"].items()],
                        key=lambda x: x["count"], reverse=True,
                    )[:5],
                    "recent_questions": sorted(
                        stats["questions"], key=lambda x: x["timestamp"], reverse=True,
                    ),
                }
                for uid, stats in user_stats.items()
            ],
            key=lambda x: x["messages"], reverse=True,
        )

        return {"users": users, "total_messages": total}
    except Exception as e:
        print(f"Error getting user breakdown: {e}")
        return {"users": [], "total_messages": 0}


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
        agency_filter = qs.get("agency", None)

        if metric_type == "faq":
            response_data = get_faq_insights(days, agency_filter=agency_filter)
        elif metric_type == "traffic":
            traffic = get_traffic_metrics()
            response_data = {
                "daily_breakdown": traffic["daily_breakdown"],
                "hourly_distribution": traffic["hourly_distribution"],
                "avg_messages_per_session": traffic["avg_messages_per_session"],
                "peak_hour": traffic["peak_hour"],
            }
        elif metric_type == "by_agency":
            response_data = get_agency_breakdown(days)
        elif metric_type == "by_user":
            response_data = get_user_breakdown(days)
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
