"""
Write per-index metadata to the central Index Registry DynamoDB table.
The chat Lambda reads these entries per-request and builds a single
generic query_excel_index tool from them.
"""
import json
import os
from datetime import datetime, timezone

import boto3

REGISTRY_TABLE = os.environ.get("INDEX_REGISTRY_TABLE", "")
PK = "TOOLS"

_ddb = None
_bedrock = None


def _get_table():
    global _ddb
    if _ddb is None:
        _ddb = boto3.resource("dynamodb")
    return _ddb.Table(REGISTRY_TABLE)


def _get_bedrock():
    global _bedrock
    if _bedrock is None:
        _bedrock = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    return _bedrock


def _generate_description(display_name: str, columns: list[str], sample_rows: list[dict]) -> str:
    """Use Bedrock to auto-generate a concise tool description for this index."""
    try:
        sample_str = json.dumps(sample_rows[:3], default=str)[:2000]
        prompt = (
            f"You are describing a data index for an AI assistant's tool catalog. "
            f"The index is called '{display_name}'. "
            f"Columns: {', '.join(columns)}. "
            f"Sample rows: {sample_str}\n\n"
            f"Write a concise 1-2 sentence description of what this index contains and what questions it can answer. "
            f"Do NOT mention column names. Focus on the business purpose."
        )
        client = _get_bedrock()
        resp = client.invoke_model(
            modelId=os.environ.get("PRIMARY_MODEL_ID", "us.anthropic.claude-sonnet-4-20250514-v1:0"),
            contentType="application/json",
            accept="application/json",
            body=json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 150,
                "messages": [{"role": "user", "content": prompt}],
            }),
        )
        result = json.loads(resp["body"].read())
        text = result.get("content", [{}])[0].get("text", "").strip()
        if text:
            print(f"AI-generated description for '{display_name}': {text}")
            return text
    except Exception as e:
        print(f"Failed to generate AI description for '{display_name}': {e}")
    return ""


def write_to_registry(
    index_name: str,
    display_name: str,
    columns: list[str],
    row_count: int,
    sample_rows: list[dict] | None = None,
) -> None:
    """Persist index metadata to the registry table. Preserves existing description or generates one."""
    if not REGISTRY_TABLE:
        print("INDEX_REGISTRY_TABLE not set; skipping registry write.")
        return

    table = _get_table()

    existing_desc = ""
    try:
        existing = table.get_item(Key={"pk": PK, "sk": index_name}).get("Item", {})
        existing_desc = existing.get("description", "") or ""
    except Exception:
        pass

    description = existing_desc
    if not description and sample_rows:
        description = _generate_description(display_name, columns, sample_rows)

    item = {
        "pk": PK,
        "sk": index_name,
        "index_name": index_name,
        "display_name": display_name,
        "columns": columns,
        "row_count": row_count,
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "status": "COMPLETE",
    }
    if description:
        item["description"] = description

    table.put_item(Item=item)
    print(f"Wrote index metadata for '{index_name}' to registry ({len(columns)} columns, {row_count} rows).")


def delete_from_registry(index_name: str) -> None:
    """Remove an index entry from the registry table."""
    if not REGISTRY_TABLE:
        return
    table = _get_table()
    table.delete_item(Key={"pk": PK, "sk": index_name})
    print(f"Deleted index metadata for '{index_name}' from registry.")
