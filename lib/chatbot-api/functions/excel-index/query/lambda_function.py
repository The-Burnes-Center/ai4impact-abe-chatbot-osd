"""
Generic Excel Index Query Lambda.
Reads from a shared DynamoDB table using index_name as the partition key.
Supports status, preview, and query actions with generic column filters.
"""
import json
import os
import re
from typing import Any

import boto3
from boto3.dynamodb.conditions import Attr, Key
from pydantic import ValidationError

from models import QueryIndexRequest, StatusResponse, PreviewResponse

DDB = boto3.resource("dynamodb")
TABLE_NAME = os.environ["TABLE_NAME"]
SK_META = "META"

SKIP_FIELDS = {"pk", "sk"}
_PUNCT_RE = re.compile(r'[^\w\s]')
_MULTI_WS = re.compile(r'\s+')


def lambda_handler(event, context):
    body = _get_payload(event)
    try:
        req = QueryIndexRequest.model_validate(body)
    except ValidationError as e:
        return _response(400, {"error": "Invalid request", "details": e.errors()})

    pk = req.index_name
    try:
        if req.action == "status":
            out = _do_status(pk)
        elif req.action == "preview":
            out = _do_preview(pk, req.preview_rows)
        else:
            out = _do_query(
                pk=pk,
                free_text=req.free_text,
                filters=req.filters,
                count_only=req.count_only,
                count_unique=req.count_unique,
                group_by=req.group_by,
                limit=req.limit,
            )
        return _response(200, out)
    except Exception as e:
        return _response(500, {"error": str(e)})


def _get_payload(event: dict) -> dict:
    if "body" in event and isinstance(event["body"], str):
        return json.loads(event["body"]) if event["body"] else {}
    if "action" in event:
        return event
    return event.get("body") or event


def _response(status: int, body: dict | list) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def _item_to_row(item: dict) -> dict[str, Any]:
    return {k: v for k, v in item.items() if k not in SKIP_FIELDS}


def _do_status(pk: str) -> dict:
    table = DDB.Table(TABLE_NAME)
    try:
        resp = table.get_item(Key={"pk": pk, "sk": SK_META})
    except Exception as e:
        raise RuntimeError(f"DynamoDB get failed: {e}") from e
    item = resp.get("Item")
    if not item:
        return StatusResponse(
            status="NO_DATA", has_data=False, row_count=0,
            last_updated=None, error_message=None,
        ).model_dump()
    row_count = int(item.get("row_count", 0))
    stored_status = item.get("status")
    if stored_status in ("PROCESSING", "COMPLETE", "ERROR"):
        status = stored_status
    elif item.get("error"):
        status = "ERROR"
    elif row_count > 0:
        status = "COMPLETE"
    else:
        status = "PROCESSING"
    return StatusResponse(
        status=status,
        has_data=row_count > 0,
        row_count=row_count,
        last_updated=item.get("last_updated"),
        error_message=item.get("error"),
    ).model_dump()


def _do_preview(pk: str, n: int) -> dict:
    table = DDB.Table(TABLE_NAME)
    meta = table.get_item(Key={"pk": pk, "sk": SK_META}).get("Item", {})
    stored_columns = meta.get("columns", [])

    resp = table.query(
        KeyConditionExpression=Key("pk").eq(pk),
        Limit=max(n + 10, 50),
    )
    items = resp.get("Items", [])
    items = [it for it in items if it.get("sk") != SK_META]
    rows = [_item_to_row(it) for it in items][:n]
    if not rows:
        return PreviewResponse(columns=[], rows=[]).model_dump()
    columns = stored_columns if stored_columns else list(rows[0].keys())
    return PreviewResponse(columns=columns, rows=rows).model_dump()


def _norm(s: str) -> str:
    """Strip punctuation and collapse whitespace for fuzzy substring matching."""
    return _MULTI_WS.sub(' ', _PUNCT_RE.sub('', s)).strip().lower()


def _contains(haystack: str, needle: str) -> bool:
    return _norm(needle) in _norm(haystack)


def _row_matches(
    row: dict[str, Any],
    free_text: str | None,
    filters: dict[str, Any] | None,
) -> bool:
    if free_text:
        if not any(
            _contains(str(v), free_text)
            for k, v in row.items()
            if k not in SKIP_FIELDS
        ):
            return False
    if filters:
        for col, value in filters.items():
            cell = str(row.get(col) or "")
            if not _contains(cell, str(value)):
                return False
    return True


def _do_query(
    pk: str,
    free_text: str | None = None,
    filters: dict[str, Any] | None = None,
    count_only: bool = False,
    count_unique: str | None = None,
    group_by: str | None = None,
    limit: int = 500,
) -> dict:
    """Scan partition and filter in code. Scans all pages for accurate totals."""
    table = DDB.Table(TABLE_NAME)
    collected: list[dict] = []
    total = 0
    unique_vals: set[str] = set() if count_unique else None
    group_counts: dict[str, int] = {} if group_by else None
    scan_kw: dict[str, Any] = {"FilterExpression": Attr("pk").eq(pk) & Attr("sk").ne(SK_META)}
    while True:
        resp = table.scan(**scan_kw)
        for item in resp.get("Items", []):
            row = _item_to_row(item)
            if _row_matches(row, free_text=free_text, filters=filters):
                total += 1
                if unique_vals is not None:
                    val = str(row.get(count_unique) or "").strip()
                    if val:
                        unique_vals.add(val)
                if group_counts is not None:
                    gval = str(row.get(group_by) or "").strip() or "(empty)"
                    group_counts[gval] = group_counts.get(gval, 0) + 1
                if not count_only and len(collected) < limit:
                    collected.append(row)
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break
        scan_kw["ExclusiveStartKey"] = last_key
    result: dict[str, Any] = {
        "rows": [] if count_only else collected,
        "total_matches": total,
        "returned": 0 if count_only else len(collected),
    }
    if unique_vals is not None:
        result["unique_count"] = len(unique_vals)
        result["unique_column"] = count_unique
    if group_counts is not None:
        result["group_by"] = group_by
        result["groups"] = dict(sorted(group_counts.items()))
    return result
