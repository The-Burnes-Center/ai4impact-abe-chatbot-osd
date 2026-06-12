"""Shared date parsing for the Excel index pipeline.

The parser Lambda uses these to infer which columns hold dates, and the
query Lambda uses the identical format list for date_before/date_after
filtering — a single source so "the tool says this column is date-filterable"
and "the query engine can actually parse it" never drift apart.
"""
import datetime

DATE_FORMATS = [
    "%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%B %d, %Y", "%b %d, %Y",
    "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ",
]


def parse_date_like(value) -> "datetime.date | None":
    """Try common date formats; return date or None."""
    s = str(value).strip()
    if not s:
        return None
    for fmt in DATE_FORMATS:
        try:
            return datetime.datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None
