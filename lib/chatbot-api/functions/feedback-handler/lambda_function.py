import json
import math
import os
import re
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key

from abe_utils import (
    extract_json_object,
    get_logger,
    is_admin_request,
    json_response,
    parse_json_body,
    safe_int,
)


logger = get_logger(__name__)
dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
feedback_records_table = dynamodb.Table(os.environ["FEEDBACK_RECORDS_TABLE"])
response_trace_table = dynamodb.Table(os.environ["RESPONSE_TRACE_TABLE"])
prompt_registry_table = dynamodb.Table(os.environ["PROMPT_REGISTRY_TABLE"])
monitoring_cases_table = dynamodb.Table(os.environ["MONITORING_CASES_TABLE"])
bedrock = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-east-1"))

PROMPT_FAMILY = os.environ.get("PROMPT_FAMILY", "ABE_CHAT")
ANALYSIS_MODEL_ID = os.environ.get(
    "FEEDBACK_ANALYSIS_MODEL_ID",
    os.environ.get("FAST_MODEL_ID", "us.anthropic.claude-3-5-haiku-20241022-v1:0"),
)

ALLOWED_DISPOSITIONS = {
    "pending",
    "prompt update",
    "KB/source fix",
    "retrieval/config issue",
    "product/UX bug",
}
ALLOWED_REVIEW_STATUSES = {"new", "analyzed", "in_review", "actioned", "dismissed"}
NEGATIVE_ROOT_CAUSES = {
    "retrieval_gap",
    "grounding_error",
    "prompt_issue",
    "answer_quality",
    "product_bug",
    "needs_human_review",
}
ALLOWED_FEEDBACK_KINDS = {"helpful", "not_helpful"}

MAX_TEXT_LENGTH = 2000
MAX_TEMPLATE_LENGTH = 50000
MAX_COMMENT_LENGTH = 5000
ISO_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}")


def validation_error(field: str, message: str):
    return json_response(400, {"error": "validation_error", "field": field, "message": message})


def truncate(value: str, limit: int) -> str:
    return value[:limit] if len(value) > limit else value


def _sanitize_value(value: Any) -> Any:
    """Return a DynamoDB-safe value (no NaN/Inf, no float; use Decimal for numbers)."""
    if value is None:
        return ""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return Decimal("0")
        return Decimal(str(value))
    if isinstance(value, dict):
        return {str(k): _sanitize_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_value(v) for v in value]
    if isinstance(value, (int, bool, str)):
        return value
    return str(value)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_audit_log(action: str, entity_type: str, entity_id: str, details: dict[str, Any] | None = None, actor: str = "admin"):
    """Append an audit entry to the feedback records table with RecordType=AUDIT_LOG."""
    try:
        feedback_records_table.put_item(Item={
            "FeedbackId": f"audit-{uuid.uuid4()}",
            "RecordType": "AUDIT_LOG",
            "Action": action,
            "EntityType": entity_type,
            "EntityId": entity_id,
            "Actor": actor,
            "Details": details or {},
            "CreatedAt": utc_now_iso(),
        })
    except Exception:
        logger.warning("Failed to write audit log for %s %s", action, entity_id)


