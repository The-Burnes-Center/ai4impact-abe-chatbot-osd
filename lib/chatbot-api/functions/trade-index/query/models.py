"""
Pydantic models for trade-index query Lambda: request and response validation.
"""
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class QueryTradeIndexRequest(BaseModel):
    """Request payload for Trade Index query Lambda."""
    action: Literal["query", "status", "preview"] = "query"
    free_text: Optional[str] = None
    vendor_name: Optional[str] = None
    contract_id: Optional[str] = None
    count_only: bool = False
    limit: int = Field(default=500, ge=1, le=500)
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
