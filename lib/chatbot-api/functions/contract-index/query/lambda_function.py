"""
Query Lambda: read contract index from DynamoDB; status, preview, or query with filters.
Invoked by chat Lambda (agent tool) or REST (admin status/preview).
Uses Pydantic for request/response validation.
"""
import json
import os
from typing import Any

import boto3
from boto3.dynamodb.conditions import Attr, Key
from pydantic import ValidationError

from models import (
    PreviewResponse,
    QueryContractIndexRequest,
    StatusResponse,
)

DDB = boto3.resource("dynamodb")
TABLE_NAME = os.environ["TABLE_NAME"]
PK = "INDEX"
SK_META = "META"

SEARCH_FIELDS = [
    "Blanket_Description",
    "Vendor_Name",
    "Agency",
    "Contract_ID",
    "Blanket_Number",
    "Buyer_Name",
    "Vendor_Contact_Name",
]


def lambda_handler(event, context):
    """Handle status, preview, or query. Event can be direct payload or API Gateway."""
    body = _get_payload(event)
    try:
        req = QueryContractIndexRequest.model_validate(body)
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
                agency=req.agency,
                contract_id=req.contract_id,
                blanket_number=req.blanket_number,
                date_from=req.date_from,
                date_to=req.date_to,
                limit=req.limit,
            )
        return _response(200, out)
    except Exception as e:
        return _response(500, {"error": str(e)})


def _get_payload(event: dict) -> dict:
    """Extract JSON body from direct invoke or API Gateway."""
    if "body" in event and isinstance(event["body"], str):
        return json.loads(event["body"]) if event["body"] else {}
    if "action" in event:
        return event
    return event.get("body") or event


def _response(status: int, body: dict | list) -> dict:
    """Return API Gateway-style response or direct invoke payload."""
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def _item_to_row(item: dict) -> dict[str, Any]:
    """Strip pk/sk from item and return row dict."""
    return {k: v for k, v in item.items() if k not in ("pk", "sk")}


def _do_status() -> dict:
    """Return status from META item in DynamoDB."""
    table = DDB.Table(TABLE_NAME)
    try:
        resp = table.get_item(Key={"pk": PK, "sk": SK_META})
    except Exception as e:
        raise RuntimeError(f"DynamoDB get failed: {e}") from e
    item = resp.get("Item")
    if not item:
        return StatusResponse(
            status="NO_DATA",
            has_data=False,
            row_count=0,
            last_updated=None,
            error_message=None,
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


def _do_preview(n: int) -> dict:
    """Query first N row items (exclude META); return columns and rows."""
    table = DDB.Table(TABLE_NAME)
    resp = table.query(
        KeyConditionExpression=Key("pk").eq(PK),
        Limit=max(n + 10, 50),
    )
    items = resp.get("Items", [])
    items = [it for it in items if it.get("sk") != SK_META]
    rows = [_item_to_row(it) for it in items][:n]
    if not rows:
        return PreviewResponse(columns=[], rows=[]).model_dump()
    columns = [k for k in rows[0].keys()]
    return PreviewResponse(columns=columns, rows=rows).model_dump()


def _row_matches(
    row: dict[str, Any],
    free_text: str | None,
    vendor_name: str | None,
    agency: str | None,
    contract_id: str | None,
    blanket_number: str | None,
    date_from: str | None,
    date_to: str | None,
) -> bool:
    """Return True if row matches all non-None filters."""
    if free_text:
        q = free_text.lower()
        if not any(
            q in (str(row.get(f, "")) or "").lower()
            for f in SEARCH_FIELDS
            if f in row
        ):
            return False
    if vendor_name and (vendor_name.lower() not in (str(row.get("Vendor_Name") or "")).lower()):
        return False
    if agency and (agency.lower() not in (str(row.get("Agency") or "")).lower()):
        return False
    if contract_id and (contract_id.lower() not in (str(row.get("Contract_ID") or "")).lower()):
        return False
    if blanket_number and (blanket_number.lower() not in (str(row.get("Blanket_Number") or "")).lower()):
        return False
    if date_from:
        begin = str(row.get("Blanket_Begin_Date") or "")
        if begin and begin < date_from:
            return False
    if date_to:
        end = str(row.get("Blanket_End_Date") or "")
        if end and end > date_to:
            return False
    return True


def _do_query(
    free_text: str | None = None,
    vendor_name: str | None = None,
    agency: str | None = None,
    contract_id: str | None = None,
    blanket_number: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 20,
) -> dict:
    """Scan table and filter in code until we have limit matches (or run out)."""
    table = DDB.Table(TABLE_NAME)
    collected = []
    scan_kw = {"FilterExpression": Attr("pk").eq(PK) & Attr("sk").ne(SK_META)}
    while True:
        resp = table.scan(**scan_kw)
        for item in resp.get("Items", []):
            row = _item_to_row(item)
            if _row_matches(
                row,
                free_text=free_text,
                vendor_name=vendor_name,
                agency=agency,
                contract_id=contract_id,
                blanket_number=blanket_number,
                date_from=date_from,
                date_to=date_to,
            ):
                collected.append(row)
                if len(collected) >= limit:
                    return {"rows": collected, "total_matches": len(collected), "returned": len(collected)}
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break
        scan_kw["ExclusiveStartKey"] = last_key
    return {"rows": collected, "total_matches": len(collected), "returned": len(collected)}