def slugify(value: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")
    return text[:80] or "unclassified"


def parse_path(event: dict[str, Any]) -> list[str]:
    raw_path = (event or {}).get("rawPath") or ""
    return [part for part in raw_path.strip("/").split("/") if part]


def http_method(event: dict[str, Any]) -> str:
    http_ctx = (event or {}).get("requestContext", {}).get("http", {})
    if http_ctx.get("method"):
        return http_ctx["method"].upper()
    route_key = (event or {}).get("routeKey", "")
    return route_key.split(" ", 1)[0].upper() if route_key else ""


def get_query_params(event: dict[str, Any]) -> dict[str, str]:
    return (event or {}).get("queryStringParameters") or {}


def ensure_admin(event: dict[str, Any]):
    if not is_admin_request(event):
        raise PermissionError("Forbidden: Admin access required")


def get_prompt_table_item(version_id: str) -> dict[str, Any] | None:
    response = prompt_registry_table.get_item(
        Key={"PromptFamily": PROMPT_FAMILY, "VersionId": version_id}
    )
    return response.get("Item")


def get_live_prompt_pointer() -> dict[str, Any] | None:
    return get_prompt_table_item("LIVE")


def get_live_prompt_version_id() -> str | None:
    pointer = get_live_prompt_pointer() or {}
    return pointer.get("ActiveVersionId") or pointer.get("Template")


def query_all(table, **kwargs) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    response = table.query(**kwargs)
    items.extend(response.get("Items", []))
    last_key = response.get("LastEvaluatedKey")
    while last_key:
        response = table.query(**kwargs, ExclusiveStartKey=last_key)
        items.extend(response.get("Items", []))
        last_key = response.get("LastEvaluatedKey")
    return items


def scan_all(table) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    response = table.scan()
    items.extend(response.get("Items", []))
    last_key = response.get("LastEvaluatedKey")
    while last_key:
        response = table.scan(ExclusiveStartKey=last_key)
        items.extend(response.get("Items", []))
        last_key = response.get("LastEvaluatedKey")
    return items


def parse_sources(value: Any) -> list[dict[str, Any]]:
    if not value:
        return []
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    if isinstance(value, list):
        return value
    return []


def source_titles_from_trace(trace: dict[str, Any]) -> list[str]:
    seen: set[str] = set()
    titles: list[str] = []
    for source in parse_sources(trace.get("Sources")):
        title = source.get("title")
        if title and title not in seen:
            seen.add(title)
            titles.append(title)
    return titles


def build_follow_up_questions(issue_tags: list[str]) -> list[dict[str, str]]:
    follow_ups: list[dict[str, str]] = []
    tag_set = set(issue_tags)

    if "incorrect" in tag_set:
        follow_ups.append(
            {
                "id": "wrongSnippet",
                "label": "What was wrong?",
                "prompt": "Point to the incorrect part or describe the incorrect claim.",
            }
        )
    if "missing" in tag_set:
        follow_ups.append(
            {
                "id": "expectedAnswer",
                "label": "What did you expect?",
                "prompt": "Describe the answer or fact you expected to see.",
            }
        )
    if "irrelevant" in tag_set:
        follow_ups.append(
            {
                "id": "userComment",
                "label": "What were you trying to do?",
                "prompt": "Tell us the real goal so ABE can be corrected.",
            }
        )
    if "bad_source" in tag_set:
        follow_ups.append(
            {
                "id": "sourceAssessment",
                "label": "What was wrong with the source?",
                "prompt": "Were the sources missing, irrelevant, outdated, or contradictory?",
            }
        )
    if "unclear" in tag_set or "formatting" in tag_set:
        follow_ups.append(
            {
                "id": "userComment",
                "label": "How should this improve?",
                "prompt": "Tell us what would have made the response easier to use.",
            }
        )
    if not follow_ups:
        follow_ups.append(
            {
                "id": "userComment",
                "label": "Additional context",
                "prompt": "Share any details that will help us improve ABE.",
            }
        )
    return follow_ups


def normalize_issue_tags(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("issueTags") or []
    if not isinstance(raw, list):
        return []
    tags = []
    for tag in raw:
        text = slugify(str(tag or "").replace("-", "_")).replace("-", "_")
        if text:
            tags.append(text)
    return sorted(set(tags))


def heuristic_analysis(record: dict[str, Any], trace: dict[str, Any]) -> dict[str, Any]:
    issue_tags = set(record.get("IssueTags", []))
    source_titles = record.get("SourceTitles", [])
    root_cause = "needs_human_review"
    action = "product/UX bug"

    if "bad_source" in issue_tags:
        root_cause = "retrieval_gap"
        action = "KB/source fix"
    elif "missing" in issue_tags:
        root_cause = "retrieval_gap"
        action = "retrieval/config issue"
    elif "incorrect" in issue_tags:
        root_cause = "grounding_error"
        action = "prompt update"
    elif "unclear" in issue_tags or "formatting" in issue_tags:
        root_cause = "prompt_issue"
        action = "prompt update"
    elif "irrelevant" in issue_tags:
        root_cause = "answer_quality"
        action = "retrieval/config issue"

    summary = record.get("UserComment") or record.get("ExpectedAnswer") or "Negative feedback received."
    source_slug = slugify(source_titles[0] if source_titles else "no-source")
    cluster_id = f"{root_cause}:{action}:{source_slug}"
    return {
        "summary": summary[:300],
        "likelyRootCause": root_cause,
        "confidence": 0.35,
        "similarityKey": cluster_id,
        "recommendedAction": action,
        "candidatePromptRevisionNote": (
            "Tighten response structure and ground claims more explicitly."
            if action == "prompt update"
            else ""
        ),
        "candidateKbGap": source_titles[0] if action == "KB/source fix" and source_titles else "",
        "candidateMonitoringCase": {
            "question": trace.get("UserPrompt", ""),
            "referenceAnswer": record.get("ExpectedAnswer", ""),
            "reason": summary[:200],
        },
    }


def invoke_model_json(system_prompt: str, user_prompt: str) -> dict[str, Any]:
    request_body = json.dumps(
        {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 700,
            "temperature": 0,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_prompt}],
        }
    )
    response = bedrock.invoke_model(
        modelId=ANALYSIS_MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=request_body,
    )
    payload = json.loads(response["body"].read())
    text = payload["content"][0]["text"]
    return extract_json_object(text)


