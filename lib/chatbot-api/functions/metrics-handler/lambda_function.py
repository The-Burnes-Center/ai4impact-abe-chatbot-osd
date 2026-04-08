import json
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import boto3
from boto3.dynamodb.conditions import Key

from abe_utils import DecimalJSONEncoder, get_logger, is_admin_request, json_response, safe_int


DDB_TABLE_NAME = os.environ["DDB_TABLE_NAME"]
ANALYTICS_TABLE_NAME = os.environ.get("ANALYTICS_TABLE_NAME", "")

dynamodb = boto3.resource("dynamodb")
session_table = dynamodb.Table(DDB_TABLE_NAME)
analytics_table = dynamodb.Table(ANALYTICS_TABLE_NAME) if ANALYTICS_TABLE_NAME else None
logger = get_logger(__name__)


def parse_timestamp(timestamp_str):
    if not timestamp_str:
        return None
    try:
        if "T" in timestamp_str:
            return datetime.fromisoformat(timestamp_str.replace("Z", "+00:00").split(".")[0])
        return datetime.strptime(timestamp_str.split(".")[0], "%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def get_user_display_map():
    """Scan AnalyticsTable to build user_id -> {display_name, agency} mapping."""
    if not analytics_table:
        return {}
    user_map = {}
    last_key = None
    while True:
        params = {"ProjectionExpression": "user_id, display_name, agency"}
        if last_key:
            params["ExclusiveStartKey"] = last_key
        response = analytics_table.scan(**params)
        for item in response.get("Items", []):
            uid = item.get("user_id")
            if uid and uid not in user_map:
                dn = item.get("display_name", "")
                ag = item.get("agency", "")
                if dn or ag:
                    user_map[uid] = {"display_name": dn, "agency": ag}
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
    return user_map


def summarize_session_metrics():
    unique_users = set()
    total_sessions = 0
    total_messages = 0
    daily_stats = defaultdict(lambda: {"sessions": 0, "messages": 0})
    unique_users_daily = defaultdict(set)
    daily_user_sessions = defaultdict(lambda: defaultdict(int))
    daily_user_messages = defaultdict(lambda: defaultdict(int))
    hourly_counts = defaultdict(int)
    session_msg_counts = []

    last_evaluated_key = None
    while True:
        params = {"ProjectionExpression": "user_id, chat_history, time_stamp"}
        if last_evaluated_key:
            params["ExclusiveStartKey"] = last_evaluated_key
        response = session_table.scan(**params)

        for item in response.get("Items", []):
            user_id = item.get("user_id")
            if user_id:
                unique_users.add(user_id)

            total_sessions += 1
            chat_history = item.get("chat_history", [])
            message_count = len(chat_history)
            total_messages += message_count
            session_msg_counts.append(message_count)

            dt = parse_timestamp(item.get("time_stamp", ""))
            if not dt:
                continue
            date_key = dt.strftime("%Y-%m-%d")
            daily_stats[date_key]["sessions"] += 1
            daily_stats[date_key]["messages"] += message_count
            if user_id:
                unique_users_daily[date_key].add(user_id)
                daily_user_sessions[date_key][user_id] += 1
                daily_user_messages[date_key][user_id] += message_count
            hourly_counts[dt.hour] += 1

        last_evaluated_key = response.get("LastEvaluatedKey")
        if not last_evaluated_key:
            break

    user_display_map = get_user_display_map()

    daily_breakdown = []
    for date, stats in sorted(daily_stats.items()):
        day_users = []
        for uid in unique_users_daily[date]:
            info = user_display_map.get(uid, {})
            day_users.append({
                "user_id": uid,
                "display_name": info.get("display_name") or uid,
                "agency": info.get("agency") or "Unknown",
                "sessions": daily_user_sessions[date][uid],
                "messages": daily_user_messages[date][uid],
            })
        day_users.sort(key=lambda u: u["messages"], reverse=True)
        daily_breakdown.append({
            "date": date,
            "sessions": stats["sessions"],
            "messages": stats["messages"],
            "unique_users": len(unique_users_daily[date]),
            "users": day_users,
        })

    avg_messages_per_session = (
        round(sum(session_msg_counts) / len(session_msg_counts), 1)
        if session_msg_counts
        else 0
    )
    peak_hour = max(hourly_counts, key=hourly_counts.get) if hourly_counts else None
    peak_hour_label = f"{peak_hour:02d}:00-{peak_hour + 1:02d}:00" if peak_hour is not None else "N/A"

    return {
        "unique_users": len(unique_users),
        "total_sessions": total_sessions,
        "total_messages": total_messages,
        "daily_breakdown": daily_breakdown,
        "avg_messages_per_session": avg_messages_per_session,
        "peak_hour": peak_hour_label,
        "hourly_distribution": [
            {"hour": f"{hour:02d}:00", "sessions": hourly_counts.get(hour, 0)}
            for hour in range(24)
        ],
    }


def iter_date_keys(days):
    span = max(days - 1, 0)
    start_date = datetime.now(timezone.utc).date() - timedelta(days=span)
    end_date = datetime.now(timezone.utc).date()
    current = start_date
    while current <= end_date:
        yield current.strftime("%Y-%m-%d")
        current += timedelta(days=1)


def fetch_analytics_items(days=30, agency_filter=None):
    if not analytics_table:
        return []

    items = []
    if agency_filter:
        last_evaluated_key = None
        start_timestamp = (
            datetime.now(timezone.utc) - timedelta(days=max(days - 1, 0))
        ).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        while True:
            query_params = {
                "IndexName": "AgencyIndex",
                "KeyConditionExpression": Key("agency").eq(agency_filter) & Key("timestamp").gte(start_timestamp),
            }
            if last_evaluated_key:
                query_params["ExclusiveStartKey"] = last_evaluated_key
            response = analytics_table.query(**query_params)
            items.extend(response.get("Items", []))
            last_evaluated_key = response.get("LastEvaluatedKey")
            if not last_evaluated_key:
                break
        return items

    for date_key in iter_date_keys(days):
        last_evaluated_key = None
        while True:
            query_params = {
                "IndexName": "DateIndex",
                "KeyConditionExpression": Key("date_key").eq(date_key),
            }
            if last_evaluated_key:
                query_params["ExclusiveStartKey"] = last_evaluated_key
            response = analytics_table.query(**query_params)
            items.extend(response.get("Items", []))
            last_evaluated_key = response.get("LastEvaluatedKey")
            if not last_evaluated_key:
                break
    return items


def get_agency_breakdown(days=30):
    if not analytics_table:
        return {"agencies": [], "total_messages": 0}

    try:
        items = fetch_analytics_items(days)
        agency_stats = defaultdict(
            lambda: {"messages": 0, "users": set(), "topics": defaultdict(int), "daily": defaultdict(int)}
        )
        total = 0

        for item in items:
            agency = item.get("agency", "") or ""
            if not agency or agency == "Unknown":
                continue
            user_id = item.get("user_id", "")
            topic = item.get("topic", "Other")
            date_key = item.get("date_key", "")
            agency_stats[agency]["messages"] += 1
            agency_stats[agency]["users"].add(user_id)
            agency_stats[agency]["topics"][topic] += 1
            if date_key:
                agency_stats[agency]["daily"][date_key] += 1
            total += 1

        agencies = sorted(
            [
                {
                    "agency": agency,
                    "messages": stats["messages"],
                    "unique_users": len(stats["users"]),
                    "top_topics": sorted(
                        [{"topic": topic, "count": count} for topic, count in stats["topics"].items()],
                        key=lambda value: value["count"],
                        reverse=True,
                    )[:5],
                    "daily_breakdown": sorted(
                        [{"date": date, "messages": count} for date, count in stats["daily"].items()],
                        key=lambda value: value["date"],
                    ),
                }
                for agency, stats in agency_stats.items()
            ],
            key=lambda value: value["messages"],
            reverse=True,
        )
        return {"agencies": agencies, "total_messages": total}
    except Exception:
        logger.exception("Error getting agency breakdown")
        return {"agencies": [], "total_messages": 0}


def get_faq_insights(days=30, agency_filter=None):
    if not analytics_table:
        return {"topics": [], "total_classified": 0}

    try:
        items = fetch_analytics_items(days, agency_filter=agency_filter)
        topic_counts = defaultdict(int)
        topic_samples = defaultdict(list)
        topic_seen_questions = defaultdict(set)
        total = 0

        for item in items:
            topic = item.get("topic", "Other")
            question = item.get("question", "")
            display_name = item.get("display_name", "")
            agency = item.get("agency", "")
            topic_counts[topic] += 1
            total += 1

            question_key = question.strip().lower()
            if not question_key or question_key in topic_seen_questions[topic] or len(topic_samples[topic]) >= 5:
                continue

            topic_seen_questions[topic].add(question_key)
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
            key=lambda value: value["count"],
            reverse=True,
        )
        return {"topics": topics[:20], "total_classified": total}
    except Exception:
        logger.exception("Error getting FAQ insights")
        return {"topics": [], "total_classified": 0}


