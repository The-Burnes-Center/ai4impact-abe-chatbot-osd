"""
Unit tests for the metadata-retrieval Lambda.
Verifies TTL cache behaviour: S3 is only called on cold-start and after TTL expiry.
"""
import importlib.util
import json
import os
import sys
import time
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Module-level setup
# ---------------------------------------------------------------------------

BUCKET = "test-knowledge-bucket"
METADATA = {"doc1.pdf": {"tag_category": "memos"}, "doc2.pdf": {"tag_category": "user guide"}}
METADATA_STR = json.dumps(METADATA)


@pytest.fixture(autouse=True)
def env_vars(monkeypatch):
    monkeypatch.setenv("BUCKET", BUCKET)
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")


_LF_PATH = os.path.join(os.path.dirname(__file__), "lambda_function.py")


def _fresh_module():
    """Load lambda_function.py by absolute path and reset its module-level cache."""
    spec = importlib.util.spec_from_file_location("metadata_retrieval_lf", _LF_PATH)
    mod = importlib.util.module_from_spec(spec)
    # Patch boto3.client so the module-level `s3 = boto3.client('s3')` is a mock
    with patch("boto3.client"):
        spec.loader.exec_module(mod)
    mod._metadata_cache = None
    mod._metadata_cache_ts = 0.0
    return mod


def _mock_s3_get(content: str):
    """Return a mock s3.get_object response with the given string body."""
    mock_body = MagicMock()
    mock_body.read.return_value = content.encode("utf-8")
    return {"Body": mock_body}


# ---------------------------------------------------------------------------
# filter_metadata
# ---------------------------------------------------------------------------

class TestFilterMetadata:
    def test_filters_by_category(self):
        lf = _fresh_module()
        result = lf.filter_metadata(METADATA_STR, category="memos")
        assert "doc1.pdf" in result
        assert "doc2.pdf" not in result

    def test_returns_all_when_no_category(self):
        lf = _fresh_module()
        result = lf.filter_metadata(METADATA_STR, category=None)
        assert set(result.keys()) == {"doc1.pdf", "doc2.pdf"}

    def test_returns_empty_for_invalid_json(self):
        lf = _fresh_module()
        result = lf.filter_metadata("not-json", category="memos")
        assert result == {}

    def test_returns_empty_for_empty_string(self):
        lf = _fresh_module()
        result = lf.filter_metadata("", category="memos")
        assert result == {}

    def test_unknown_category_returns_empty_dict(self):
        lf = _fresh_module()
        result = lf.filter_metadata(METADATA_STR, category="nonexistent")
        assert result == {}

    def test_handles_missing_tag_category_key(self):
        # doc without tag_category should not match any category filter
        data = json.dumps({"doc.pdf": {"summary": "something"}})
        lf = _fresh_module()
        result = lf.filter_metadata(data, category="memos")
        assert result == {}


# ---------------------------------------------------------------------------
# TTL cache behaviour
# ---------------------------------------------------------------------------

class TestTTLCache:
    def test_s3_called_on_first_invocation(self):
        lf = _fresh_module()
        with patch.object(lf, "s3") as mock_s3:
            mock_s3.get_object.return_value = _mock_s3_get(METADATA_STR)
            lf.lambda_handler({}, {})
            assert mock_s3.get_object.call_count == 1

    def test_s3_not_called_within_ttl(self):
        lf = _fresh_module()
        with patch.object(lf, "s3") as mock_s3:
            mock_s3.get_object.return_value = _mock_s3_get(METADATA_STR)
            now = time.time()
            with patch("time.time", return_value=now):
                lf.lambda_handler({}, {})   # populates cache
            # Second call within TTL
            with patch("time.time", return_value=now + lf._METADATA_TTL / 2):
                lf.lambda_handler({}, {})
            assert mock_s3.get_object.call_count == 1

    def test_s3_called_again_after_ttl_expires(self):
        lf = _fresh_module()
        with patch.object(lf, "s3") as mock_s3:
            mock_s3.get_object.return_value = _mock_s3_get(METADATA_STR)
            now = time.time()
            with patch("time.time", return_value=now):
                lf.lambda_handler({}, {})
            # Second call past TTL
            with patch("time.time", return_value=now + lf._METADATA_TTL + 1):
                lf.lambda_handler({}, {})
            assert mock_s3.get_object.call_count == 2

    def test_returns_200_with_metadata(self):
        lf = _fresh_module()
        with patch.object(lf, "s3") as mock_s3:
            mock_s3.get_object.return_value = _mock_s3_get(METADATA_STR)
            resp = lf.lambda_handler({}, {})
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert "metadata" in body

    def test_returns_500_when_s3_fails(self):
        lf = _fresh_module()
        with patch.object(lf, "s3") as mock_s3:
            mock_s3.get_object.side_effect = Exception("AccessDenied")
            resp = lf.lambda_handler({}, {})
        assert resp["statusCode"] == 500

    def test_filter_key_passed_to_filter_metadata(self):
        lf = _fresh_module()
        with patch.object(lf, "s3") as mock_s3:
            mock_s3.get_object.return_value = _mock_s3_get(METADATA_STR)
            resp = lf.lambda_handler({"filter_key": "memos"}, {})
        body = json.loads(resp["body"])
        # Only memos category should be returned
        assert all(v.get("tag_category") == "memos" for v in body["metadata"].values())
