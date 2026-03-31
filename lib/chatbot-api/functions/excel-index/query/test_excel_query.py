"""
Unit tests for the Excel Index Query Lambda (_do_query, _row_matches, _norm, etc.).
Uses moto to mock DynamoDB — no real AWS calls made.
"""
import importlib.util
import json
import os
import sys
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

INDEX = "TEST_INDEX"
TABLE = "test-excel-table"

@pytest.fixture(autouse=True)
def aws_env(monkeypatch):
    monkeypatch.setenv("TABLE_NAME", TABLE)
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")


def _make_table(dynamodb):
    table = dynamodb.create_table(
        TableName=TABLE,
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    return table


def _seed(table, rows: list[dict]):
    """Insert META item + data rows for INDEX."""
    table.put_item(Item={"pk": INDEX, "sk": "META", "row_count": str(len(rows))})
    for i, row in enumerate(rows):
        table.put_item(Item={"pk": INDEX, "sk": f"ROW#{i:04d}", **row})


_QUERY_DIR = os.path.dirname(__file__)
_LF_PATH = os.path.join(_QUERY_DIR, "lambda_function.py")


def _load_lf():
    """Load lambda_function.py by absolute path — avoids sys.path conflicts."""
    # models.py lives in the same dir; ensure it's importable
    if _QUERY_DIR not in sys.path:
        sys.path.insert(0, _QUERY_DIR)
    spec = importlib.util.spec_from_file_location("excel_query_lf", _LF_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def lf():
    """Return lambda_function module freshly imported inside a moto mock context."""
    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
        _make_table(dynamodb)
        mod = _load_lf()
        # Patch the module-level DDB resource to the mock one
        mod.DDB = dynamodb
        yield mod, dynamodb


# ---------------------------------------------------------------------------
# _norm / _contains
# ---------------------------------------------------------------------------

class TestNorm:
    def test_strips_punctuation(self, lf):
        mod, _ = lf
        assert mod._norm("Hello, World!") == "hello world"

    def test_collapses_whitespace(self, lf):
        mod, _ = lf
        assert mod._norm("  foo   bar  ") == "foo bar"

    def test_case_insensitive(self, lf):
        mod, _ = lf
        assert mod._norm("ABC") == "abc"

    def test_contains_match(self, lf):
        mod, _ = lf
        assert mod._contains("Statewide Contract #115", "contract 115") is True

    def test_contains_no_match(self, lf):
        mod, _ = lf
        assert mod._contains("vendor alpha", "beta") is False


# ---------------------------------------------------------------------------
# _do_query uses table.query(), not table.scan()
# ---------------------------------------------------------------------------

class TestDoQueryUsesQuery:
    def test_query_not_scan_called(self, lf):
        """_do_query must call table.query(), never table.scan()."""
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [{"Vendor": "Alpha", "Amount": "100"}])

        scan_called = []
        orig_query = table.query

        with patch.object(table.__class__, "scan", side_effect=AssertionError("scan() must not be called")):
            result = mod._do_query(pk=INDEX)

        assert result["total_matches"] == 1

    def test_returns_correct_row_count(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [
            {"Vendor": "Alpha"},
            {"Vendor": "Beta"},
            {"Vendor": "Gamma"},
        ])
        result = mod._do_query(pk=INDEX)
        assert result["total_matches"] == 3
        assert result["returned"] == 3


# ---------------------------------------------------------------------------
# free_text filtering
# ---------------------------------------------------------------------------

class TestFreeText:
    def test_matches_substring(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [
            {"Vendor": "Acme Corp", "Amount": "500"},
            {"Vendor": "Beta LLC", "Amount": "200"},
        ])
        result = mod._do_query(pk=INDEX, free_text="acme")
        assert result["total_matches"] == 1
        assert result["rows"][0]["Vendor"] == "Acme Corp"

    def test_punctuation_insensitive(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [{"Vendor": "Contract #115, Inc."}])
        result = mod._do_query(pk=INDEX, free_text="contract 115")
        assert result["total_matches"] == 1

    def test_no_match_returns_zero(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [{"Vendor": "Alpha"}])
        result = mod._do_query(pk=INDEX, free_text="zzznomatch")
        assert result["total_matches"] == 0


# ---------------------------------------------------------------------------
# Column filters
# ---------------------------------------------------------------------------

class TestFilters:
    def test_column_filter_exact(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [
            {"Vendor": "Acme", "State": "MA"},
            {"Vendor": "Beta", "State": "NY"},
        ])
        result = mod._do_query(pk=INDEX, filters={"State": "MA"})
        assert result["total_matches"] == 1
        assert result["rows"][0]["Vendor"] == "Acme"

    def test_missing_column_no_match(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [{"Vendor": "Acme"}])
        result = mod._do_query(pk=INDEX, filters={"NonExistentCol": "value"})
        assert result["total_matches"] == 0


# ---------------------------------------------------------------------------
# Date filters
# ---------------------------------------------------------------------------

class TestDateFilters:
    def test_date_before_filters_expired(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [
            {"Contract": "A", "EndDate": "2023-01-01"},   # before 2025
            {"Contract": "B", "EndDate": "2025-12-31"},   # after 2025
        ])
        result = mod._do_query(pk=INDEX, date_before={"EndDate": "2025-01-01"})
        assert result["total_matches"] == 1
        assert result["rows"][0]["Contract"] == "A"

    def test_date_after_filters_future(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [
            {"Contract": "A", "StartDate": "2023-01-01"},
            {"Contract": "B", "StartDate": "2026-01-01"},
        ])
        result = mod._do_query(pk=INDEX, date_after={"StartDate": "2025-01-01"})
        assert result["total_matches"] == 1
        assert result["rows"][0]["Contract"] == "B"

    def test_invalid_date_string_excluded(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [{"Contract": "A", "EndDate": "not-a-date"}])
        result = mod._do_query(pk=INDEX, date_before={"EndDate": "2025-01-01"})
        # cell_date is None → treated as non-match
        assert result["total_matches"] == 0


# ---------------------------------------------------------------------------
# count_only
# ---------------------------------------------------------------------------

class TestCountOnly:
    def test_count_only_returns_no_rows(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [{"Vendor": "A"}, {"Vendor": "B"}])
        result = mod._do_query(pk=INDEX, count_only=True)
        assert result["total_matches"] == 2
        assert result["rows"] == []
        assert result["returned"] == 0


# ---------------------------------------------------------------------------
# count_unique / group_by
# ---------------------------------------------------------------------------

class TestAggregations:
    def test_count_unique(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [
            {"Vendor": "Acme", "State": "MA"},
            {"Vendor": "Acme", "State": "MA"},
            {"Vendor": "Beta", "State": "NY"},
        ])
        result = mod._do_query(pk=INDEX, count_unique="Vendor")
        assert result["unique_count"] == 2
        assert result["unique_column"] == "Vendor"

    def test_group_by(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [
            {"State": "MA"}, {"State": "MA"}, {"State": "NY"},
        ])
        result = mod._do_query(pk=INDEX, group_by="State")
        assert result["groups"]["MA"] == 2
        assert result["groups"]["NY"] == 1

    def test_distinct_values(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [
            {"Category": "hardware"}, {"Category": "software"}, {"Category": "hardware"},
        ])
        result = mod._do_query(pk=INDEX, distinct_values="Category")
        assert sorted(result["distinct_values"]) == ["hardware", "software"]
        assert result["distinct_count"] == 2


# ---------------------------------------------------------------------------
# Pagination (offset / limit)
# ---------------------------------------------------------------------------

class TestPagination:
    def test_offset_skips_rows(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [{"id": str(i)} for i in range(5)])
        result = mod._do_query(pk=INDEX, offset=2, limit=2)
        assert result["total_matches"] == 5
        assert result["returned"] == 2
        assert result["offset"] == 2

    def test_limit_caps_returned(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [{"id": str(i)} for i in range(10)])
        result = mod._do_query(pk=INDEX, limit=3)
        assert result["returned"] == 3
        assert result["total_matches"] == 10


# ---------------------------------------------------------------------------
# sort_by
# ---------------------------------------------------------------------------

class TestSortBy:
    def test_sort_asc(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [
            {"Name": "Charlie"}, {"Name": "Alpha"}, {"Name": "Beta"},
        ])
        result = mod._do_query(pk=INDEX, sort_by="Name", sort_order="asc")
        names = [r["Name"] for r in result["rows"]]
        assert names == ["Alpha", "Beta", "Charlie"]

    def test_sort_desc(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [
            {"Name": "Charlie"}, {"Name": "Alpha"}, {"Name": "Beta"},
        ])
        result = mod._do_query(pk=INDEX, sort_by="Name", sort_order="desc")
        names = [r["Name"] for r in result["rows"]]
        assert names == ["Charlie", "Beta", "Alpha"]


# ---------------------------------------------------------------------------
# column projection
# ---------------------------------------------------------------------------

class TestColumnProjection:
    def test_columns_filters_fields(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [{"Vendor": "Acme", "Amount": "100", "State": "MA"}])
        result = mod._do_query(pk=INDEX, columns=["Vendor", "State"])
        row = result["rows"][0]
        assert "Vendor" in row
        assert "State" in row
        assert "Amount" not in row


# ---------------------------------------------------------------------------
# lambda_handler integration
# ---------------------------------------------------------------------------

class TestLambdaHandler:
    def test_handler_returns_200_for_valid_query(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        _seed(table, [{"Vendor": "Acme"}])
        event = {"action": "query", "index_name": INDEX}
        resp = mod.lambda_handler(event, {})
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert body["total_matches"] == 1

    def test_handler_returns_400_for_invalid_request(self, lf):
        mod, _ = lf
        # index_name is required
        resp = mod.lambda_handler({"action": "query"}, {})
        assert resp["statusCode"] == 400

    def test_handler_status_action(self, lf):
        mod, dynamodb = lf
        table = dynamodb.Table(TABLE)
        table.put_item(Item={"pk": INDEX, "sk": "META", "row_count": "5", "status": "COMPLETE"})
        event = {"action": "status", "index_name": INDEX}
        resp = mod.lambda_handler(event, {})
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert body["status"] == "COMPLETE"
        assert body["row_count"] == 5
