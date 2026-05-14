import json
import os
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import boto3
from boto3.dynamodb.conditions import Key

from abe_utils import DecimalJSONEncoder, get_logger, is_admin_request, json_response, safe_int


DDB_TABLE_NAME = os.environ["DDB_TABLE_NAME"]
ANALYTICS_TABLE_NAME = os.environ.get("ANALYTICS_TABLE_NAME", "")

dynamodb = boto3.resource("dynamodb")
session_table = dynamodb.Table(DDB_TABLE_NAME)
analytics_table = dynamodb.Table(ANALYTICS_TABLE_NAME) if ANALYTICS_TABLE_NAME else None
logger = get_logger(__name__)

# Admins are in MA — display hours/days in Eastern. Timestamps are stored in UTC.
LOCAL_TZ = ZoneInfo("America/New_York")
MAX_LOOKBACK_DAYS = 365

# Users whose display_name doesn't yield a parseable agency are still real users
# we want to count. Surface them as a real bucket so the per-agency rows add up
# to the all-agencies total, instead of silently disappearing.
UNSPECIFIED_AGENCY = "Unspecified"


def _is_unspecified_agency(agency):
    return not agency or agency == "Unknown" or agency == UNSPECIFIED_AGENCY


def parse_timestamp(timestamp_str):
    if not timestamp_str:
        return None
    try:
        if "T" in timestamp_str:
            return datetime.fromisoformat(timestamp_str.replace("Z", "+00:00").split(".")[0])
        return datetime.strptime(timestamp_str.split(".")[0], "%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def _to_local(dt):
    """Normalize a datetime to America/New_York. Naive timestamps are assumed UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(LOCAL_TZ)


def parse_iso_date(value, fallback=None):
    if not value:
        return fallback
    try:
        return date.fromisoformat(value[:10])
    except Exception:
        return fallback


def resolve_date_range(query_params):
    """
    Resolve a (start_date, end_date) inclusive pair in ET.
    Precedence: explicit from/to > days > default 30.
    """
    today_local = datetime.now(LOCAL_TZ).date()
    from_param = query_params.get("from")
    to_param = query_params.get("to")
    if from_param or to_param:
        end = parse_iso_date(to_param, today_local) or today_local
        start = parse_iso_date(from_param, end - timedelta(days=29)) or (end - timedelta(days=29))
        if start > end:
            start, end = end, start
        span = (end - start).days + 1
        if span > MAX_LOOKBACK_DAYS:
            start = end - timedelta(days=MAX_LOOKBACK_DAYS - 1)
        return start, end

    days = safe_int(query_params.get("days"), 30, minimum=1, maximum=MAX_LOOKBACK_DAYS)
    end = today_local
    start = end - timedelta(days=days - 1)
    return start, end


def resolve_hour_window(query_params):
    """Optional hour-of-day window in local time. Returns (None, None) if not provided."""
    hf = query_params.get("hour_from")
    ht = query_params.get("hour_to")
    if hf is None and ht is None:
        return None, None
    hour_from = safe_int(hf, 0, minimum=0, maximum=23)
    hour_to = safe_int(ht, 23, minimum=0, maximum=23)
    if hour_from > hour_to:
        hour_from, hour_to = hour_to, hour_from
    return hour_from, hour_to


def iter_date_keys(start_date, end_date):
    current = start_date
    while current <= end_date:
        yield current.strftime("%Y-%m-%d")
        current += timedelta(days=1)


def _item_in_local_window(item, start_date, end_date, hour_from, hour_to):
    """Filter an analytics item by ET-converted day and (optional) hour window."""
    ts = parse_timestamp(item.get("timestamp", ""))
    if ts is None:
        # Fall back to the stored date_key (UTC) if timestamp is unparseable.
        return True
    local = _to_local(ts)
    local_day = local.date()
    if local_day < start_date or local_day > end_date:
        return False
    if hour_from is not None and not (hour_from <= local.hour <= hour_to):
        return False
    return True


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


def summarize_session_metrics(start_date=None, end_date=None, hour_from=None, hour_to=None, agency_filter=None):
    """
    Aggregate ChatHistoryTable activity. Days, hours, and weekdays are bucketed in ET so that
    "9 AM" reads as Eastern for MA admins. start_date / end_date / hour window / agency are
    optional; if omitted, all data is summarized.

    ChatHistoryTable has no agency column — when agency_filter is set we look up the user→agency
    map from AnalyticsTable and skip sessions whose user_id isn't in that agency. The special
    UNSPECIFIED_AGENCY bucket captures users with no parseable agency (empty/Unknown) AND
    users who don't appear in AnalyticsTable at all — so the per-agency counts sum to the
    all-agencies total.
    """
    user_display_map = get_user_display_map()
    if agency_filter == UNSPECIFIED_AGENCY:
        # We can't pre-compute this without knowing which user_ids exist in sessions —
        # filter inline below by checking the user's mapped agency (or its absence).
        allowed_user_ids = "unspecified"  # sentinel
    elif agency_filter:
        allowed_user_ids = {
            uid for uid, info in user_display_map.items()
            if info.get("agency") == agency_filter
        }
    else:
        allowed_user_ids = None

    unique_users = set()
    total_sessions = 0
    total_messages = 0
    daily_stats = defaultdict(lambda: {"sessions": 0, "messages": 0})
    unique_users_daily = defaultdict(set)
    daily_user_sessions = defaultdict(lambda: defaultdict(int))
    daily_user_messages = defaultdict(lambda: defaultdict(int))
    hourly_counts = defaultdict(int)
    # 24 hours x 7 weekdays (Mon=0..Sun=6) message volume, used by the heatmap.
    hour_by_weekday = [[0] * 7 for _ in range(24)]
    session_msg_counts = []

    last_evaluated_key = None
    while True:
        params = {"ProjectionExpression": "user_id, chat_history, time_stamp"}
        if last_evaluated_key:
            params["ExclusiveStartKey"] = last_evaluated_key
        response = session_table.scan(**params)

        for item in response.get("Items", []):
            dt = parse_timestamp(item.get("time_stamp", ""))
            if not dt:
                continue
            local = _to_local(dt)
            local_day = local.date()
            if start_date and local_day < start_date:
                continue
            if end_date and local_day > end_date:
                continue
            if hour_from is not None and not (hour_from <= local.hour <= hour_to):
                continue

            user_id = item.get("user_id")
            if allowed_user_ids == "unspecified":
                mapped_agency = user_display_map.get(user_id, {}).get("agency") if user_id else None
                if not _is_unspecified_agency(mapped_agency):
                    continue
            elif allowed_user_ids is not None and user_id not in allowed_user_ids:
                continue
            if user_id:
                unique_users.add(user_id)

            total_sessions += 1
            chat_history = item.get("chat_history", [])
            message_count = len(chat_history)
            total_messages += message_count
            session_msg_counts.append(message_count)

            date_key = local_day.strftime("%Y-%m-%d")
            daily_stats[date_key]["sessions"] += 1
            daily_stats[date_key]["messages"] += message_count
            if user_id:
                unique_users_daily[date_key].add(user_id)
                daily_user_sessions[date_key][user_id] += 1
                daily_user_messages[date_key][user_id] += message_count
            hourly_counts[local.hour] += 1
            hour_by_weekday[local.hour][local.weekday()] += message_count

        last_evaluated_key = response.get("LastEvaluatedKey")
        if not last_evaluated_key:
            break

    daily_breakdown = []
    for d, stats in sorted(daily_stats.items()):
        day_users = []
        for uid in unique_users_daily[d]:
            info = user_display_map.get(uid, {})
            day_users.append({
                "user_id": uid,
                "display_name": info.get("display_name") or uid,
                "agency": info.get("agency") or "Unknown",
                "sessions": daily_user_sessions[d][uid],
                "messages": daily_user_messages[d][uid],
            })
        day_users.sort(key=lambda u: u["messages"], reverse=True)
        daily_breakdown.append({
            "date": d,
            "sessions": stats["sessions"],
            "messages": stats["messages"],
            "unique_users": len(unique_users_daily[d]),
            "users": day_users,
        })

    avg_messages_per_session = (
        round(sum(session_msg_counts) / len(session_msg_counts), 1)
        if session_msg_counts
        else 0
    )
    peak_hour = max(hourly_counts, key=hourly_counts.get) if hourly_counts else None
    peak_hour_label = f"{peak_hour:02d}:00-{peak_hour + 1:02d}:00 ET" if peak_hour is not None else "N/A"

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
        # rows = hour 0..23, cols = weekday Mon..Sun
        "hour_by_weekday": hour_by_weekday,
        "timezone": "America/New_York",
    }


def fetch_analytics_items(start_date, end_date, agency_filter=None, hour_from=None, hour_to=None):
    """
    Pull AnalyticsTable rows for an ET date range, then filter to ET local-day +
    optional hour window. We expand the query by one UTC day on each side because
    `date_key` is the UTC slice of the timestamp; rows on the ET-edges live in the
    neighboring UTC day.
    """
    if not analytics_table:
        return []

    items = []
    # "Unspecified" is a synthetic bucket — the underlying rows have agency="" or "Unknown",
    # so AgencyIndex.eq("Unspecified") would return nothing. Fall back to the date-key scan.
    if agency_filter and agency_filter != UNSPECIFIED_AGENCY:
        last_evaluated_key = None
        start_dt = datetime.combine(start_date, datetime.min.time(), tzinfo=LOCAL_TZ).astimezone(timezone.utc)
        start_timestamp = start_dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")
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
    else:
        query_start = start_date - timedelta(days=1)
        query_end = end_date + timedelta(days=1)
        for date_key in iter_date_keys(query_start, query_end):
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

    return [
        item for item in items
        if _item_in_local_window(item, start_date, end_date, hour_from, hour_to)
    ]


def get_agency_breakdown(start_date, end_date, hour_from=None, hour_to=None, agency_filter=None):
    if not analytics_table:
        return {"agencies": [], "total_messages": 0}

    try:
        # When agency_filter is set, fetch_analytics_items uses the AgencyIndex —
        # cheaper than scanning every date.
        items = fetch_analytics_items(
            start_date, end_date,
            agency_filter=agency_filter,
            hour_from=hour_from, hour_to=hour_to,
        )
        agency_stats = defaultdict(
            lambda: {"messages": 0, "users": set(), "topics": defaultdict(int), "daily": defaultdict(int)}
        )
        total = 0

        for item in items:
            raw_agency = item.get("agency", "") or ""
            agency = UNSPECIFIED_AGENCY if _is_unspecified_agency(raw_agency) else raw_agency
            if agency_filter and agency != agency_filter:
                continue
            user_id = item.get("user_id", "")
            topic = item.get("topic", "Other")
            ts = parse_timestamp(item.get("timestamp", ""))
            date_key = _to_local(ts).strftime("%Y-%m-%d") if ts else item.get("date_key", "")
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
                        [{"date": d, "messages": count} for d, count in stats["daily"].items()],
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


def get_faq_insights(start_date, end_date, agency_filter=None, hour_from=None, hour_to=None):
    if not analytics_table:
        return {"topics": [], "total_classified": 0}

    try:
        items = fetch_analytics_items(
            start_date, end_date,
            agency_filter=agency_filter,
            hour_from=hour_from, hour_to=hour_to,
        )
        topic_counts = defaultdict(int)
        topic_samples = defaultdict(list)
        topic_seen_questions = defaultdict(set)
        total = 0

        for item in items:
            agency = item.get("agency", "")
            if agency_filter == UNSPECIFIED_AGENCY and not _is_unspecified_agency(agency):
                continue
            topic = item.get("topic", "Other")
            question = item.get("question", "")
            display_name = item.get("display_name", "")
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


def get_user_breakdown(start_date, end_date, agency_filter=None, hour_from=None, hour_to=None):
    if not analytics_table:
        return {"users": [], "total_messages": 0}

    try:
        items = fetch_analytics_items(start_date, end_date, hour_from=hour_from, hour_to=hour_to)
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
            agency = item.get("agency", "")
            if agency_filter == UNSPECIFIED_AGENCY:
                if not _is_unspecified_agency(agency):
                    continue
            elif agency_filter and agency != agency_filter:
                continue
            user_id = item.get("user_id", "") or "unknown"
            display_name = item.get("display_name", "")
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
        agency_filter = query_params.get("agency")
        start_date, end_date = resolve_date_range(query_params)
        hour_from, hour_to = resolve_hour_window(query_params)

        range_meta = {
            "from": start_date.strftime("%Y-%m-%d"),
            "to": end_date.strftime("%Y-%m-%d"),
            "days": (end_date - start_date).days + 1,
            "hour_from": hour_from,
            "hour_to": hour_to,
            "timezone": "America/New_York",
        }

        if metric_type == "faq":
            response_data = get_faq_insights(
                start_date, end_date,
                agency_filter=agency_filter,
                hour_from=hour_from, hour_to=hour_to,
            )
        elif metric_type == "traffic":
            session_metrics = summarize_session_metrics(
                start_date, end_date, hour_from, hour_to,
                agency_filter=agency_filter,
            )
            response_data = {
                "daily_breakdown": session_metrics["daily_breakdown"],
                "hourly_distribution": session_metrics["hourly_distribution"],
                "hour_by_weekday": session_metrics["hour_by_weekday"],
                "avg_messages_per_session": session_metrics["avg_messages_per_session"],
                "peak_hour": session_metrics["peak_hour"],
                "timezone": session_metrics["timezone"],
            }
        elif metric_type == "by_agency":
            response_data = get_agency_breakdown(
                start_date, end_date,
                hour_from=hour_from, hour_to=hour_to,
                agency_filter=agency_filter,
            )
        elif metric_type == "by_user":
            response_data = get_user_breakdown(
                start_date, end_date,
                agency_filter=agency_filter,
                hour_from=hour_from, hour_to=hour_to,
            )
        else:
            session_metrics = summarize_session_metrics(
                start_date, end_date, hour_from, hour_to,
                agency_filter=agency_filter,
            )
            response_data = {
                "unique_users": session_metrics["unique_users"],
                "total_sessions": session_metrics["total_sessions"],
                "total_messages": session_metrics["total_messages"],
                "daily_breakdown": session_metrics["daily_breakdown"],
                "avg_messages_per_session": session_metrics["avg_messages_per_session"],
                "peak_hour": session_metrics["peak_hour"],
                "hour_by_weekday": session_metrics["hour_by_weekday"],
                "hourly_distribution": session_metrics["hourly_distribution"],
                "timezone": session_metrics["timezone"],
            }

        response_data["range"] = range_meta
        return json_response(200, response_data, encoder=DecimalJSONEncoder)
    except Exception:
        logger.exception("Error in metrics handler")
        return json_response(500, {"message": "Failed to retrieve metrics"})
