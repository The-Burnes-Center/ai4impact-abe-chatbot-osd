"""
Models for Excel Index rows.
Schema-flexible: stores all columns from the uploaded spreadsheet.
Column names are normalized (spaces/slashes/dashes -> underscores).
"""
import re
from datetime import date, datetime
from typing import Any

from abe_utils.dates import parse_date_like

_MULTI_WS = re.compile(r"\s+")


def _to_str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    # Collapse internal whitespace runs (newlines, tabs, double spaces) so
    # stray formatting in source spreadsheets doesn't break fuzzy matching.
    return _MULTI_WS.sub(" ", str(v)).strip()


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


def infer_date_columns(col_names: list[str], rows: list[dict], sample_limit: int = 200) -> list[str]:
    """Infer which columns hold dates, purely from the data (no name heuristics).

    A column qualifies when, over the first ``sample_limit`` rows, it has at
    least 3 non-empty values and at least 80% of those non-empty values are
    parseable by ``parse_date_like``. Returns column names in ``col_names``
    order so downstream consumers (tool descriptions) stay deterministic.
    """
    sample = rows[:sample_limit]
    date_cols: list[str] = []
    for col in col_names:
        non_empty = 0
        parsed = 0
        for row in sample:
            val = str(row.get(col) or "").strip()
            if not val:
                continue
            non_empty += 1
            if parse_date_like(val) is not None:
                parsed += 1
        if non_empty >= 3 and parsed >= 0.8 * non_empty:
            date_cols.append(col)
    return date_cols
