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
                date_before=req.date_before,
                date_after=req.date_after,
                count_only=req.count_only,
                count_unique=req.count_unique,
                group_by=req.group_by,
                group_by_value_max=req.group_by_value_max,
                distinct_values=req.distinct_values,
                min_value=req.min_value,
                max_value=req.max_value,
                sort_by=req.sort_by,
                sort_order=req.sort_order,
                columns=req.columns,
                limit=req.limit,
                offset=req.offset,
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


_DATE_FORMATS = [
    "%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%B %d, %Y", "%b %d, %Y",
    "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ",
]

def _parse_date(val: str) -> "datetime.date | None":
    """Try common date formats; return date or None."""
    import datetime
    s = str(val).strip()
    if not s:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _row_matches(
    row: dict[str, Any],
    free_text: str | None,
    filters: dict[str, Any] | None,
    date_before: dict[str, str] | None = None,
    date_after: dict[str, str] | None = None,
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
    if date_before:
        for col, threshold_str in date_before.items():
            threshold = _parse_date(threshold_str)
            cell_date = _parse_date(str(row.get(col) or ""))
            if threshold is None:
                continue
            if cell_date is None or cell_date >= threshold:
                return False
    if date_after:
        for col, threshold_str in date_after.items():
            threshold = _parse_date(threshold_str)
            cell_date = _parse_date(str(row.get(col) or ""))
            if threshold is None:
                continue
            if cell_date is None or cell_date <= threshold:
                return False
    return True


def _project_row(row: dict[str, Any], columns: list[str] | None) -> dict[str, Any]:
    """Return only the requested columns from a row, or all columns if None."""
    if columns is None:
        return row
    cols_set = set(columns)
    return {k: v for k, v in row.items() if k in cols_set}


def _cmp_for_max(cell: Any) -> tuple | None:
    """Comparable tuple for max aggregation (dates, numbers, then string)."""
    if cell is None:
        return None
    s = str(cell).strip()
    if not s:
        return None
    d = _parse_date(s)
    if d is not None:
        return (0, d)
    try:
        return (0, float(cell))
    except (ValueError, TypeError):
        return (1, s.lower())


def _do_query(
    pk: str,
    free_text: str | None = None,
    filters: dict[str, Any] | None = None,
    date_before: dict[str, str] | None = None,
    date_after: dict[str, str] | None = None,
    count_only: bool = False,
    count_unique: str | None = None,
    group_by: str | None = None,
    group_by_value_max: str | None = None,
    distinct_values: str | None = None,
    min_value: str | None = None,
    max_value: str | None = None,
    sort_by: str | None = None,
    sort_order: str = "asc",
    columns: list[str] | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict:
    """Scan partition and filter in code. Scans all pages for accurate totals."""
    if group_by_value_max and not group_by:
        raise ValueError("group_by_value_max requires group_by")
    table = DDB.Table(TABLE_NAME)
    all_matched: list[dict] = []
    total = 0
    unique_vals: set[str] = set() if count_unique else None
    group_counts: dict[str, int] = {} if group_by else None
    group_max_cmp: dict[str, tuple] = {}
    group_max_display: dict[str, str] = {}
    distinct_set: set[str] = set() if distinct_values else None
    min_raw: Any = None
    max_raw: Any = None

    scan_kw: dict[str, Any] = {"FilterExpression": Attr("pk").eq(pk) & Attr("sk").ne(SK_META)}
    while True:
        resp = table.scan(**scan_kw)
        for item in resp.get("Items", []):
            row = _item_to_row(item)
            if _row_matches(row, free_text=free_text, filters=filters,
                            date_before=date_before, date_after=date_after):
                total += 1
                if unique_vals is not None:
                    val = str(row.get(count_unique) or "").strip()
                    if val:
                        unique_vals.add(val)
                if group_counts is not None:
                    gval = str(row.get(group_by) or "").strip() or "(empty)"
                    group_counts[gval] = group_counts.get(gval, 0) + 1
                    if group_by_value_max:
                        cmp_v = _cmp_for_max(row.get(group_by_value_max))
                        if cmp_v is not None:
                            prev = group_max_cmp.get(gval)
                            if prev is None or cmp_v > prev:
                                group_max_cmp[gval] = cmp_v
                                group_max_display[gval] = str(row.get(group_by_value_max) or "").strip()
                if distinct_set is not None:
                    dval = str(row.get(distinct_values) or "").strip()
                    if dval:
                        distinct_set.add(dval)
                if min_value is not None:
                    cell = row.get(min_value)
                    if cell is not None and str(cell).strip():
                        cmp = _parse_date(str(cell)) or str(cell).strip()
                        if min_raw is None or cmp < min_raw:
                            min_raw = cmp
                if max_value is not None:
                    cell = row.get(max_value)
                    if cell is not None and str(cell).strip():
                        cmp = _parse_date(str(cell)) or str(cell).strip()
                        if max_raw is None or cmp > max_raw:
                            max_raw = cmp
                if not count_only:
                    all_matched.append(row)
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            break
        scan_kw["ExclusiveStartKey"] = last_key

    if sort_by and not count_only and all_matched:
        def _sort_key(r: dict) -> Any:
            v = r.get(sort_by)
            d = _parse_date(str(v)) if v is not None else None
            if d is not None:
                return (0, d)
            try:
                return (0, float(v))
            except (ValueError, TypeError):
                return (1, str(v or "").lower())
        all_matched.sort(key=_sort_key, reverse=(sort_order == "desc"))

    collected = []
    if not count_only:
        page = all_matched[offset:offset + limit]
        collected = [_project_row(r, columns) for r in page]

    result: dict[str, Any] = {
        "rows": collected,
        "total_matches": total,
        "returned": len(collected),
        "offset": offset,
    }
    if unique_vals is not None:
        result["unique_count"] = len(unique_vals)
        result["unique_column"] = count_unique
    if group_counts is not None:
        result["group_by"] = group_by
        result["groups"] = dict(sorted(group_counts.items()))
    if group_by_value_max and group_max_display:
        result["group_by_value_max_column"] = group_by_value_max
        result["group_max_values"] = dict(sorted(group_max_display.items()))
    if distinct_set is not None:
        result["distinct_values"] = sorted(distinct_set)
        result["distinct_column"] = distinct_values
        result["distinct_count"] = len(distinct_set)
    if min_value is not None and min_raw is not None:
        result["min"] = {"column": min_value, "value": str(min_raw)}
    if max_value is not None and max_raw is not None:
        result["max"] = {"column": max_value, "value": str(max_raw)}
    return result
