"""
Pydantic models for SWC (Statewide Contract) Index rows.
Validates and serializes Excel rows to JSON for agent queries.
"""
from datetime import date, datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, field_validator


# Expected column order from SWCIndex.xlsx (reference schema)
SWC_INDEX_COLUMNS = [
    "Contract_ID",
    "Blanket Number",
    "Blanket Description",
    "Blanket Begin Date",
    "Blanket End Date",
    "Agency",
    "Buyer Name",
    "Buyer Email",
    "Buyer Phone",
    "Buyer Contact Information",
    "Org PO Type",
    "Vendor Distributor",
    "Vendor Name and Nbr Formatted",
    "Vendor Number",
    "Vendor Name",
    "Vendor Contact Name",
    "Vendor Email Address",
    "Vendor Phone Number",
    "Vendor Phone Extension",
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
    "VendorCertificates",
    "CategoryManager1Contact",
    "CategoryManager1Email",
    "CategoryManager1Phone",
    "CategoryManager2Contact",
    "CategoryManager2Email",
    "CategoryManager2Phone",
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
    Blanket_Description: Optional[str] = ""
    Blanket_Begin_Date: Optional[str] = ""
    Blanket_End_Date: Optional[str] = ""
    Agency: Optional[str] = ""
    Buyer_Name: Optional[str] = ""
    Buyer_Email: Optional[str] = ""
    Buyer_Phone: Optional[str] = ""
    Buyer_Contact_Information: Optional[str] = ""
    Org_PO_Type: Optional[str] = ""
    Vendor_Distributor: Optional[str] = ""
    Vendor_Name_and_Nbr_Formatted: Optional[str] = ""
    Vendor_Number: Optional[str] = ""
    Vendor_Name: Optional[str] = ""
    Vendor_Contact_Name: Optional[str] = ""
    Vendor_Email_Address: Optional[str] = ""
    Vendor_Phone_Number: Optional[str] = ""
    Vendor_Phone_Extension: Optional[str] = ""
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
    VendorCertificates: Optional[str] = ""
    CategoryManager1Contact: Optional[str] = ""
    CategoryManager1Email: Optional[str] = ""
    CategoryManager1Phone: Optional[str] = ""
    CategoryManager2Contact: Optional[str] = ""
    CategoryManager2Email: Optional[str] = ""
    CategoryManager2Phone: Optional[str] = ""

    @field_validator("*", mode="before")
    @classmethod
    def coerce_to_str(cls, v: Any) -> str:
        return _to_str(v)

    model_config = ConfigDict(extra="ignore")


def excel_column_to_field(name: str) -> str:
    """Map Excel column header to Pydantic field name (spaces -> underscores)."""
    return name.strip().replace(" ", "_")


def field_to_excel_column(name: str) -> str:
    """Map Pydantic field name back to Excel column header."""
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
