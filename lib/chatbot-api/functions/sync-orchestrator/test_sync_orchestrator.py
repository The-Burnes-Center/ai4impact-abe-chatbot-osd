"""
Unit tests for the sync-orchestrator Lambda.
Covers placeholder-summary detection, the metadata backfill loop, and the
backfill-only invocation mode. All AWS calls are mocked.
"""
import importlib.util
import json
import os
from unittest.mock import MagicMock, patch

import pytest

ORCH_DIR = os.path.dirname(__file__)
_LF_PATH = os.path.join(ORCH_DIR, "lambda_function.py")

_ENV = {
    "STAGING_BUCKET": "staging-bucket",
    "KB_BUCKET": "kb-bucket",
    "INDEX_BUCKET": "index-bucket",
    "KB_ID": "kb-id",
    "KB_DATA_SOURCE_ID": "ds-id",
    "SYNC_HISTORY_TABLE": "sync-history",
    "METADATA_HANDLER_FUNCTION": "metadata-handler-fn",
    "AWS_DEFAULT_REGION": "us-east-1",
}


@pytest.fixture()
def lf(monkeypatch):
    """Load the orchestrator module with env set and AWS clients mocked."""
    for var, val in _ENV.items():
        monkeypatch.setenv(var, val)
    spec = importlib.util.spec_from_file_location("sync_orchestrator_lf", _LF_PATH)
    mod = importlib.util.module_from_spec(spec)
    with patch("boto3.client"), patch("boto3.resource"):
        spec.loader.exec_module(mod)
    return mod


# Real examples from the nonprod bucket: filler the model produced when asked
# to summarize the old "No relevant document found" sentinel pre-ingestion.
PLACEHOLDER_SUMMARIES = [
    "",
    "   ",
    "Error generating summary",
    "Error parsing nested JSON in 'text'",
    "No relevant document content was found in the knowledge base for the "
    "file 'CUG_ENE53.pdf'. The document could not be retrieved or analyzed, "
    "as no text or data was available for processing.",
    "The document '801cmr21.pdf' could not be retrieved or analyzed as no "
    "relevant content was found in the knowledge base.",
]

REAL_SUMMARY = (
    "This document is a Contract User Guide for ITT72 Category 1 Public "
    "Safety Grade Wireless (PSGW), a Massachusetts Statewide Contract for "
    "Cellular Services & Devices. It covers the contract term, eligible "
    "organizations, pricing options, and purchasing procedures via COMMBUYS."
)


class TestIsPlaceholderSummary:
    @pytest.mark.parametrize("summary", PLACEHOLDER_SUMMARIES)
    def test_placeholders_detected(self, lf, summary):
        assert lf._is_placeholder_summary(summary) is True

    def test_real_summary_kept(self, lf):
        assert lf._is_placeholder_summary(REAL_SUMMARY) is False


def _mock_kb_listing(lf, objects: dict[str, dict]):
    """Wire lf.s3 so list_objects_v2 pagination and head_object reflect
    ``objects`` ({key: head_metadata})."""
    paginator = MagicMock()
    paginator.paginate.return_value = [
        {"Contents": [{"Key": k} for k in objects]}
    ]
    lf.s3.get_paginator.return_value = paginator
    lf.s3.head_object.side_effect = lambda Bucket, Key: {"Metadata": objects[Key]}


class TestBackfill:
    def test_fires_only_for_placeholder_summaries(self, lf):
        _mock_kb_listing(lf, {
            "good.pdf": {"summary": REAL_SUMMARY},
            "junk.pdf": {"summary": PLACEHOLDER_SUMMARIES[4]},
            "missing.pdf": {},
            "metadata.txt": {},
        })
        fired = lf._backfill_missing_metadata()
        assert fired == 2
        invoked_keys = {
            json.loads(call.kwargs["Payload"])["Records"][0]["s3"]["object"]["key"]
            for call in lf.lambda_client.invoke.call_args_list
        }
        assert invoked_keys == {"junk.pdf", "missing.pdf"}

    def test_skip_keys_respected(self, lf):
        _mock_kb_listing(lf, {"fresh.pdf": {}})
        fired = lf._backfill_missing_metadata(skip_keys={"fresh.pdf"})
        assert fired == 0
        lf.lambda_client.invoke.assert_not_called()

    def test_reconciles_stale_metadata_file_when_nothing_fired(self, lf):
        heads = {
            "good.pdf": {"summary": REAL_SUMMARY},
            "metadata.txt": {},
        }
        _mock_kb_listing(lf, heads)
        # metadata.txt on S3 is missing good.pdf's summary
        stale_body = MagicMock()
        stale_body.read.return_value = json.dumps({"good.pdf": {}}).encode()
        lf.s3.get_object.return_value = {"Body": stale_body}

        fired = lf._backfill_missing_metadata(reconcile_metadata_file=True)
        assert fired == 0
        lf.s3.put_object.assert_called_once()
        written = json.loads(lf.s3.put_object.call_args.kwargs["Body"])
        assert written == heads

    def test_no_rewrite_when_metadata_file_current(self, lf):
        heads = {"good.pdf": {"summary": REAL_SUMMARY}, "metadata.txt": {}}
        _mock_kb_listing(lf, heads)
        current_body = MagicMock()
        current_body.read.return_value = json.dumps(heads).encode()
        lf.s3.get_object.return_value = {"Body": current_body}

        fired = lf._backfill_missing_metadata(reconcile_metadata_file=True)
        assert fired == 0
        lf.s3.put_object.assert_not_called()


class TestBackfillOnlyMode:
    def test_skips_staging_ingestion_and_history(self, lf):
        with patch.object(lf, "_backfill_missing_metadata", return_value=3) as mock_backfill, \
             patch.object(lf, "history_table") as mock_history:
            response = lf.lambda_handler({"backfillOnly": True}, None)
        assert response["statusCode"] == 200
        assert json.loads(response["body"])["backfillInvocations"] == 3
        mock_backfill.assert_called_once_with(reconcile_metadata_file=True)
        lf.bedrock_agent.start_ingestion_job.assert_not_called()
        lf.s3.delete_object.assert_not_called()
        mock_history.put_item.assert_not_called()