def analyze_feedback_record(record: dict[str, Any], trace: dict[str, Any]) -> dict[str, Any]:
    if record.get("FeedbackKind") == "helpful":
        return {
            "summary": "Helpful feedback received.",
            "likelyRootCause": "positive_signal",
            "confidence": 1.0,
            "similarityKey": "positive:helpful",
            "recommendedAction": "none",
            "candidatePromptRevisionNote": "",
            "candidateKbGap": "",
            "candidateMonitoringCase": {
                "question": trace.get("UserPrompt", ""),
                "referenceAnswer": trace.get("FinalAnswer", ""),
                "reason": "Helpful answer confirmed by user.",
            },
        }

    system_prompt = """
You analyze user feedback for an internal government procurement chatbot.
Return JSON only with these keys:
- summary
- likelyRootCause
- confidence
- similarityKey
- recommendedAction
- candidatePromptRevisionNote
- candidateKbGap
- candidateMonitoringCase

Rules:
- likelyRootCause must be one of: retrieval_gap, grounding_error, prompt_issue, answer_quality, product_bug, needs_human_review
- recommendedAction must be one of: prompt update, KB/source fix, retrieval/config issue, product/UX bug
- confidence must be a number between 0 and 1
- candidateMonitoringCase must be an object with question, referenceAnswer, reason
- Keep similarityKey short and stable for similar reports
""".strip()

    user_prompt = json.dumps(
        {
            "feedback": {
                "feedbackKind": record.get("FeedbackKind"),
                "issueTags": record.get("IssueTags", []),
                "userComment": record.get("UserComment", ""),
                "expectedAnswer": record.get("ExpectedAnswer", ""),
                "wrongSnippet": record.get("WrongSnippet", ""),
                "sourceAssessment": record.get("SourceAssessment", ""),
                "sourceTitles": record.get("SourceTitles", []),
                "promptVersionId": record.get("PromptVersionId", ""),
            },
            "trace": {
                "userPrompt": trace.get("UserPrompt", ""),
                "finalAnswer": trace.get("FinalAnswer", ""),
                "sources": parse_sources(trace.get("Sources")),
            },
        }
    )

    try:
        analysis = invoke_model_json(system_prompt, user_prompt)
        analysis["confidence"] = max(0.0, min(1.0, float(analysis.get("confidence", 0))))
        if analysis.get("likelyRootCause") not in NEGATIVE_ROOT_CAUSES:
            analysis["likelyRootCause"] = "needs_human_review"
        if analysis.get("recommendedAction") not in ALLOWED_DISPOSITIONS:
            analysis["recommendedAction"] = "product/UX bug"
        similarity_key = slugify(analysis.get("similarityKey", "needs-human-review"))
        analysis["similarityKey"] = similarity_key
        candidate_case = analysis.get("candidateMonitoringCase") or {}
        analysis["candidateMonitoringCase"] = {
            "question": str(candidate_case.get("question", trace.get("UserPrompt", "")))[:1000],
            "referenceAnswer": str(candidate_case.get("referenceAnswer", record.get("ExpectedAnswer", "")))[:4000],
            "reason": str(candidate_case.get("reason", analysis.get("summary", "")))[:500],
        }
        return analysis
    except Exception:
        logger.exception("AI enrichment failed, falling back to heuristic analysis")
        return heuristic_analysis(record, trace)


def get_response_trace(message_id: str) -> dict[str, Any] | None:
    response = response_trace_table.get_item(Key={"MessageId": message_id})
    return response.get("Item")


def summarize_feedback_item(item: dict[str, Any], cluster_counts: Counter) -> dict[str, Any]:
    return {
        "feedbackId": item["FeedbackId"],
        "messageId": item.get("MessageId"),
        "feedbackKind": item.get("FeedbackKind"),
        "issueTags": item.get("IssueTags", []),
        "reviewStatus": item.get("ReviewStatus"),
        "disposition": item.get("Disposition"),
        "createdAt": item.get("CreatedAt"),
        "updatedAt": item.get("UpdatedAt"),
        "summary": (item.get("Analysis") or {}).get("summary", ""),
        "rootCause": (item.get("Analysis") or {}).get("likelyRootCause", ""),
        "promptVersionId": item.get("PromptVersionId", ""),
        "sourceTitles": item.get("SourceTitles", []),
        "clusterId": item.get("ClusterId", ""),
        "recurrenceCount": cluster_counts.get(item.get("ClusterId", ""), 1),
        "userPromptPreview": item.get("UserPromptPreview", ""),
        "answerPreview": item.get("AnswerPreview", ""),
    }


def create_feedback(event: dict[str, Any]):
    payload = parse_json_body(event)
    message_id = str(payload.get("messageId", "")).strip()
    if not message_id:
        return validation_error("messageId", "messageId is required")

    try:
        trace = get_response_trace(message_id)
    except Exception:
        logger.exception("Failed to read response trace for %s", message_id)
        return json_response(502, {"error": "upstream_error", "message": "Could not look up the original response. Please try again."})
    if not trace:
        return json_response(404, {"error": "not_found", "message": "Response trace not found"})

    feedback_kind = str(payload.get("feedbackKind", "not_helpful")).strip() or "not_helpful"
    if feedback_kind not in ALLOWED_FEEDBACK_KINDS:
        return validation_error("feedbackKind", f"feedbackKind must be one of: {', '.join(sorted(ALLOWED_FEEDBACK_KINDS))}")
    issue_tags = normalize_issue_tags(payload)
    feedback_id = str(uuid.uuid4())
    source_titles = source_titles_from_trace(trace)
    created_at = utc_now_iso()

    session_id = trace.get("SessionId") or payload.get("sessionId") or ""
    prompt_version_id = trace.get("PromptVersionId") or ""
    user_prompt_preview = (trace.get("UserPrompt") or "")[:220]
    answer_preview = (trace.get("FinalAnswer") or "")[:280]
    record = {
        "FeedbackId": feedback_id,
        "RecordType": "FEEDBACK",
        "MessageId": message_id,
        "SessionId": str(session_id),
        "FeedbackKind": feedback_kind,
        "IssueTags": list(issue_tags),
        "UserComment": truncate(str(payload.get("userComment", "")).strip(), MAX_COMMENT_LENGTH),
        "ExpectedAnswer": truncate(str(payload.get("expectedAnswer", "")).strip(), MAX_TEXT_LENGTH),
        "WrongSnippet": truncate(str(payload.get("wrongSnippet", "")).strip(), MAX_TEXT_LENGTH),
        "SourceAssessment": truncate(str(payload.get("sourceAssessment", "")).strip(), MAX_TEXT_LENGTH),
        "RegenerateRequested": bool(payload.get("regenerateRequested", False)),
        "ReviewStatus": "new",
        "Disposition": "pending",
        "ClusterId": "",
        "PromptVersionId": str(prompt_version_id),
        "SourceTitles": [str(t) for t in source_titles],
        "CreatedAt": created_at,
        "UpdatedAt": created_at,
        "UserPromptPreview": str(user_prompt_preview),
        "AnswerPreview": str(answer_preview),
        "AdminNotes": "",
        "Owner": "",
        "ResolutionNote": "",
    }

    if feedback_kind != "helpful":
        analysis = analyze_feedback_record(record, trace)
        record["Analysis"] = analysis
        record["ClusterId"] = analysis.get("similarityKey", "") or slugify("needs-human-review")
        record["ReviewStatus"] = "analyzed"
    else:
        record["Analysis"] = analyze_feedback_record(record, trace)
        record["ClusterId"] = "positive:helpful"

    try:
        safe_record = _sanitize_value(record)
        feedback_records_table.put_item(Item=safe_record)
    except Exception as e:
        logger.exception("Failed to write feedback record %s: %s", feedback_id, e)
        return json_response(502, {"error": "upstream_error", "message": "Your feedback could not be saved right now. Please try again in a moment."})

    return json_response(
        201,
        {
            "feedbackId": feedback_id,
            "analysis": record.get("Analysis"),
            "followUpQuestions": build_follow_up_questions(issue_tags) if feedback_kind != "helpful" else [],
        },
    )


