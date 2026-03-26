import json
import os
import time
import logging
from datetime import datetime, timezone, timedelta

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")
bedrock_agent = boto3.client("bedrock-agent")
dynamodb = boto3.resource("dynamodb")

STAGING_BUCKET = os.environ["STAGING_BUCKET"]
KB_BUCKET = os.environ["KB_BUCKET"]
INDEX_BUCKET = os.environ["INDEX_BUCKET"]
KB_ID = os.environ["KB_ID"]
KB_DATA_SOURCE_ID = os.environ["KB_DATA_SOURCE_ID"]
SYNC_HISTORY_TABLE = os.environ["SYNC_HISTORY_TABLE"]

history_table = dynamodb.Table(SYNC_HISTORY_TABLE)

DOCS_PREFIX = "documents/"
INDEXES_PREFIX = "indexes/"


def _list_all_objects(bucket: str, prefix: str) -> list[dict]:
    """Return all S3 objects under a prefix (handles pagination)."""
    objects = []
    params = {"Bucket": bucket, "Prefix": prefix}
    while True:
        resp = s3.list_objects_v2(**params)
        for obj in resp.get("Contents", []):
            if not obj["Key"].endswith("/"):
                objects.append(obj)
        if not resp.get("IsTruncated"):
            break
        params["ContinuationToken"] = resp["NextContinuationToken"]
    return objects


def _copy_and_delete(source_bucket: str, dest_bucket: str, key: str, dest_key: str | None = None):
    target = dest_key or key
    s3.copy_object(
        Bucket=dest_bucket,
        CopySource={"Bucket": source_bucket, "Key": key},
        Key=target,
    )
    s3.delete_object(Bucket=source_bucket, Key=key)


def _start_kb_ingestion():
    running = bedrock_agent.list_ingestion_jobs(
        dataSourceId=KB_DATA_SOURCE_ID,
        knowledgeBaseId=KB_ID,
        filters=[{"attribute": "STATUS", "operator": "EQ", "values": ["IN_PROGRESS"]}],
    )
    starting = bedrock_agent.list_ingestion_jobs(
        dataSourceId=KB_DATA_SOURCE_ID,
        knowledgeBaseId=KB_ID,
        filters=[{"attribute": "STATUS", "operator": "EQ", "values": ["STARTING"]}],
    )
    already_running = (
        running["ingestionJobSummaries"] + starting["ingestionJobSummaries"]
    )
    if already_running:
        logger.info("KB ingestion already running, skipping start")
        return

    resp = bedrock_agent.start_ingestion_job(
        dataSourceId=KB_DATA_SOURCE_ID,
        knowledgeBaseId=KB_ID,
    )
    logger.info("KB ingestion started: %s", resp["ingestionJob"]["ingestionJobId"])


def _record_history(status: str, kb_docs: int, index_files: int, duration_ms: int, error: str | None = None):
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=90)
    item = {
        "pk": "RUN",
        "sk": now.isoformat().replace("+00:00", "Z"),
        "status": status,
        "kbDocsCount": kb_docs,
        "indexFilesCount": index_files,
        "durationMs": duration_ms,
        "expiresAt": int(expires.timestamp()),
    }
    if error:
        item["error"] = error[:2000]
    history_table.put_item(Item=item)


def lambda_handler(event, context):
    logger.info("Sync orchestrator invoked")
    start = time.time()
    kb_docs_moved = 0
    index_files_moved = 0

    try:
        doc_objects = _list_all_objects(STAGING_BUCKET, DOCS_PREFIX)
        logger.info("Found %d document(s) in staging", len(doc_objects))
        for obj in doc_objects:
            filename = obj["Key"][len(DOCS_PREFIX):]
            if not filename:
                continue
            _copy_and_delete(STAGING_BUCKET, KB_BUCKET, obj["Key"], filename)
            kb_docs_moved += 1
            logger.info("Moved document: %s", filename)

        idx_objects = _list_all_objects(STAGING_BUCKET, INDEXES_PREFIX)
        logger.info("Found %d index file(s) in staging", len(idx_objects))
        for obj in idx_objects:
            dest_key = obj["Key"]
            if not dest_key[len(INDEXES_PREFIX):]:
                continue
            _copy_and_delete(STAGING_BUCKET, INDEX_BUCKET, obj["Key"], dest_key)
            index_files_moved += 1
            logger.info("Moved index file: %s", dest_key)

        _start_kb_ingestion()

        duration_ms = int((time.time() - start) * 1000)
        _record_history("SUCCESS", kb_docs_moved, index_files_moved, duration_ms)

        logger.info(
            "Sync complete: %d docs, %d indexes in %dms",
            kb_docs_moved, index_files_moved, duration_ms,
        )
        return {
            "statusCode": 200,
            "body": json.dumps({
                "status": "SUCCESS",
                "kbDocsCount": kb_docs_moved,
                "indexFilesCount": index_files_moved,
                "durationMs": duration_ms,
            }),
        }

    except Exception as e:
        duration_ms = int((time.time() - start) * 1000)
        logger.error("Sync orchestrator failed: %s", e, exc_info=True)
        _record_history("FAILED", kb_docs_moved, index_files_moved, duration_ms, str(e))
        return {
            "statusCode": 500,
            "body": json.dumps({"status": "FAILED", "error": str(e)}),
        }
