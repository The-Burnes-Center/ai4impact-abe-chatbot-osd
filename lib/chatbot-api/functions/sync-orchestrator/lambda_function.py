"""
Sync Orchestrator Lambda -- moves staged files to their target buckets and triggers KB ingestion.

Invoked by the admin UI "Sync data now" action. Performs three steps:

  1. **Documents**: copies all files from ``staging/documents/`` to the Knowledge
     Base source bucket, then deletes them from staging. These become available
     to the Bedrock Knowledge Base after ingestion completes.
  2. **Index files**: copies all files from ``staging/indexes/`` to the Excel
     index bucket (preserving the ``indexes/{id}/latest.xlsx`` key structure),
     then deletes from staging. The index bucket has its own S3 event trigger
     that automatically invokes the Excel parser Lambda.
  3. **KB ingestion**: starts a Bedrock Knowledge Base ingestion job (unless
     one is already running or starting) so newly uploaded documents are
     indexed into OpenSearch.

A history record is written to DynamoDB on every run with status, file counts,
duration, and a 90-day TTL for automatic cleanup.

Also supports a **backfill-only mode** (``{"backfillOnly": true}``, fired by an
hourly EventBridge schedule): runs just the metadata backfill so documents get
their LLM summaries once KB ingestion has actually completed, without moving
staged files, starting ingestion, or writing a history record.
"""
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
lambda_client = boto3.client("lambda")
dynamodb = boto3.resource("dynamodb")

STAGING_BUCKET = os.environ["STAGING_BUCKET"]
KB_BUCKET = os.environ["KB_BUCKET"]
INDEX_BUCKET = os.environ["INDEX_BUCKET"]
KB_ID = os.environ["KB_ID"]
KB_DATA_SOURCE_ID = os.environ["KB_DATA_SOURCE_ID"]
SYNC_HISTORY_TABLE = os.environ["SYNC_HISTORY_TABLE"]
METADATA_HANDLER_FUNCTION = os.environ.get("METADATA_HANDLER_FUNCTION")

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
    """Atomically move an S3 object by copying to the destination then deleting the source."""
    target = dest_key or key
    s3.copy_object(
        Bucket=dest_bucket,
        CopySource={"Bucket": source_bucket, "Key": key},
        Key=target,
    )
    s3.delete_object(Bucket=source_bucket, Key=key)


def _start_kb_ingestion():
    """Start a Bedrock KB ingestion job if none is currently running or starting.

    Checks for IN_PROGRESS and STARTING jobs first to avoid launching duplicate
    ingestion runs, which would waste resources and could cause race conditions.
    """
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


def _is_placeholder_summary(summary: str) -> bool:
    """True when a head-metadata ``summary`` is missing or is a failure artifact.

    Two kinds of artifacts count as missing so the backfill regenerates them:

    - Explicit error markers the metadata-handler used to persist, e.g.
      "Error generating summary" / "Error parsing nested JSON in 'text'".
    - LLM filler produced when summarization ran before KB ingestion: the
      handler used to pass the literal string "No relevant document found in
      the knowledge base." to the model as the document, and the model wrote a
      fluent paragraph about the document being unretrievable. Those summaries
      all reference the knowledge base plus a retrieval-failure phrase, which
      real procurement-document summaries don't.
    """
    s = (summary or "").strip().lower()
    if not s:
        return True
    if s.startswith("error "):
        return True
    if "knowledge base" in s and any(
        marker in s
        for marker in (
            "no relevant",
            "could not be retrieved",
            "could not be analyzed",
            "not found",
            "no text",
            "cannot be provided",
        )
    ):
        return True
    return False


def _rebuild_metadata_file(head_metadata: dict[str, dict]) -> None:
    """Rewrite ``metadata.txt`` if it no longer matches S3 head metadata.

    Each metadata-handler invocation rewrites metadata.txt from a fresh scan,
    but concurrent invocations race: the last writer's scan can predate
    another writer's head-metadata update, leaving metadata.txt missing
    summaries that exist in head metadata. The backfill loop already HEADs
    every object, so reconciling here costs one GetObject and (rarely) one
    PutObject. The metadata-handler ignores events for metadata.txt itself,
    so this write does not recurse.
    """
    try:
        try:
            resp = s3.get_object(Bucket=KB_BUCKET, Key="metadata.txt")
            current = json.loads(resp["Body"].read())
        except Exception:
            current = None
        if current == head_metadata:
            return
        s3.put_object(
            Bucket=KB_BUCKET,
            Key="metadata.txt",
            Body=json.dumps(head_metadata, indent=4),
            ContentType="text/plain",
        )
        logger.info("Rebuilt stale metadata.txt (%d entries)", len(head_metadata))
    except Exception as e:
        logger.warning("Failed to rebuild metadata.txt: %s", e)