def append_feedback_follow_up(event: dict[str, Any], feedback_id: str):
    payload = parse_json_body(event)
    item = feedback_records_table.get_item(Key={"FeedbackId": feedback_id}).get("Item")
    if not item:
        return json_response(404, {"error": "Feedback not found"})

    for field_name, attr_name in (
        ("userComment", "UserComment"),
        ("expectedAnswer", "ExpectedAnswer"),
        ("wrongSnippet", "WrongSnippet"),
        ("sourceAssessment", "SourceAssessment"),
    ):
        if field_name in payload:
            item[attr_name] = str(payload.get(field_name, "")).strip()

    if "regenerateRequested" in payload:
        item["RegenerateRequested"] = bool(payload.get("regenerateRequested"))
    if "issueTags" in payload:
        item["IssueTags"] = normalize_issue_tags(payload)

    trace = get_response_trace(item["MessageId"]) or {}
    item["Analysis"] = analyze_feedback_record(item, trace)
    item["ClusterId"] = item["Analysis"].get("similarityKey", item.get("ClusterId", ""))
    item["ReviewStatus"] = "analyzed"
    item["UpdatedAt"] = utc_now_iso()
    feedback_records_table.put_item(Item=_sanitize_value(item))

    return json_response(
        200,
        {
            "feedbackId": feedback_id,
            "analysis": item["Analysis"],
            "followUpQuestions": build_follow_up_questions(item.get("IssueTags", [])),
        },
    )


def filter_feedback_items(items: list[dict[str, Any]], query_params: dict[str, str]) -> list[dict[str, Any]]:
    issue_tag_raw = query_params.get("issueTag", "").strip()
    issue_tag = slugify(issue_tag_raw).replace("-", "_") if issue_tag_raw else ""
    review_status = query_params.get("reviewStatus")
    disposition = query_params.get("disposition")
    root_cause = query_params.get("rootCause")
    prompt_version_id = query_params.get("promptVersionId")
    source_title = query_params.get("sourceTitle", "").lower()
    date_from = query_params.get("dateFrom")
    date_to = query_params.get("dateTo")
    if date_from and not ISO_DATE_PATTERN.match(date_from):
        date_from = None
    if date_to and not ISO_DATE_PATTERN.match(date_to):
        date_to = None

    filtered = []
    for item in items:
        if review_status and item.get("ReviewStatus") != review_status:
            continue
        if disposition and item.get("Disposition") != disposition:
            continue
        if issue_tag and issue_tag not in item.get("IssueTags", []):
            continue
        if root_cause and (item.get("Analysis") or {}).get("likelyRootCause") != root_cause:
            continue
        if prompt_version_id and item.get("PromptVersionId") != prompt_version_id:
            continue
        if source_title and not any(source_title in title.lower() for title in item.get("SourceTitles", [])):
            continue
        if date_from and item.get("CreatedAt", "") < date_from:
            continue
        if date_to and item.get("CreatedAt", "") > date_to:
            continue
        filtered.append(item)
    return filtered


def list_feedback(event: dict[str, Any]):
    query_params = get_query_params(event)
    items = query_all(
        feedback_records_table,
        IndexName="RecordTypeCreatedAtIndex",
        KeyConditionExpression=Key("RecordType").eq("FEEDBACK"),
        ScanIndexForward=False,
    )
    items = filter_feedback_items(items, query_params)
    cluster_counts = Counter(item.get("ClusterId", "") for item in items if item.get("ClusterId"))
    limit = safe_int(query_params.get("limit"), 200, minimum=1, maximum=500)
    items = items[:limit]
    return json_response(
        200,
        {
            "items": [summarize_feedback_item(item, cluster_counts) for item in items],
            "total": len(items),
        },
    )


