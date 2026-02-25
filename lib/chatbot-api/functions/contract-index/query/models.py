"""
Pydantic models for contract-index query Lambda: request and response validation.
"""
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class QueryContractIndexRequest(BaseModel):
    """Request payload for query Lambda (agent or REST)."""
    action: Literal["query", "status", "preview"] = "query"
    # Query params (for action=query)
    free_text: Optional[str] = None
    vendor_name: Optional[str] = None
    agency: Optional[str] = None
    contract_id: Optional[str] = None
    blanket_number: Optional[str] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    limit: int = Field(default=20, ge=1, le=100)
    # Preview (for action=preview)
    preview_rows: int = Field(default=10, ge=1, le=50)


class StatusResponse(BaseModel):
    """Response for action=status."""
    status: Literal["NO_DATA", "PROCESSING", "COMPLETE", "ERROR"] = "NO_DATA"
    has_data: bool = False
    row_count: int = 0
    last_updated: Optional[str] = None
    error_message: Optional[str] = None


class PreviewResponse(BaseModel):
    """Response for action=preview."""
    columns: list[str]
    rows: list[dict[str, Any]]


# Row dict from current.json (keys are SWCRow field names with underscores)
ContractRow = dict[str, Any]
