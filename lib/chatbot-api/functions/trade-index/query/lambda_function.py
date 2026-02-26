"""
Trade Index Query Lambda: read trade contract index from DynamoDB.
Schema-flexible — searches all string fields for free_text matches.
"""
import json
import os
import re
from typing import Any

import boto3
from boto3.dynamodb.conditions import Attr, Key
from pydantic import ValidationError

from models import QueryTradeIndexRequest, StatusResponse, PreviewResponse

DDB = boto3.resource("dynamodb")
TABLE_NAME = os.environ["TABLE_NAME"]
PK = "INDEX"
SK_META = "META"

SKIP_FIELDS = {"pk", "sk"}
_PUNCT_RE = re.compile(r'[^\w\s]')
_MULTI_WS = re.compile(r'\s+')


def _norm(s: str) -> str:
    """Strip punctuation and collapse whitespace for fuzzy substring matching."""
    return _MULTI_WS.sub(' ', _PUNCT_RE.sub('', s)).strip().lower()


def _contains(haystack: str, needle: str) -> bool:
    return _norm(needle) in _norm(haystack)


def lambda_handler(event, context):
    body = _get_payload(event)
    try:
        req = QueryTradeIndexRequest.model_validate(body)
    except ValidationError as e:
        return _response(400, {"error": "Invalid request", "details": e.errors()})

    try:
        if req.action == "status":
            out = _do_status()
        elif req.action == "preview":
            out = _do_preview(req.preview_rows)
        else:
            out = _do_query(
                free_text=req.free_text,
                vendor_name=req.vendor_name,
                contract_id=req.contract_id,
                count_only=req.count_only,
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


def _do_status() -> dict:
    table = DDB.Table(TABLE_NAME)
    try:
        resp = table.get_item(Key={"pk": PK, "sk": SK_META})
    except Exception as e:
        raise RuntimeError(f"DynamoDB get failed: {e}") from e
    item = resp.get("Item")
    if not item:
        return StatusResponse(status="NO_DATA", has_data=False, row_count=0).model_dump()
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


def _do_preview(n: int) -> dict:
    table = DDB.Table(TABLE_NAME)
    meta = table.get_item(Key={"pk": PK, "sk": SK_META}).get("Item", {})
    stored_columns = meta.get("columns", [])

    resp = table.query(KeyConditionExpression=Key("pk").eq(PK), Limit=max(n + 10, 50))
    items = [it for it in resp.get("Items", []) if it.get("sk") != SK_META]
    rows = [_item_to_row(it) for it in items][:n]
    if not rows:
        return PreviewResponse(columns=[], rows=[]).model_dump()
    columns = stored_columns if stored_columns else list(rows[0].keys())
    return PreviewResponse(columns=columns, rows=rows).model_dump()


def _row_matches(row: dict, free_text: str | None, vendor_name: str | None, contract_id: str | None) -> bool:
    if free_text:
        if not any(_contains(str(v), free_text) for v in row.values()):
            return False
    if vendor_name:
        found = False
        for k, v in row.items():
            if "vendor" in k.lower() and "name" in k.lower():
                if _contains(str(v), vendor_name):
                    found = True
                    break
        if not found:
            return False
    if contract_id:
        found = False
        for k, v in row.items():
            if "contract" in k.lower() and ("id" in k.lower() or "number" in k.lower()):
                if contract_id.lower() in str(v).lower():
                    found = True
                    break
        if not found:
            return False
    return True


def _do_query(
    free_text: str | None = None,
    vendor_name: str | None = None,
    contract_id: str | None = None,
    count_only: bool = False,
    limit: int = 20,
) -> dict:
    table = DDB.Table(TABLE_NAME)
    collected: list[dict] = []
    total = 0
    scan_kw: dict[str, Any] = {"FilterExpression": Attr("pk").eq(PK) & Attr("sk").ne(SK_META)}
    while True:
        resp = table.scan(**scan_kw)
        for item in resp.get("Items", []):
            row = _item_to_row(item)
            if _row_matches(row, free_text, vendor_name, contract_id):
                total += 1
                if not count_only and len(collected) < limit:
                    collected.append(row)
                if count_only:
                    continue
                if len(collected) >= limit:
                    return {"rows": collected, "total_matches": total, "returned": len(collected)}
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break
        scan_kw["ExclusiveStartKey"] = last_key
    if count_only:
        return {"rows": [], "total_matches": total, "returned": 0}
    return {"rows": collected, "total_matches": total, "returned": len(collected)}