def feedback_detail(feedback_id: str):
    item = feedback_records_table.get_item(Key={"FeedbackId": feedback_id}).get("Item")
    if not item:
        return json_response(404, {"error": "Feedback not found"})

    trace = get_response_trace(item.get("MessageId", "")) or {}
    similar_reports = []
    cluster_id = item.get("ClusterId")
    if cluster_id:
        similar_items = query_all(
            feedback_records_table,
            IndexName="ClusterIndex",
            KeyConditionExpression=Key("ClusterId").eq(cluster_id),
            ScanIndexForward=False,
        )
        cluster_counts = Counter(i.get("ClusterId", "") for i in similar_items)
        similar_reports = [
            summarize_feedback_item(similar, cluster_counts)
            for similar in similar_items
            if similar.get("FeedbackId") != feedback_id
        ][:5]

    return json_response(
        200,
        {
            "feedback": item,
            "trace": trace,
            "similarReports": similar_reports,
        },
    )


def rerun_analysis(feedback_id: str):
    item = feedback_records_table.get_item(Key={"FeedbackId": feedback_id}).get("Item")
    if not item:
        return json_response(404, {"error": "Feedback not found"})

    trace = get_response_trace(item.get("MessageId", "")) or {}
    item["Analysis"] = analyze_feedback_record(item, trace)
    item["ClusterId"] = item["Analysis"].get("similarityKey", item.get("ClusterId", ""))
    item["ReviewStatus"] = "analyzed"
    item["UpdatedAt"] = utc_now_iso()
    feedback_records_table.put_item(Item=_sanitize_value(item))
    return json_response(200, {"feedbackId": feedback_id, "analysis": item["Analysis"]})


def set_disposition(event: dict[str, Any], feedback_id: str):
    payload = parse_json_body(event)
    item = feedback_records_table.get_item(Key={"FeedbackId": feedback_id}).get("Item")
    if not item:
        return json_response(404, {"error": "Feedback not found"})

    disposition = payload.get("disposition", item.get("Disposition", "pending"))
    review_status = payload.get("reviewStatus", item.get("ReviewStatus", "in_review"))
    if disposition not in ALLOWED_DISPOSITIONS:
        return json_response(400, {"error": "Invalid disposition"})
    if review_status not in ALLOWED_REVIEW_STATUSES:
        return json_response(400, {"error": "Invalid reviewStatus"})

    item["Disposition"] = disposition
    item["ReviewStatus"] = review_status
    item["Owner"] = str(payload.get("owner", item.get("Owner", ""))).strip()
    item["ResolutionNote"] = str(payload.get("resolutionNote", item.get("ResolutionNote", ""))).strip()
    item["AdminNotes"] = str(payload.get("adminNotes", item.get("AdminNotes", ""))).strip()
    item["UpdatedAt"] = utc_now_iso()
    feedback_records_table.put_item(Item=_sanitize_value(item))
    write_audit_log("disposition_set", "feedback", feedback_id, {
        "disposition": disposition, "reviewStatus": review_status, "owner": item["Owner"],
    })
    return json_response(200, {"feedback": item})


def promote_to_candidate(feedback_id: str):
    from boto3.dynamodb.conditions import Attr

    item = feedback_records_table.get_item(Key={"FeedbackId": feedback_id}).get("Item")
    if not item:
        return json_response(404, {"error": "Feedback not found"})

    trace = get_response_trace(item.get("MessageId", "")) or {}
    analysis = item.get("Analysis") or {}
    case_id = f"FDBK#{feedback_id}"
    created_at = utc_now_iso()
    candidate_case = {
        "SetName": "CandidateSet",
        "CaseId": case_id,
        "SourceFeedbackId": feedback_id,
        "CreatedAt": created_at,
        "UpdatedAt": created_at,
        "PromptVersionId": item.get("PromptVersionId", ""),
        "Provenance": "feedback_candidate",
        "Status": "candidate",
        "Question": (analysis.get("candidateMonitoringCase") or {}).get("question") or trace.get("UserPrompt", ""),
        "ReferenceAnswer": (analysis.get("candidateMonitoringCase") or {}).get("referenceAnswer") or item.get("ExpectedAnswer", ""),
        "Summary": analysis.get("summary", ""),
        "Reason": (analysis.get("candidateMonitoringCase") or {}).get("reason", ""),
        "RootCause": analysis.get("likelyRootCause", ""),
    }
    try:
        monitoring_cases_table.put_item(
            Item=_sanitize_value(candidate_case),
            ConditionExpression=Attr("CaseId").not_exists(),
        )
    except monitoring_cases_table.meta.client.exceptions.ConditionalCheckFailedException:
        return json_response(409, {"error": "This feedback has already been promoted to a candidate."})

    item["UpdatedAt"] = created_at
    item["ReviewStatus"] = "actioned"
    feedback_records_table.put_item(Item=_sanitize_value(item))
    write_audit_log("promoted_to_candidate", "feedback", feedback_id, {"caseId": case_id})
    return json_response(200, {"case": candidate_case})


def serialize_prompt_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "promptFamily": item.get("PromptFamily"),
        "versionId": item.get("VersionId"),
        "itemType": item.get("ItemType"),
        "title": item.get("Title", ""),
        "notes": item.get("Notes", ""),
        "template": item.get("Template", ""),
        "status": item.get("Status", ""),
        "parentVersionId": item.get("ParentVersionId", ""),
        "linkedFeedbackIds": item.get("LinkedFeedbackIds", []),
        "createdAt": item.get("CreatedAt"),
        "updatedAt": item.get("UpdatedAt"),
        "createdBy": item.get("CreatedBy", ""),
        "publishedAt": item.get("PublishedAt", ""),
        "aiSummary": item.get("AiSummary", ""),
    }