def get_user_breakdown(days=30):
    if not analytics_table:
        return {"users": [], "total_messages": 0}

    try:
        items = fetch_analytics_items(days)
        user_stats = defaultdict(
            lambda: {
                "messages": 0,
                "display_name": "",
                "agency": "",
                "topics": defaultdict(int),
                "questions": [],
                "seen_questions": set(),
            }
        )
        total = 0

        for item in items:
            user_id = item.get("user_id", "") or "unknown"
            display_name = item.get("display_name", "")
            agency = item.get("agency", "")
            topic = item.get("topic", "Other")
            question = item.get("question", "")
            timestamp = item.get("timestamp", "")

            user_stats[user_id]["messages"] += 1
            if display_name:
                user_stats[user_id]["display_name"] = display_name
            if agency:
                user_stats[user_id]["agency"] = agency
            user_stats[user_id]["topics"][topic] += 1

            question_key = question.strip().lower()
            if question_key and question_key not in user_stats[user_id]["seen_questions"] and len(user_stats[user_id]["questions"]) < 10:
                user_stats[user_id]["seen_questions"].add(question_key)
                user_stats[user_id]["questions"].append(
                    {"question": question, "topic": topic, "timestamp": timestamp}
                )
            total += 1

        users = sorted(
            [
                {
                    "user_id": user_id,
                    "display_name": stats["display_name"] or user_id[:20],
                    "agency": stats["agency"] or "Unknown",
                    "messages": stats["messages"],
                    "top_topics": sorted(
                        [{"topic": topic, "count": count} for topic, count in stats["topics"].items()],
                        key=lambda value: value["count"],
                        reverse=True,
                    )[:5],
                    "recent_questions": sorted(stats["questions"], key=lambda value: value["timestamp"], reverse=True),
                }
                for user_id, stats in user_stats.items()
            ],
            key=lambda value: value["messages"],
            reverse=True,
        )
        return {"users": users, "total_messages": total}
    except Exception:
        logger.exception("Error getting user breakdown")
        return {"users": [], "total_messages": 0}


