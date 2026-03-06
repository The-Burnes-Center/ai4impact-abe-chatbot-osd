"""
Pydantic models for generic Excel index query Lambda.
"""
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class QueryIndexRequest(BaseModel):
    """Request payload for query Lambda (agent or REST)."""
    action: Literal["query", "status", "preview"] = "query"
    index_name: str
    free_text: Optional[str] = None
    filters: Optional[dict[str, Any]] = None
    count_only: bool = False
    count_unique: Optional[str] = None
    group_by: Optional[str] = None
    columns: Optional[list[str]] = None
    limit: int = Field(default=100, ge=1, le=500)
    offset: int = Field(default=0, ge=0)
    preview_rows: int = Field(default=10, ge=1, le=50)


class StatusResponse(BaseModel):
    status: Literal["NO_DATA", "PROCESSING", "COMPLETE", "ERROR"] = "NO_DATA"
    has_data: bool = False
    row_count: int = 0
    last_updated: Optional[str] = None
    error_message: Optional[str] = None


class PreviewResponse(BaseModel):
    columns: list[str]
    rows: list[dict[str, Any]]
