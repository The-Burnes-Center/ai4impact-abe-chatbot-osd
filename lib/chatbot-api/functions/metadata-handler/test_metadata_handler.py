"""
Unit tests for metadata-handler Lambda.
Tests summarize_and_categorize tag validation logic and filter_metadata.
All Bedrock/S3 calls are mocked — no real AWS calls.
"""
import importlib.util
import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Path setup — add handler dir and Python layer to sys.path
# ---------------------------------------------------------------------------

HANDLER_DIR = os.path.dirname(__file__)
LAYER_DIR = os.path.join(
    HANDLER_DIR, "..", "layers", "python-common", "python"
)

for d in (HANDLER_DIR, os.path.abspath(LAYER_DIR)):
    if d not in sys.path:
        sys.path.insert(0, d)


@pytest.fixture(autouse=True)
def env_vars(monkeypatch):
    monkeypatch.setenv("KB_ID", "test-kb-id")
    monkeypatch.setenv("FAST_MODEL_ID", "us.anthropic.claude-3-5-haiku-20241022-v1:0")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")


_LF_PATH = os.path.join(HANDLER_DIR, "lambda_function.py")
_LAYER_ABS = os.path.abspath(LAYER_DIR)


def _fresh_module():
    """Load metadata-handler lambda_function.py by absolute path."""
    # Ensure the layer (abe_utils) and handler (config) dirs are importable
    for d in (_LAYER_ABS, HANDLER_DIR):
        if d not in sys.path:
            sys.path.insert(0, d)
    # Remove stale cached sub-modules so they reload from the correct paths
    for mod in ("config", "abe_utils", "abe_utils.validation", "abe_utils.logging"):
        sys.modules.pop(mod, None)
    spec = importlib.util.spec_from_file_location("metadata_handler_lf", _LF_PATH)
    mod = importlib.util.module_from_spec(spec)
    # Patch boto3.client so module-level client() calls don't hit real AWS
    with patch("boto3.client"):
        spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# Helpers to build a fake Bedrock response
# ---------------------------------------------------------------------------

def _bedrock_response(summary: str, tags: dict) -> dict:
    body_bytes = json.dumps({
        "content": [{"text": json.dumps({"summary": summary, "tags": tags})}]
    }).encode()
    mock_body = MagicMock()
    mock_body.read.return_value = body_bytes
    return {"body": mock_body}


# ---------------------------------------------------------------------------
# summarize_and_categorize — tag validation
# ---------------------------------------------------------------------------

