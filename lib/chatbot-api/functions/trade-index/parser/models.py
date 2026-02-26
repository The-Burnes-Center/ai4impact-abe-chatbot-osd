"""
Pydantic models for Trade Contract Index rows.
Schema-flexible: stores all columns from the uploaded spreadsheet.
Column names are normalized (spaces/slashes/dashes → underscores).
"""
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


def _to_str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return str(v).strip()


def excel_column_to_field(name: str) -> str:
    """Map Excel column header to normalized field name."""
    return name.strip().replace(" ", "_").replace("/", "_").replace("-", "_")


def row_dict_from_excel_row(headers: list[str], values: tuple) -> dict[str, Any]:
    """Build a dict from header names and cell values. Stores all non-empty columns."""
    out: dict[str, Any] = {}
    for i, header in enumerate(headers):
        if not header:
            continue
        if i < len(values):
            field = excel_column_to_field(header)
            out[field] = _to_str(values[i])
    return out
