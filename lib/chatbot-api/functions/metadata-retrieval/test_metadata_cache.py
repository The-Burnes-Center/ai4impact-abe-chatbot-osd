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
METADATA = {
    "doc1.pdf": {"tag_category": "memos", "summary": "memo about X"},
    "doc2.pdf": {"tag_category": "user guide", "summary": "guide for Y"},
    # Legacy blobs written before the writers were fixed include a useless
    # self-entry; the lambda must drop it from every response form.
    "metadata.txt": {},
}
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

    def test_default_returns_compact_form(self):
        """Compact form: {filename: tag_category} — no summaries/tags."""
        lf = _fresh_module()
        with patch.object(lf, "s3") as mock_s3:
            mock_s3.get_object.return_value = _mock_s3_get(METADATA_STR)
            resp = lf.lambda_handler({}, {})
        body = json.loads(resp["body"])
        assert body["metadata"] == {"doc1.pdf": "memos", "doc2.pdf": "user guide"}

    def test_full_flag_returns_summaries(self):
        lf = _fresh_module()
        with patch.object(lf, "s3") as mock_s3:
            mock_s3.get_object.return_value = _mock_s3_get(METADATA_STR)
            resp = lf.lambda_handler({"full": True}, {})
        body = json.loads(resp["body"])
        assert body["metadata"]["doc1.pdf"]["summary"] == "memo about X"
        assert body["metadata"]["doc2.pdf"]["tag_category"] == "user guide"

    def test_compact_uses_unknown_for_missing_category(self):
        data = json.dumps({"a.pdf": {"summary": "no tag"}})
        lf = _fresh_module()
        with patch.object(lf, "s3") as mock_s3:
            mock_s3.get_object.return_value = _mock_s3_get(data)
            resp = lf.lambda_handler({}, {})
        body = json.loads(resp["body"])
        assert body["metadata"] == {"a.pdf": "unknown"}

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
            resp = lf.lambda_handler({"filter_key": "memos", "full": True}, {})
        body = json.loads(resp["body"])
        # Only memos category should be returned (full form preserves the dict)
        assert all(v.get("tag_category") == "memos" for v in body["metadata"].values())


# ---------------------------------------------------------------------------
# metadata.txt self-entry exclusion (legacy blobs)
# ---------------------------------------------------------------------------

class TestMetadataSelfEntryExcluded:
    def test_compact_excludes_metadata_txt(self):
        lf = _fresh_module()
        with patch.object(lf, "s3") as mock_s3:
            mock_s3.get_object.return_value = _mock_s3_get(METADATA_STR)
            resp = lf.lambda_handler({}, {})
        body = json.loads(resp["body"])
        assert "metadata.txt" not in body["metadata"]
        assert body["metadata"] == {"doc1.pdf": "memos", "doc2.pdf": "user guide"}

    def test_full_excludes_metadata_txt(self):
        lf = _fresh_module()
        with patch.object(lf, "s3") as mock_s3:
            mock_s3.get_object.return_value = _mock_s3_get(METADATA_STR)
            resp = lf.lambda_handler({"full": True}, {})
        body = json.loads(resp["body"])
        assert "metadata.txt" not in body["metadata"]
        assert set(body["metadata"].keys()) == {"doc1.pdf", "doc2.pdf"}


# ---------------------------------------------------------------------------
# filename_contains filtering (contract-family lookup)
# ---------------------------------------------------------------------------

# A contract-family shaped inventory: two FAC115 documents plus an unrelated
# one, with mixed-case filenames to exercise case-insensitive matching.
FAMILY_METADATA_STR = json.dumps({
    "FAC115 CUG.pdf": {"tag_category": "user guide", "summary": "guide for FAC115"},
    "fac115 RFR.pdf": {"tag_category": "memos", "summary": "RFR for FAC115"},
    "ITS88 CUG.pdf": {"tag_category": "user guide", "summary": "guide for ITS88"},
    "metadata.txt": {},
})


class TestFilenameContains:
    def _invoke(self, event, content=FAMILY_METADATA_STR):
        lf = _fresh_module()
        with patch.object(lf, "s3") as mock_s3:
            mock_s3.get_object.return_value = _mock_s3_get(content)
            resp = lf.lambda_handler(event, {})
        assert resp["statusCode"] == 200
        return json.loads(resp["body"])["metadata"]

    def test_compact_filters_case_insensitively(self):
        metadata = self._invoke({"filename_contains": "Fac115"})
        assert metadata == {
            "FAC115 CUG.pdf": "user guide",
            "fac115 RFR.pdf": "memos",
        }

    def test_full_filters_case_insensitively(self):
        metadata = self._invoke({"filename_contains": "FAC115", "full": True})
        assert set(metadata.keys()) == {"FAC115 CUG.pdf", "fac115 RFR.pdf"}
        assert metadata["FAC115 CUG.pdf"]["summary"] == "guide for FAC115"

    def test_composes_with_category_filter(self):
        metadata = self._invoke({"filename_contains": "fac115", "filter_key": "user guide", "full": True})
        assert set(metadata.keys()) == {"FAC115 CUG.pdf"}

    def test_no_match_returns_empty_dict(self):
        metadata = self._invoke({"filename_contains": "ZZZ999"})
        assert metadata == {}

    def test_still_excludes_metadata_txt(self):
        # "metadata" matches the self-entry's filename, but the pop runs first.
        metadata = self._invoke({"filename_contains": "metadata"})
        assert metadata == {}

    def test_whitespace_stripped_and_empty_means_no_filter(self):
        metadata = self._invoke({"filename_contains": "  its88  "})
        assert metadata == {"ITS88 CUG.pdf": "user guide"}
        unfiltered = self._invoke({"filename_contains": "   "})
        assert set(unfiltered.keys()) == {"FAC115 CUG.pdf", "fac115 RFR.pdf", "ITS88 CUG.pdf"}