class TestSummarizeAndCategorize:
    def test_valid_tags_pass_through(self):
        lf = _fresh_module()
        resp = _bedrock_response(
            summary="A user guide for contract FAC115.",
            tags={
                "category": "user guide",
                "complexity": "medium",
                "author": "OSD",
                "creation_date": "2023-11-20",
            },
        )
        with patch.object(lf, "bedrock_invoke") as mock_bedrock:
            mock_bedrock.invoke_model.return_value = resp
            result = lf.summarize_and_categorize("FAC115.pdf", {"content": ["text"]})
        assert result["tags"]["category"] == "user guide"
        assert result["tags"]["complexity"] == "medium"
        assert result["tags"]["creation_date"] == "2023-11-20"

    def test_invalid_category_replaced_with_unknown(self):
        lf = _fresh_module()
        resp = _bedrock_response(
            summary="Some doc.",
            tags={"category": "not-a-real-category", "complexity": "low",
                  "author": "OSD", "creation_date": "2023-01-01"},
        )
        with patch.object(lf, "bedrock_invoke") as mock_bedrock:
            mock_bedrock.invoke_model.return_value = resp
            result = lf.summarize_and_categorize("doc.pdf", {"content": ["text"]})
        assert result["tags"]["category"] == "unknown"

    def test_invalid_complexity_replaced_with_unknown(self):
        lf = _fresh_module()
        resp = _bedrock_response(
            summary="Some doc.",
            tags={"category": "memos", "complexity": "extreme",
                  "author": "OSD", "creation_date": "2023-01-01"},
        )
        with patch.object(lf, "bedrock_invoke") as mock_bedrock:
            mock_bedrock.invoke_model.return_value = resp
            result = lf.summarize_and_categorize("doc.pdf", {"content": ["text"]})
        assert result["tags"]["complexity"] == "unknown"

    def test_blank_tag_value_replaced_with_unknown(self):
        lf = _fresh_module()
        resp = _bedrock_response(
            summary="Some doc.",
            tags={"category": "memos", "complexity": "",
                  "author": "", "creation_date": "2023-01-01"},
        )
        with patch.object(lf, "bedrock_invoke") as mock_bedrock:
            mock_bedrock.invoke_model.return_value = resp
            result = lf.summarize_and_categorize("doc.pdf", {"content": ["text"]})
        assert result["tags"]["complexity"] == "unknown"
        assert result["tags"]["author"] == "unknown"

    def test_invalid_creation_date_format_reset_to_blank(self):
        lf = _fresh_module()
        resp = _bedrock_response(
            summary="Some doc.",
            tags={"category": "memos", "complexity": "low",
                  "author": "OSD", "creation_date": "June 2023"},
        )
        with patch.object(lf, "bedrock_invoke") as mock_bedrock:
            mock_bedrock.invoke_model.return_value = resp
            result = lf.summarize_and_categorize("doc.pdf", {"content": ["text"]})
        # A date that isn't YYYY-MM-DD is reset to blank, never today's date
        assert result["tags"]["creation_date"] == ""

    def test_missing_creation_date_stays_blank(self):
        lf = _fresh_module()
        resp = _bedrock_response(
            summary="Some doc.",
            tags={"category": "memos", "complexity": "low",
                  "author": "OSD", "creation_date": ""},
        )
        with patch.object(lf, "bedrock_invoke") as mock_bedrock:
            mock_bedrock.invoke_model.return_value = resp
            result = lf.summarize_and_categorize("doc.pdf", {"content": ["text"]})
        # An unverifiable date stays blank -- it must never be filled with
        # today's date, which made the metadata-generation date look like
        # the document's age.
        assert result["tags"]["creation_date"] == ""

    def test_unknown_creation_date_normalized_to_blank(self):
        """The prompt tells the model to answer "unknown" when no date can be
        verified; that sentinel is normalized to blank (case-insensitively),
        not replaced with today's date."""
        lf = _fresh_module()
        resp = _bedrock_response(
            summary="Some doc.",
            tags={"category": "memos", "complexity": "low",
                  "author": "OSD", "creation_date": "Unknown"},
        )
        with patch.object(lf, "bedrock_invoke") as mock_bedrock:
            mock_bedrock.invoke_model.return_value = resp
            result = lf.summarize_and_categorize("doc.pdf", {"content": ["text"]})
        assert result["tags"]["creation_date"] == ""

    def test_invalid_json_response_returns_error_dict(self):
        lf = _fresh_module()
        bad_body = MagicMock()
        bad_body.read.return_value = b"not-json-at-all"
        with patch.object(lf, "bedrock_invoke") as mock_bedrock:
            mock_bedrock.invoke_model.return_value = {"body": bad_body}
            result = lf.summarize_and_categorize("doc.pdf", {"content": ["text"]})
        assert "Error" in result["summary"]

    def test_bedrock_exception_returns_error_dict(self):
        lf = _fresh_module()
        with patch.object(lf, "bedrock_invoke") as mock_bedrock:
            mock_bedrock.invoke_model.side_effect = Exception("Bedrock unavailable")
            result = lf.summarize_and_categorize("doc.pdf", {"content": ["text"]})
        assert "Error" in result["summary"]
        assert result["tags"]["category"] == "unknown"

    def test_missing_content_field_returns_error_dict(self):
        lf = _fresh_module()
        bad_body = MagicMock()
        bad_body.read.return_value = json.dumps({"content": []}).encode()
        with patch.object(lf, "bedrock_invoke") as mock_bedrock:
            mock_bedrock.invoke_model.return_value = {"body": bad_body}
            result = lf.summarize_and_categorize("doc.pdf", {"content": ["text"]})
        assert "Error" in result["summary"]

    def test_unknown_tag_key_replaced_with_unknown(self):
        """A tag key not in all_tags should be set to 'unknown'."""
        lf = _fresh_module()
        resp = _bedrock_response(
            summary="Some doc.",
            tags={"category": "memos", "complexity": "low",
                  "author": "OSD", "creation_date": "2023-01-01",
                  "invented_tag": "some_value"},
        )
        with patch.object(lf, "bedrock_invoke") as mock_bedrock:
            mock_bedrock.invoke_model.return_value = resp
            result = lf.summarize_and_categorize("doc.pdf", {"content": ["text"]})
        assert result["tags"]["invented_tag"] == "unknown"


# ---------------------------------------------------------------------------
# retrieve_kb_docs — no-chunks behavior
# ---------------------------------------------------------------------------

class TestRetrieveKbDocs:
    def test_no_chunks_returns_falsy_content(self):
        """No KB chunks (document not yet ingested) must yield falsy content,
        not a sentinel string the model could be asked to summarize."""
        lf = _fresh_module()
        with patch.object(lf, "bedrock") as mock_bedrock:
            mock_bedrock.retrieve.return_value = {"retrievalResults": []}
            result = lf.retrieve_kb_docs("bucket", "ENE53.pdf", "kb-id")
        assert result["content"] == []
        assert not result["content"]
        assert result["uri"] is None

    def test_chunks_for_other_files_are_filtered_out(self):
        """stringContains is a substring match; a URI for FAC1141.pdf must not
        satisfy a lookup for FAC114.pdf."""
        lf = _fresh_module()
        with patch.object(lf, "bedrock") as mock_bedrock:
            mock_bedrock.retrieve.return_value = {
                "retrievalResults": [
                    {
                        "location": {"s3Location": {"uri": "s3://b/FAC1141.pdf"}},
                        "content": {"text": "wrong file"},
                    }
                ]
            }
            result = lf.retrieve_kb_docs("bucket", "FAC114.pdf", "kb-id")
        assert result["content"] == []


