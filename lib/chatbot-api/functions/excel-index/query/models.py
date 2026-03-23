"""
Pydantic models for generic Excel index query Lambda.
"""
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, model_validator


class QueryIndexRequest(BaseModel):
    """Request payload for query Lambda (agent or REST)."""
    action: Literal["query", "status", "preview"] = "query"
    index_name: str
    free_text: Optional[str] = None
    filters: Optional[dict[str, Any]] = None
    date_before: Optional[dict[str, str]] = None
    date_after: Optional[dict[str, str]] = None
    count_only: bool = False
    count_unique: Optional[str] = None
    group_by: Optional[str] = None
    group_by_value_max: Optional[str] = None
    distinct_values: Optional[str] = None
    min_value: Optional[str] = None
    max_value: Optional[str] = None
    sort_by: Optional[str] = None
    sort_order: Literal["asc", "desc"] = "asc"
    columns: Optional[list[str]] = None
    limit: int = Field(default=100, ge=1, le=500)
    offset: int = Field(default=0, ge=0)
    preview_rows: int = Field(default=10, ge=1, le=50)

    @model_validator(mode="after")
    def group_max_requires_group(self):
        if self.group_by_value_max and not self.group_by:
            raise ValueError("group_by_value_max requires group_by")
        return self


class StatusResponse(BaseModel):
    status: Literal["NO_DATA", "PROCESSING", "COMPLETE", "ERROR"] = "NO_DATA"
    has_data: bool = False
    row_count: int = 0
    last_updated: Optional[str] = None
    error_message: Optional[str] = None


class PreviewResponse(BaseModel):
    columns: list[str]
    rows: list[dict[str, Any]]