def list_prompts():
    items = query_all(
        prompt_registry_table,
        KeyConditionExpression=Key("PromptFamily").eq(PROMPT_FAMILY),
        ScanIndexForward=False,
    )
    live_version_id = get_live_prompt_version_id()
    prompt_items = [serialize_prompt_item(item) for item in items if item.get("ItemType") == "PromptVersion"]
    return json_response(200, {"liveVersionId": live_version_id, "items": prompt_items})


def get_prompt(version_id: str):
    item = get_prompt_table_item(version_id)
    if not item or item.get("ItemType") != "PromptVersion":
        return json_response(404, {"error": "Prompt version not found"})
    return json_response(200, {"prompt": serialize_prompt_item(item), "liveVersionId": get_live_prompt_version_id()})


def create_prompt(event: dict[str, Any]):
    payload = parse_json_body(event)
    parent_version_id = str(payload.get("parentVersionId") or get_live_prompt_version_id() or "").strip()
    template = str(payload.get("template", "")).strip()
    if not template and parent_version_id:
        parent = get_prompt_table_item(parent_version_id)
        if parent:
            template = parent.get("Template", "")
    if not template:
        return validation_error("template", "template is required")
    if len(template) > MAX_TEMPLATE_LENGTH:
        return validation_error("template", f"template exceeds maximum length of {MAX_TEMPLATE_LENGTH} characters")

    version_id = f"v-{uuid.uuid4()}"
    now = utc_now_iso()
    item = {
        "PromptFamily": PROMPT_FAMILY,
        "VersionId": version_id,
        "ItemType": "PromptVersion",
        "Title": str(payload.get("title", "Untitled draft")).strip() or "Untitled draft",
        "Notes": str(payload.get("notes", "")).strip(),
        "Template": template,
        "Status": "draft",
        "ParentVersionId": parent_version_id,
        "LinkedFeedbackIds": payload.get("linkedFeedbackIds", []) if isinstance(payload.get("linkedFeedbackIds"), list) else [],
        "CreatedAt": now,
        "UpdatedAt": now,
        "CreatedBy": "admin",
        "PublishedAt": "",
        "AiSummary": str(payload.get("aiSummary", "")).strip(),
    }
    prompt_registry_table.put_item(Item=item)
    return json_response(201, {"prompt": serialize_prompt_item(item)})


def update_prompt(event: dict[str, Any], version_id: str):
    payload = parse_json_body(event)
    item = get_prompt_table_item(version_id)
    if not item or item.get("ItemType") != "PromptVersion":
        return json_response(404, {"error": "Prompt version not found"})
    if item.get("Status") == "published" and get_live_prompt_version_id() == version_id:
        return json_response(400, {"error": "Edit the draft, not the live version"})

    if "title" in payload:
        item["Title"] = str(payload.get("title", "")).strip() or item.get("Title", "Untitled draft")
    if "notes" in payload:
        item["Notes"] = str(payload.get("notes", "")).strip()
    if "template" in payload:
        item["Template"] = str(payload.get("template", "")).strip()
    if "linkedFeedbackIds" in payload and isinstance(payload.get("linkedFeedbackIds"), list):
        item["LinkedFeedbackIds"] = payload.get("linkedFeedbackIds")
    item["UpdatedAt"] = utc_now_iso()
    prompt_registry_table.put_item(Item=item)
    return json_response(200, {"prompt": serialize_prompt_item(item)})


def publish_prompt(version_id: str):
    item = get_prompt_table_item(version_id)
    if not item or item.get("ItemType") != "PromptVersion":
        return json_response(404, {"error": "Prompt version not found"})

    now = utc_now_iso()
    item["Status"] = "published"
    item["PublishedAt"] = now
    item["UpdatedAt"] = now
    prompt_registry_table.put_item(Item=item)
    prompt_registry_table.put_item(
        Item={
            "PromptFamily": PROMPT_FAMILY,
            "VersionId": "LIVE",
            "ItemType": "LivePointer",
            "ActiveVersionId": version_id,
            "Template": version_id,
            "UpdatedAt": now,
        }
    )
    write_audit_log("prompt_published", "prompt", version_id, {"title": item.get("Title", "")})
    return json_response(200, {"liveVersionId": version_id, "prompt": serialize_prompt_item(item)})


def delete_prompt(version_id: str):
    item = get_prompt_table_item(version_id)
    if not item or item.get("ItemType") != "PromptVersion":
        return json_response(404, {"error": "not_found", "message": "Prompt version not found"})
    if item.get("Status") == "published" and get_live_prompt_version_id() == version_id:
        return json_response(400, {"error": "validation_error", "message": "Cannot delete the live prompt. Publish a different version first."})
    prompt_registry_table.delete_item(Key={"PromptFamily": PROMPT_FAMILY, "VersionId": version_id})
    write_audit_log("prompt_deleted", "prompt", version_id, {"title": item.get("Title", "")})
    return json_response(200, {"deleted": True, "versionId": version_id})


