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
                  "author": "OSD", "creation_date": "not-a-date"},
        )
        with patch.object(lf, "bedrock_invoke") as mock_bedrock:
            mock_bedrock.invoke_model.return_value = resp
            result = lf.summarize_and_categorize("doc.pdf", {"content": ["text"]})
        # Invalid date → reset to blank string; then falls through to today's date fill-in
        assert result["tags"]["creation_date"] != "not-a-date"

    def test_missing_creation_date_filled_with_today(self):
        lf = _fresh_module()
        resp = _bedrock_response(
            summary="Some doc.",
            tags={"category": "memos", "complexity": "low",
                  "author": "OSD", "creation_date": ""},
        )
        with patch.object(lf, "bedrock_invoke") as mock_bedrock:
            mock_bedrock.invoke_model.return_value = resp
            result = lf.summarize_and_categorize("doc.pdf", {"content": ["text"]})
        # Should be filled with today's date in YYYY-MM-DD format
        import re
        assert re.match(r"\d{4}-\d{2}-\d{2}", result["tags"]["creation_date"])

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