def lambda_handler(event, context):
    if "OPTIONS" in event.get("routeKey", ""):
        return json_response(200, {})

    if "GET" not in event.get("routeKey", ""):
        return json_response(405, "Method Not Allowed")

    if not is_admin_request(event):
        return json_response(403, "Forbidden: Admin access required")

    try:
        query_params = event.get("queryStringParameters") or {}
        metric_type = query_params.get("type", "overview")
        days = safe_int(query_params.get("days"), 30, minimum=1, maximum=365)
        agency_filter = query_params.get("agency")

        if metric_type == "faq":
            response_data = get_faq_insights(days, agency_filter=agency_filter)
        elif metric_type == "traffic":
            session_metrics = summarize_session_metrics()
            response_data = {
                "daily_breakdown": session_metrics["daily_breakdown"],
                "hourly_distribution": session_metrics["hourly_distribution"],
                "avg_messages_per_session": session_metrics["avg_messages_per_session"],
                "peak_hour": session_metrics["peak_hour"],
            }
        elif metric_type == "by_agency":
            response_data = get_agency_breakdown(days)
        elif metric_type == "by_user":
            response_data = get_user_breakdown(days)
        else:
            session_metrics = summarize_session_metrics()
            response_data = {
                "unique_users": session_metrics["unique_users"],
                "total_sessions": session_metrics["total_sessions"],
                "total_messages": session_metrics["total_messages"],
                "daily_breakdown": session_metrics["daily_breakdown"],
                "avg_messages_per_session": session_metrics["avg_messages_per_session"],
                "peak_hour": session_metrics["peak_hour"],
            }

        return json_response(200, response_data, encoder=DecimalJSONEncoder)
    except Exception:
        logger.exception("Error in metrics handler")
        return json_response(500, {"message": "Failed to retrieve metrics"})