def ai_suggest_prompt(event: dict[str, Any], version_id: str):
    item = get_prompt_table_item(version_id)
    if not item or item.get("ItemType") != "PromptVersion":
        return json_response(404, {"error": "Prompt version not found"})

    payload = parse_json_body(event)
    selected_feedback_ids = payload.get("feedbackIds", []) if isinstance(payload.get("feedbackIds"), list) else []
    selected_feedback = []
    for feedback_id in selected_feedback_ids[:10]:
        feedback = feedback_records_table.get_item(Key={"FeedbackId": feedback_id}).get("Item")
        if feedback:
            selected_feedback.append(
                {
                    "feedbackId": feedback["FeedbackId"],
                    "issueTags": feedback.get("IssueTags", []),
                    "analysis": feedback.get("Analysis", {}),
                    "userComment": feedback.get("UserComment", ""),
                    "expectedAnswer": feedback.get("ExpectedAnswer", ""),
                    "promptVersionId": feedback.get("PromptVersionId", ""),
                }
            )

    if not selected_feedback:
        selected_feedback = [
            {
                "feedbackId": "none-selected",
                "issueTags": [],
                "analysis": {},
                "userComment": str(payload.get("note", "")).strip(),
                "expectedAnswer": "",
                "promptVersionId": version_id,
            }
        ]

    system_prompt = """
You rewrite system prompts for an internal RAG chatbot.
Return JSON only with keys:
- summary
- suggestedTemplate

Rules:
- Keep placeholders like {{current_date}} and {{metadata_json}} if present
- Improve the prompt based on the feedback patterns
- Do not invent tools that do not exist
""".strip()
    user_prompt = json.dumps(
        {
            "currentPrompt": item.get("Template", ""),
            "selectedFeedback": selected_feedback,
            "note": str(payload.get("note", "")).strip(),
        }
    )

    try:
        suggestion = invoke_model_json(system_prompt, user_prompt)
        suggested_template = str(suggestion.get("suggestedTemplate", "")).strip()
        summary = str(suggestion.get("summary", "")).strip()
    except Exception:
        logger.exception("AI prompt suggestion failed")
        suggested_template = item.get("Template", "")
        summary = "AI draft suggestion failed; cloned the selected prompt as a draft."

    draft_event = {
        "body": {
            "title": f"Draft from {version_id}",
            "notes": summary,
            "template": suggested_template,
            "parentVersionId": version_id,
            "linkedFeedbackIds": selected_feedback_ids,
            "aiSummary": summary,
        }
    }
    return create_prompt(draft_event)


def _query_recent_feedback(limit: int = 500) -> list[dict[str, Any]]:
    """Query recent feedback using the GSI with a cap."""
    items: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {
        "IndexName": "RecordTypeCreatedAtIndex",
        "KeyConditionExpression": Key("RecordType").eq("FEEDBACK"),
        "ScanIndexForward": False,
    }
    while len(items) < limit:
        response = feedback_records_table.query(**kwargs)
        items.extend(response.get("Items", []))
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
        kwargs["ExclusiveStartKey"] = last_key
    return items[:limit]


def get_monitoring():
    feedback_items = _query_recent_feedback(limit=500)
    candidate_cases = query_all(
        monitoring_cases_table,
        KeyConditionExpression=Key("SetName").eq("CandidateSet"),
        ScanIndexForward=False,
    )
    core_cases = query_all(
        monitoring_cases_table,
        KeyConditionExpression=Key("SetName").eq("CoreMonitoringSet"),
        ScanIndexForward=False,
    )

    disposition_counts: Counter = Counter()
    root_cause_counts: Counter = Counter()
    cluster_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    source_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    prompt_groups: Counter = Counter()

    for item in feedback_items:
        disposition_counts[item.get("Disposition", "pending")] += 1
        root_cause_counts[(item.get("Analysis") or {}).get("likelyRootCause", "unknown")] += 1
        cluster_id = item.get("ClusterId")
        if cluster_id:
            cluster_groups[cluster_id].append(item)
        for title in set(item.get("SourceTitles", [])):
            source_groups[title].append(item)
        if item.get("PromptVersionId"):
            prompt_groups[item["PromptVersionId"]] += 1

    cluster_summaries = []
    for cluster_id, cluster_items in cluster_groups.items():
        cluster_items.sort(key=lambda v: v.get("CreatedAt", ""), reverse=True)
        sample = cluster_items[0]
        cluster_summaries.append(
            {
                "clusterId": cluster_id,
                "count": len(cluster_items),
                "summary": (sample.get("Analysis") or {}).get("summary", ""),
                "rootCause": (sample.get("Analysis") or {}).get("likelyRootCause", ""),
                "recommendedAction": (sample.get("Analysis") or {}).get("recommendedAction", ""),
                "promptVersionId": sample.get("PromptVersionId", ""),
                "latestCreatedAt": sample.get("CreatedAt", ""),
                "sampleFeedbackId": sample.get("FeedbackId"),
                "samplePrompt": sample.get("UserPromptPreview", ""),
                "sourceTitles": sorted({title for i in cluster_items for title in i.get("SourceTitles", [])})[:5],
            }
        )
    cluster_summaries.sort(key=lambda item: item["count"], reverse=True)

    source_triage = []
    for title, items in source_groups.items():
        issue_counts = Counter(tag for item in items for tag in item.get("IssueTags", []))
        source_triage.append(
            {
                "sourceTitle": title,
                "count": len(items),
                "topIssueTags": issue_counts.most_common(3),
                "latestCreatedAt": max((item.get("CreatedAt", "") for item in items), default=""),
                "promptVersions": sorted({item.get("PromptVersionId", "") for item in items if item.get("PromptVersionId")}),
            }
        )
    source_triage.sort(key=lambda item: item["count"], reverse=True)

    prompt_activity = [
        {"promptVersionId": vid, "feedbackCount": cnt}
        for vid, cnt in prompt_groups.most_common()
    ]

    return json_response(
        200,
        {
            "coreMonitoringSet": {
                "setName": "CoreMonitoringSet",
                "count": len(core_cases),
                "provenance": "admin_curated",
                "recentCases": core_cases[:10],
            },
            "candidateSet": {
                "setName": "CandidateSet",
                "count": len(candidate_cases),
                "provenance": "feedback_candidate",
                "recentCases": candidate_cases[:10],
            },
            "feedbackOverview": {
                "totalFeedback": len(feedback_items),
                "dispositionCounts": dict(disposition_counts),
                "rootCauseCounts": dict(root_cause_counts),
            },
            "clusterSummaries": cluster_summaries[:25],
            "sourceTriage": source_triage[:25],
            "promptActivity": prompt_activity[:20],
            "health": {
                "livePromptVersionId": get_live_prompt_version_id() or "none",
                "totalFeedback": len(feedback_items),
                "pendingTriage": disposition_counts.get("pending", 0),
                "negativeRate": round(
                    sum(1 for i in feedback_items if i.get("FeedbackKind") != "helpful") / max(len(feedback_items), 1),
                    2,
                ),
            },
        },
    )


