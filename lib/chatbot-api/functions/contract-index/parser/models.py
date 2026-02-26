"""
Pydantic models for SWC (Statewide Contract) Index rows.
Validates and serializes Excel rows to JSON for agent queries.
"""
from datetime import date, datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, field_validator


# Expected column headers from SWCIndex_v2.xlsx (32 data columns)
SWC_INDEX_COLUMNS = [
    "Contract_ID",
    "Blanket Number",
    "Statewide Contract Description",
    "Master Blanket/Contract EndDate",
    "CUG Keywords",
    "Agency",
    "Purchaser/Category Manager",
    "Purchaser Email",
    "Purchaser Phone",
    "Purchaser Contact",
    "Vendor Number",
    "Vendor Name",
    "Vendor Contact Name",
    "Vendor Email Address",
    "Vendor Phone Number",
    "Vendor Fax Number",
    "Vendor Address Line 1",
    "Vendor Address Line 2",
    "Vendor City",
    "Vendor State",
    "Vendor Zip",
    "Punchout Enabled",
    "Solicitation Enabled",
    "Group Blanket Release Type",
    "RPA Release Allowed",
    "Vendor Certificates",
    "CategoryManager-1 Contact",
    "CategoryManager-1 Email",
    "CategoryManager-1 Phone",
    "CategoryManager-2 Contact",
    "CategoryManager-2 Email",
    "CategoryManager-2 Phone",
]


def _to_str(v: Any) -> str:
    """Normalize cell value to string for JSON."""
    if v is None:
        return ""
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    return str(v).strip()


class SWCRow(BaseModel):
    """One row of the SWC Index. All fields optional for robustness."""

    Contract_ID: Optional[str] = ""
    Blanket_Number: Optional[str] = ""
    Statewide_Contract_Description: Optional[str] = ""
    Master_Blanket_Contract_EndDate: Optional[str] = ""
    CUG_Keywords: Optional[str] = ""
    Agency: Optional[str] = ""
    Purchaser_Category_Manager: Optional[str] = ""
    Purchaser_Email: Optional[str] = ""
    Purchaser_Phone: Optional[str] = ""
    Purchaser_Contact: Optional[str] = ""
    Vendor_Number: Optional[str] = ""
    Vendor_Name: Optional[str] = ""
    Vendor_Contact_Name: Optional[str] = ""
    Vendor_Email_Address: Optional[str] = ""
    Vendor_Phone_Number: Optional[str] = ""
    Vendor_Fax_Number: Optional[str] = ""
    Vendor_Address_Line_1: Optional[str] = ""
    Vendor_Address_Line_2: Optional[str] = ""
    Vendor_City: Optional[str] = ""
    Vendor_State: Optional[str] = ""
    Vendor_Zip: Optional[str] = ""
    Punchout_Enabled: Optional[str] = ""
    Solicitation_Enabled: Optional[str] = ""
    Group_Blanket_Release_Type: Optional[str] = ""
    RPA_Release_Allowed: Optional[str] = ""
    Vendor_Certificates: Optional[str] = ""
    CategoryManager_1_Contact: Optional[str] = ""
    CategoryManager_1_Email: Optional[str] = ""
    CategoryManager_1_Phone: Optional[str] = ""
    CategoryManager_2_Contact: Optional[str] = ""
    CategoryManager_2_Email: Optional[str] = ""
    CategoryManager_2_Phone: Optional[str] = ""

    @field_validator("*", mode="before")
    @classmethod
    def coerce_to_str(cls, v: Any) -> str:
        return _to_str(v)

    model_config = ConfigDict(extra="ignore")


def excel_column_to_field(name: str) -> str:
    """Map Excel column header to Pydantic field name."""
    return name.strip().replace(" ", "_").replace("/", "_").replace("-", "_")


def field_to_excel_column(name: str) -> str:
    """Map Pydantic field name back to human-readable column header."""
    return name.replace("_", " ")


def row_dict_from_excel_row(headers: list[str], values: tuple) -> dict[str, Any]:
    """Build a dict suitable for SWCRow from header names and cell values."""
    out: dict[str, Any] = {}
    for i, header in enumerate(headers):
        if i < len(values):
            val = values[i]
            field = excel_column_to_field(header)
            if field in SWCRow.model_fields:
                out[field] = _to_str(val) if val is not None else ""
    return out