def _backfill_missing_metadata(
    skip_keys: set[str] | None = None,
    reconcile_metadata_file: bool = False,
) -> int:
    """Invoke the metadata-handler for any KB-bucket object lacking a ``summary``.

    The metadata-handler used to skip every ``ObjectCreated:Copy`` event to
    avoid recursion from its own self-copy, which meant sync-pushed files
    silently never got summaries. That bug is fixed, but pre-existing files
    in the KB bucket still have empty metadata. This step runs on every sync
    so any backlog (or future failure) gets cleared automatically, with no
    manual script required across deployments.

    For each object without a ``summary`` field in its S3 head metadata, an
    asynchronous Lambda invocation fires a synthetic ``ObjectCreated:Put``
    event into the metadata-handler. Files that already have a summary are
    left alone, so the cost is O(missing) per sync, not O(bucket).

    Returns the number of files for which a backfill invocation was fired.
    """
    if not METADATA_HANDLER_FUNCTION:
        logger.info("METADATA_HANDLER_FUNCTION not configured; skipping backfill")
        return 0

    fired = 0
    head_metadata: dict[str, dict] = {}
    paginator = s3.get_paginator("list_objects_v2")
    try:
        for page in paginator.paginate(Bucket=KB_BUCKET):
            for obj in page.get("Contents", []):
                key = obj.get("Key")
                if not key or key.endswith("/"):
                    continue
                try:
                    head = s3.head_object(Bucket=KB_BUCKET, Key=key)
                except Exception as e:
                    logger.warning("head_object failed for %s, skipping: %s", key, e)
                    continue
                meta = head.get("Metadata") or {}
                head_metadata[key] = meta
                if key == "metadata.txt":
                    continue
                # Freshly-moved files in this run already have an in-flight
                # ObjectCreated:Copy event; skip them so we don't fire a
                # duplicate Bedrock summarization on the same file.
                if skip_keys and key in skip_keys:
                    continue
                # Skip only when there's a real summary; empty values, error
                # markers, and pre-ingestion LLM filler all count as missing
                # so they get regenerated on the next pass.
                if not _is_placeholder_summary(meta.get("summary") or ""):
                    continue
                payload = {
                    "Records": [
                        {
                            "eventSource": "aws:s3",
                            "eventName": "ObjectCreated:Put",
                            "s3": {
                                "bucket": {"name": KB_BUCKET},
                                "object": {"key": key},
                            },
                        }
                    ]
                }
                try:
                    lambda_client.invoke(
                        FunctionName=METADATA_HANDLER_FUNCTION,
                        InvocationType="Event",
                        Payload=json.dumps(payload).encode("utf-8"),
                    )
                    fired += 1
                except Exception as e:
                    logger.warning("Failed to invoke metadata-handler for %s: %s", key, e)
    except Exception as e:
        logger.error("Backfill scan failed: %s", e, exc_info=True)

    if fired:
        logger.info("Metadata backfill: fired %d invocation(s)", fired)
    else:
        logger.info("Metadata backfill: nothing to do")
        # Only reconcile when nothing was fired: in-flight handler
        # invocations rewrite metadata.txt themselves when they finish.
        if reconcile_metadata_file and head_metadata:
            _rebuild_metadata_file(head_metadata)
    return fired


def _record_history(status: str, kb_docs: int, index_files: int, duration_ms: int, error: str | None = None):
    """Write a sync-run history record to DynamoDB with a 90-day TTL."""
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
    """Orchestrate a full sync: move staged files and trigger KB ingestion.

    Returns a 200 response with counts of moved documents and index files,
    or a 500 with the error message if any step fails. A history record is
    written regardless of outcome.
    """
    # Backfill-only mode (hourly EventBridge schedule): regenerate summaries
    # for documents whose KB chunks now exist. Summaries can't be generated at
    # upload time -- ingestion runs minutes-to-hours after the S3 events fire
    # -- so this pass is what actually fills them in. It must not move staged
    # files (sync stays an explicit admin action), start ingestion, or write a
    # sync-history record that would clutter the admin UI.
    if isinstance(event, dict) and event.get("backfillOnly"):
        logger.info("Metadata backfill-only run")
        fired = _backfill_missing_metadata(reconcile_metadata_file=True)
        return {
            "statusCode": 200,
            "body": json.dumps({"status": "SUCCESS", "backfillInvocations": fired}),
        }

    logger.info("Sync orchestrator invoked")
    start = time.time()
    kb_docs_moved = 0
    index_files_moved = 0

    moved_kb_keys: set[str] = set()

    try:
        doc_objects = _list_all_objects(STAGING_BUCKET, DOCS_PREFIX)
        logger.info("Found %d document(s) in staging", len(doc_objects))
        for obj in doc_objects:
            filename = obj["Key"][len(DOCS_PREFIX):]
            if not filename:
                continue
            _copy_and_delete(STAGING_BUCKET, KB_BUCKET, obj["Key"], filename)
            kb_docs_moved += 1
            moved_kb_keys.add(filename)
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

        # Backfill metadata summaries for any KB-bucket file that doesn't have
        # one yet. Covers older files that fell through the previous copy-skip
        # bug. Freshly-moved files already have an in-flight ObjectCreated:Copy
        # event from the move above, so we skip them here.
        _backfill_missing_metadata(skip_keys=moved_kb_keys)

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