def get_activity_log():
    """Return the most recent admin audit log entries."""
    items = query_all(
        feedback_records_table,
        IndexName="RecordTypeCreatedAtIndex",
        KeyConditionExpression=Key("RecordType").eq("AUDIT_LOG"),
        ScanIndexForward=False,
    )
    entries = []
    for item in items[:50]:
        entries.append({
            "action": item.get("Action", ""),
            "entityType": item.get("EntityType", ""),
            "entityId": item.get("EntityId", ""),
            "actor": item.get("Actor", ""),
            "details": item.get("Details", {}),
            "createdAt": item.get("CreatedAt", ""),
        })
    return json_response(200, {"entries": entries})


def lambda_handler(event, context):
    method = http_method(event)
    path_parts = parse_path(event)

    try:
        if method == "POST" and path_parts == ["feedback"]:
            return create_feedback(event)

        if method == "POST" and len(path_parts) == 3 and path_parts[0] == "feedback" and path_parts[2] == "follow-up":
            return append_feedback_follow_up(event, path_parts[1])

        if path_parts == ["user-feedback"] and method == "GET":
            return list_feedback(event)
        if path_parts == ["user-feedback"] and method in ("POST", "DELETE"):
            return json_response(410, {"error": "Legacy endpoint removed. Use POST /feedback instead."})
        if path_parts == ["user-feedback", "download-feedback"] and method == "POST":
            return json_response(410, {"error": "Legacy download endpoint removed."})

        if not path_parts or path_parts[0] != "admin":
            return json_response(404, {"error": "Not found"})

        ensure_admin(event)

        if method == "GET" and path_parts == ["admin", "feedback"]:
            return list_feedback(event)
        if method == "GET" and len(path_parts) == 3 and path_parts[:2] == ["admin", "feedback"]:
            return feedback_detail(path_parts[2])
        if method == "POST" and len(path_parts) == 4 and path_parts[:2] == ["admin", "feedback"] and path_parts[3] == "analyze":
            return rerun_analysis(path_parts[2])
        if method == "POST" and len(path_parts) == 4 and path_parts[:2] == ["admin", "feedback"] and path_parts[3] == "disposition":
            return set_disposition(event, path_parts[2])
        if method == "POST" and len(path_parts) == 4 and path_parts[:2] == ["admin", "feedback"] and path_parts[3] == "promote-to-candidate":
            return promote_to_candidate(path_parts[2])

        if method == "GET" and path_parts == ["admin", "prompts"]:
            return list_prompts()
        if method == "POST" and path_parts == ["admin", "prompts"]:
            return create_prompt(event)
        if method == "GET" and len(path_parts) == 3 and path_parts[:2] == ["admin", "prompts"]:
            return get_prompt(path_parts[2])
        if method == "PUT" and len(path_parts) == 3 and path_parts[:2] == ["admin", "prompts"]:
            return update_prompt(event, path_parts[2])
        if method == "DELETE" and len(path_parts) == 3 and path_parts[:2] == ["admin", "prompts"]:
            return delete_prompt(path_parts[2])
        if method == "POST" and len(path_parts) == 4 and path_parts[:2] == ["admin", "prompts"] and path_parts[3] == "publish":
            return publish_prompt(path_parts[2])
        if method == "POST" and len(path_parts) == 4 and path_parts[:2] == ["admin", "prompts"] and path_parts[3] == "ai-suggest":
            return ai_suggest_prompt(event, path_parts[2])

        if method == "GET" and path_parts == ["admin", "monitoring"]:
            return get_monitoring()

        if method == "GET" and path_parts == ["admin", "activity-log"]:
            return get_activity_log()

        return json_response(404, {"error": "Not found"})
    except PermissionError as error:
        return json_response(403, {"error": "forbidden", "message": str(error)})
    except json.JSONDecodeError:
        return json_response(400, {"error": "validation_error", "message": "Invalid JSON in request body"})
    except Exception:
        logger.exception("Feedback Manager handler failed")
        return json_response(500, {"error": "internal_error", "message": "An unexpected error occurred. Please try again."})
