"""
Write per-index metadata to the central Index Registry DynamoDB table.
The chat Lambda reads these entries at cold-start and builds a single
generic query_excel_index tool from them.
"""
import os
from datetime import datetime, timezone

import boto3

REGISTRY_TABLE = os.environ.get("INDEX_REGISTRY_TABLE", "")
PK = "TOOLS"

_ddb = None


def _get_table():
    global _ddb
    if _ddb is None:
        _ddb = boto3.resource("dynamodb")
    return _ddb.Table(REGISTRY_TABLE)


def write_to_registry(
    index_name: str,
    display_name: str,
    columns: list[str],
    row_count: int,
) -> None:
    """Persist index metadata to the registry table."""
    if not REGISTRY_TABLE:
        print("INDEX_REGISTRY_TABLE not set; skipping registry write.")
        return

    table = _get_table()
    table.put_item(Item={
        "pk": PK,
        "sk": index_name,
        "index_name": index_name,
        "display_name": display_name,
        "columns": columns,
        "row_count": row_count,
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "status": "COMPLETE",
    })
    print(f"Wrote index metadata for '{index_name}' to registry ({len(columns)} columns, {row_count} rows).")


def delete_from_registry(index_name: str) -> None:
    """Remove an index entry from the registry table."""
    if not REGISTRY_TABLE:
        return
    table = _get_table()
    table.delete_item(Key={"pk": PK, "sk": index_name})
    print(f"Deleted index metadata for '{index_name}' from registry.")