# ---------------------------------------------------------------------------
# get_complete_metadata — inventory must not list itself
# ---------------------------------------------------------------------------

class TestGetCompleteMetadata:
    def test_metadata_file_excluded_from_inventory(self):
        """A bucket listing that includes metadata.txt must produce an
        inventory without the "metadata.txt": {} self-entry, and must not
        HEAD the inventory file itself."""
        lf = _fresh_module()
        with patch.object(lf, "s3") as mock_s3:
            paginator = MagicMock()
            paginator.paginate.return_value = [
                {"Contents": [
                    {"Key": "doc1.pdf"},
                    {"Key": "metadata.txt"},
                    {"Key": "doc2.pdf"},
                ]}
            ]
            mock_s3.get_paginator.return_value = paginator
            mock_s3.head_object.side_effect = lambda Bucket, Key: {
                "Metadata": {"summary": f"summary of {Key}"}
            }
            result = lf.get_complete_metadata("test-bucket")

        assert set(result.keys()) == {"doc1.pdf", "doc2.pdf"}
        # The serialized Body written back to S3 excludes the self-entry
        written = json.loads(mock_s3.put_object.call_args.kwargs["Body"])
        assert "metadata.txt" not in written
        assert set(written.keys()) == {"doc1.pdf", "doc2.pdf"}
        # No head-metadata fetch for the inventory file itself
        headed = {call.kwargs["Key"] for call in mock_s3.head_object.call_args_list}
        assert "metadata.txt" not in headed


# ---------------------------------------------------------------------------
# lambda_handler — uningested document must not be summarized
# ---------------------------------------------------------------------------

class TestLambdaHandlerNoChunks:
    def test_uningested_document_returns_404_without_model_call(self):
        lf = _fresh_module()
        event = {
            "Records": [
                {
                    "eventName": "ObjectCreated:Put",
                    "s3": {
                        "bucket": {"name": "test-bucket"},
                        "object": {"key": "ENE53.pdf"},
                    },
                }
            ]
        }
        with patch.object(lf, "bedrock") as mock_bedrock, \
             patch.object(lf, "bedrock_invoke") as mock_invoke, \
             patch.object(lf, "s3") as mock_s3:
            mock_bedrock.retrieve.return_value = {"retrievalResults": []}
            response = lf.lambda_handler(event, None)
        assert response["statusCode"] == 404
        mock_invoke.invoke_model.assert_not_called()
        mock_s3.copy_object.assert_not_called()


# ---------------------------------------------------------------------------
# lambda_handler — generation date is recorded separately from creation date
# ---------------------------------------------------------------------------

class TestLambdaHandlerMetadataGeneratedAt:
    def test_copy_object_metadata_records_generation_date(self):
        """The written head metadata carries tag_metadata_generated_at (today,
        YYYY-MM-DD) while an unverifiable tag_creation_date stays blank."""
        lf = _fresh_module()
        event = {
            "Records": [
                {
                    "eventName": "ObjectCreated:Put",
                    "s3": {
                        "bucket": {"name": "test-bucket"},
                        "object": {"key": "FAC115.pdf"},
                    },
                }
            ]
        }
        resp = _bedrock_response(
            summary="A user guide for contract FAC115.",
            tags={"category": "user guide", "complexity": "low",
                  "author": "OSD", "creation_date": "unknown"},
        )
        with patch.object(lf, "bedrock") as mock_bedrock, \
             patch.object(lf, "bedrock_invoke") as mock_invoke, \
             patch.object(lf, "s3") as mock_s3:
            mock_bedrock.retrieve.return_value = {
                "retrievalResults": [
                    {
                        "location": {"s3Location": {"uri": "s3://test-bucket/FAC115.pdf"}},
                        "content": {"text": "document text"},
                    }
                ]
            }
            mock_invoke.invoke_model.return_value = resp
            mock_s3.head_object.return_value = {"Metadata": {}}
            paginator = MagicMock()
            paginator.paginate.return_value = [
                {"Contents": [{"Key": "FAC115.pdf"}]}
            ]
            mock_s3.get_paginator.return_value = paginator
            response = lf.lambda_handler(event, None)

        assert response["statusCode"] == 200
        written = mock_s3.copy_object.call_args.kwargs["Metadata"]
        import re
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", written["tag_metadata_generated_at"])
        from datetime import datetime
        datetime.strptime(written["tag_metadata_generated_at"], "%Y-%m-%d")
        # The unverifiable creation date is blank, not today's date
        assert written["tag_creation_date"] == ""
