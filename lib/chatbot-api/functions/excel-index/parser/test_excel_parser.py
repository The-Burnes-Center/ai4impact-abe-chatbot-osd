"""
Unit tests for the Excel Index Parser Lambda (lambda_function.py).

Covers:
- S3 trigger event parsing (correct path format indexes/{id}/latest.xlsx)
- S3 path validation (ignores non-matching paths)
- Excel file reading and column detection
- DynamoDB item writing (which fields get stored)
- Error handling (bad file, missing/insufficient columns, DynamoDB errors)
- META/SK record creation and PROCESSING → COMPLETE lifecycle
- Delete event handling
- _clear_index, _put_meta, _serialize_value, helper functions
- tool_registry calls (write_to_registry, delete_from_registry)

Uses moto for AWS mocking (S3 + DynamoDB), openpyxl to create in-memory
Excel bytes for test fixtures. Matches the testing patterns in test_excel_query.py.
"""
import importlib.util
import io
import json
import os
import sys
from datetime import date, datetime
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws
from openpyxl import Workbook

# ---------------------------------------------------------------------------
# Constants shared across tests
# ---------------------------------------------------------------------------

INDEX_ID = "test_vendors"
DISPLAY_NAME = "Test Vendors"
TABLE = "test-excel-table"
REGISTRY_TABLE = "test-registry-table"
BUCKET = "test-bucket"
KEY = f"indexes/{INDEX_ID}/latest.xlsx"

_PARSER_DIR = os.path.dirname(__file__)
_LF_PATH = os.path.join(_PARSER_DIR, "lambda_function.py")


# ---------------------------------------------------------------------------
# Helper: build an in-memory .xlsx as bytes
# ---------------------------------------------------------------------------

def _make_xlsx(headers: list[str], rows: list[list]) -> bytes:
    """Build an openpyxl workbook with given headers + data rows; return raw bytes."""
    wb = Workbook()
    ws = wb.active
    ws.append(headers)
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _simple_xlsx(num_rows: int = 3) -> bytes:
    """Standard two-column sheet used by many tests."""
    return _make_xlsx(
        ["Vendor Name", "Contract Number"],
        [[f"Vendor {i}", f"CTR-{i:04d}"] for i in range(num_rows)],
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def aws_env(monkeypatch):
    monkeypatch.setenv("BUCKET", BUCKET)
    monkeypatch.setenv("TABLE_NAME", TABLE)
    monkeypatch.setenv("INDEX_REGISTRY_TABLE", REGISTRY_TABLE)
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")


def _make_table(dynamodb):
    return dynamodb.create_table(
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


def _make_registry_table(dynamodb):
    return dynamodb.create_table(
        TableName=REGISTRY_TABLE,
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


def _load_lf():
    """Load lambda_function.py by absolute path, ensuring local modules are importable."""
    if _PARSER_DIR not in sys.path:
        sys.path.insert(0, _PARSER_DIR)
    spec = importlib.util.spec_from_file_location("excel_parser_lf", _LF_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _make_s3_event(
    key: str = KEY,
    bucket: str = BUCKET,
    event_name: str = "ObjectCreated:Put",
) -> dict:
    return {
        "Records": [
            {
                "eventName": event_name,
                "s3": {
                    "bucket": {"name": bucket},
                    "object": {"key": key},
                },
            }
        ]
    }


@pytest.fixture()
def lf():
    """Return (module, dynamodb, s3) with mocked AWS resources fully wired."""
    with mock_aws():
        dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
        _make_table(dynamodb)
        _make_registry_table(dynamodb)

        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)

        mod = _load_lf()

        # Patch module-level clients to the mocked ones
        mod.DDB = dynamodb
        mod.S3 = s3

        # Suppress tool_registry calls (they use Bedrock + a separate DDB resource);
        # individual tests that want to verify registry behaviour will re-patch.
        with patch.object(mod, "write_to_registry", return_value=None) as mock_write_reg, \
             patch.object(mod, "delete_from_registry", return_value=None) as mock_del_reg:
            yield mod, dynamodb, s3, mock_write_reg, mock_del_reg


# ---------------------------------------------------------------------------
# Helper: upload Excel bytes to mock S3
# ---------------------------------------------------------------------------

def _upload(s3, xlsx_bytes: bytes, key: str = KEY) -> None:
    s3.put_object(Bucket=BUCKET, Key=key, Body=xlsx_bytes)


# ---------------------------------------------------------------------------
# _extract_index_id
# ---------------------------------------------------------------------------

class TestExtractIndexId:
    def test_standard_path(self, lf):
        mod, *_ = lf
        assert mod._extract_index_id("indexes/my_index/latest.xlsx") == "my_index"

    def test_nested_path_is_accepted(self, lf):
        """Regex only cares about the first two path segments."""
        mod, *_ = lf
        assert mod._extract_index_id("indexes/abc/subpath/file.xlsx") == "abc"

    def test_missing_indexes_prefix_returns_none(self, lf):
        mod, *_ = lf
        assert mod._extract_index_id("uploads/my_index/latest.xlsx") is None

    def test_root_key_returns_none(self, lf):
        mod, *_ = lf
        assert mod._extract_index_id("latest.xlsx") is None

    def test_empty_string_returns_none(self, lf):
        mod, *_ = lf
        assert mod._extract_index_id("") is None

    def test_index_id_with_hyphens(self, lf):
        mod, *_ = lf
        assert mod._extract_index_id("indexes/vendor-contracts/latest.xlsx") == "vendor-contracts"

    def test_index_id_with_spaces_encoded(self, lf):
        mod, *_ = lf
        assert mod._extract_index_id("indexes/my%20index/latest.xlsx") == "my%20index"


# ---------------------------------------------------------------------------
# _index_id_to_display_name
# ---------------------------------------------------------------------------

class TestIndexIdToDisplayName:
    def test_snake_case(self, lf):
        mod, *_ = lf
        assert mod._index_id_to_display_name("vendor_contracts") == "Vendor Contracts"

    def test_single_word(self, lf):
        mod, *_ = lf
        assert mod._index_id_to_display_name("vendors") == "Vendors"

    def test_already_title(self, lf):
        mod, *_ = lf
        assert mod._index_id_to_display_name("Vendor_Contracts") == "Vendor Contracts"

    def test_no_underscores(self, lf):
        mod, *_ = lf
        assert mod._index_id_to_display_name("vendors") == "Vendors"


# ---------------------------------------------------------------------------
# _serialize_value
# ---------------------------------------------------------------------------

class TestSerializeValue:
    def test_none_becomes_empty_string(self, lf):
        mod, *_ = lf
        assert mod._serialize_value(None) == ""

    def test_int(self, lf):
        mod, *_ = lf
        assert mod._serialize_value(42) == "42"

    def test_float(self, lf):
        mod, *_ = lf
        assert mod._serialize_value(3.14) == "3.14"

    def test_string_passthrough(self, lf):
        mod, *_ = lf
        assert mod._serialize_value("hello") == "hello"

    def test_zero(self, lf):
        mod, *_ = lf
        assert mod._serialize_value(0) == "0"


# ---------------------------------------------------------------------------
# S3 path validation — non-.xlsx keys are skipped
# ---------------------------------------------------------------------------

class TestPathValidation:
    def test_non_xlsx_key_is_skipped(self, lf):
        mod, dynamodb, s3, *_ = lf
        event = _make_s3_event(key="indexes/my_index/notes.txt")
        resp = mod.lambda_handler(event, {})
        # No record processed → empty body
        assert resp["statusCode"] == 200
        assert resp["body"] == "{}"

    def test_key_without_indexes_prefix_is_skipped(self, lf):
        mod, dynamodb, s3, *_ = lf
        _upload(s3, _simple_xlsx(), key="other/path/latest.xlsx")
        event = _make_s3_event(key="other/path/latest.xlsx")
        resp = mod.lambda_handler(event, {})
        assert resp["statusCode"] == 200
        assert resp["body"] == "{}"

    def test_empty_records_list(self, lf):
        mod, *_ = lf
        resp = mod.lambda_handler({"Records": []}, {})
        assert resp["statusCode"] == 200

    def test_missing_records_key(self, lf):
        mod, *_ = lf
        resp = mod.lambda_handler({}, {})
        assert resp["statusCode"] == 200


# ---------------------------------------------------------------------------
# Successful parse — happy path
# ---------------------------------------------------------------------------

class TestHappyPath:
    def test_returns_200_ok(self, lf):
        mod, _, s3, *_ = lf
        _upload(s3, _simple_xlsx(3))
        resp = mod.lambda_handler(_make_s3_event(), {})
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert body["status"] == "ok"
        assert body["index_id"] == INDEX_ID
        assert body["row_count"] == 3

    def test_data_rows_written_to_dynamodb(self, lf):
        mod, dynamodb, s3, *_ = lf
        _upload(s3, _simple_xlsx(2))
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(INDEX_ID)
        )
        # META + 2 data rows = 3 items
        assert len(resp["Items"]) == 3

    def test_row_sk_is_numeric_string(self, lf):
        """Row sort keys must be '0', '1', '2', … (numeric string offsets)."""
        mod, dynamodb, s3, *_ = lf
        _upload(s3, _simple_xlsx(3))
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(INDEX_ID)
        )
        sks = {item["sk"] for item in resp["Items"]}
        assert "0" in sks
        assert "1" in sks
        assert "2" in sks

    def test_meta_status_complete_after_parse(self, lf):
        mod, dynamodb, s3, *_ = lf
        _upload(s3, _simple_xlsx(2))
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        meta = table.get_item(Key={"pk": INDEX_ID, "sk": "META"})["Item"]
        assert meta["status"] == "COMPLETE"
        assert int(meta["row_count"]) == 2

    def test_meta_columns_list_stored(self, lf):
        """After successful parse, META item must contain a 'columns' attribute."""
        mod, dynamodb, s3, *_ = lf
        _upload(s3, _simple_xlsx(1))
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        meta = table.get_item(Key={"pk": INDEX_ID, "sk": "META"})["Item"]
        assert "columns" in meta
        cols = meta["columns"]
        # headers "Vendor Name" and "Contract Number" → normalized
        assert "Vendor_Name" in cols
        assert "Contract_Number" in cols

    def test_column_names_normalised_in_rows(self, lf):
        """Spaces in header names become underscores in stored field names."""
        mod, dynamodb, s3, *_ = lf
        xlsx = _make_xlsx(["Vendor Name", "Start Date"], [["Acme", "2024-01-01"]])
        _upload(s3, xlsx)
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(INDEX_ID)
        )
        data_rows = [item for item in resp["Items"] if item["sk"] != "META"]
        assert len(data_rows) == 1
        assert "Vendor_Name" in data_rows[0]
        assert "Start_Date" in data_rows[0]

    def test_slash_in_header_becomes_underscore(self, lf):
        mod, dynamodb, s3, *_ = lf
        xlsx = _make_xlsx(["Start/End Date", "Amount"], [["2024-01-01", "100"]])
        _upload(s3, xlsx)
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(INDEX_ID)
        )
        data_rows = [item for item in resp["Items"] if item["sk"] != "META"]
        assert "Start_End_Date" in data_rows[0]

    def test_write_to_registry_called_with_correct_args(self, lf):
        mod, _, s3, mock_write_reg, _ = lf
        _upload(s3, _simple_xlsx(2))
        mod.lambda_handler(_make_s3_event(), {})
        mock_write_reg.assert_called_once()
        args, kwargs = mock_write_reg.call_args
        # Positional: index_name, display_name, col_names, row_count, sample_rows
        assert args[0] == INDEX_ID
        assert args[1] == DISPLAY_NAME
        assert args[3] == 2   # row_count

    def test_large_file_batches_correctly(self, lf):
        """Files with >25 rows should be batched; all rows must arrive in DDB."""
        mod, dynamodb, s3, *_ = lf
        _upload(s3, _simple_xlsx(60))
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(INDEX_ID)
        )
        data_rows = [item for item in resp["Items"] if item["sk"] != "META"]
        assert len(data_rows) == 60


# ---------------------------------------------------------------------------
# Header / column edge cases
# ---------------------------------------------------------------------------

class TestColumnDetection:
    def test_single_header_column_rejected(self, lf):
        mod, dynamodb, s3, *_ = lf
        xlsx = _make_xlsx(["Vendor Name"], [["Acme"]])
        _upload(s3, xlsx)
        resp = mod.lambda_handler(_make_s3_event(), {})
        body = json.loads(resp["body"])
        assert body["status"] == "error"
        assert "header column" in body["message"].lower() or "header" in body["message"].lower()

    def test_zero_header_columns_rejected(self, lf):
        mod, dynamodb, s3, *_ = lf
        xlsx = _make_xlsx([], [])
        _upload(s3, xlsx)
        resp = mod.lambda_handler(_make_s3_event(), {})
        body = json.loads(resp["body"])
        assert body["status"] == "error"

    def test_error_meta_written_on_insufficient_columns(self, lf):
        mod, dynamodb, s3, *_ = lf
        xlsx = _make_xlsx(["Only One"], [["val"]])
        _upload(s3, xlsx)
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        meta = table.get_item(Key={"pk": INDEX_ID, "sk": "META"})["Item"]
        assert meta["status"] == "ERROR"
        assert "error" in meta

    def test_all_empty_header_columns_rejected(self, lf):
        """A sheet where every header is blank should be treated as 0 non-empty columns."""
        mod, dynamodb, s3, *_ = lf
        xlsx = _make_xlsx(["", "", ""], [["a", "b", "c"]])
        _upload(s3, xlsx)
        resp = mod.lambda_handler(_make_s3_event(), {})
        body = json.loads(resp["body"])
        assert body["status"] == "error"

    def test_hyphen_in_header_becomes_underscore(self, lf):
        mod, dynamodb, s3, *_ = lf
        xlsx = _make_xlsx(["End-Date", "Vendor"], [["2024-01-01", "Acme"]])
        _upload(s3, xlsx)
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(INDEX_ID)
        )
        data_rows = [item for item in resp["Items"] if item["sk"] != "META"]
        assert "End_Date" in data_rows[0]


# ---------------------------------------------------------------------------
# Empty / all-blank data rows are skipped
# ---------------------------------------------------------------------------

class TestBlankRows:
    def test_fully_blank_rows_skipped(self, lf):
        mod, dynamodb, s3, *_ = lf
        xlsx = _make_xlsx(
            ["Vendor", "Amount"],
            [["Acme", "100"], [None, None], ["Beta", "200"]],
        )
        _upload(s3, xlsx)
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(INDEX_ID)
        )
        data_rows = [item for item in resp["Items"] if item["sk"] != "META"]
        assert len(data_rows) == 2

    def test_row_count_in_meta_excludes_blank_rows(self, lf):
        mod, dynamodb, s3, *_ = lf
        xlsx = _make_xlsx(
            ["Vendor", "Amount"],
            [["Acme", "100"], [None, None]],
        )
        _upload(s3, xlsx)
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        meta = table.get_item(Key={"pk": INDEX_ID, "sk": "META"})["Item"]
        assert int(meta["row_count"]) == 1

    def test_empty_sheet_results_in_zero_rows(self, lf):
        mod, dynamodb, s3, *_ = lf
        xlsx = _make_xlsx(["Vendor", "Amount"], [])
        _upload(s3, xlsx)
        resp = mod.lambda_handler(_make_s3_event(), {})
        body = json.loads(resp["body"])
        assert body["status"] == "ok"
        assert body["row_count"] == 0


# ---------------------------------------------------------------------------
# META record lifecycle (PROCESSING → COMPLETE)
# ---------------------------------------------------------------------------

class TestMetaLifecycle:
    def test_processing_status_eventually_replaced_by_complete(self, lf):
        """META must end up COMPLETE (not stuck at PROCESSING)."""
        mod, dynamodb, s3, *_ = lf
        _upload(s3, _simple_xlsx(1))
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        meta = table.get_item(Key={"pk": INDEX_ID, "sk": "META"})["Item"]
        assert meta["status"] == "COMPLETE"

    def test_meta_last_updated_is_iso_string(self, lf):
        mod, dynamodb, s3, *_ = lf
        _upload(s3, _simple_xlsx(1))
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        meta = table.get_item(Key={"pk": INDEX_ID, "sk": "META"})["Item"]
        # Should parse as a valid ISO datetime
        dt = datetime.fromisoformat(meta["last_updated"])
        assert dt.tzinfo is not None   # timezone-aware

    def test_meta_pk_and_sk(self, lf):
        mod, dynamodb, s3, *_ = lf
        _upload(s3, _simple_xlsx(1))
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        meta = table.get_item(Key={"pk": INDEX_ID, "sk": "META"})["Item"]
        assert meta["pk"] == INDEX_ID
        assert meta["sk"] == "META"


# ---------------------------------------------------------------------------
# _clear_index — old rows are removed before re-parse, META is kept
# ---------------------------------------------------------------------------

class TestClearIndex:
    def test_clear_removes_data_rows_but_keeps_meta(self, lf):
        mod, dynamodb, s3, *_ = lf
        # First upload: 3 rows
        _upload(s3, _simple_xlsx(3))
        mod.lambda_handler(_make_s3_event(), {})

        # Second upload: 1 row; old rows should be gone
        xlsx2 = _make_xlsx(["Vendor", "Amount"], [["NewCo", "999"]])
        _upload(s3, xlsx2)
        mod.lambda_handler(_make_s3_event(), {})

        table = dynamodb.Table(TABLE)
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(INDEX_ID)
        )
        data_rows = [item for item in resp["Items"] if item["sk"] != "META"]
        assert len(data_rows) == 1
        assert data_rows[0]["Vendor"] == "NewCo"

    def test_clear_does_not_delete_meta(self, lf):
        mod, dynamodb, s3, *_ = lf
        _upload(s3, _simple_xlsx(2))
        mod.lambda_handler(_make_s3_event(), {})
        # Second parse
        _upload(s3, _simple_xlsx(1))
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        meta = table.get_item(Key={"pk": INDEX_ID, "sk": "META"}).get("Item")
        assert meta is not None


# ---------------------------------------------------------------------------
# Delete event
# ---------------------------------------------------------------------------

class TestDeleteEvent:
    def test_delete_event_clears_index(self, lf):
        mod, dynamodb, s3, *_ = lf
        # First populate
        _upload(s3, _simple_xlsx(3))
        mod.lambda_handler(_make_s3_event(), {})

        # Now send delete event
        del_event = _make_s3_event(event_name="ObjectRemoved:Delete")
        resp = mod.lambda_handler(del_event, {})
        body = json.loads(resp["body"])
        assert body["status"] == "deleted"
        assert body["index_id"] == INDEX_ID

    def test_delete_event_writes_no_data_meta_status(self, lf):
        mod, dynamodb, s3, *_ = lf
        _upload(s3, _simple_xlsx(2))
        mod.lambda_handler(_make_s3_event(), {})

        del_event = _make_s3_event(event_name="ObjectRemoved:Delete")
        mod.lambda_handler(del_event, {})

        table = dynamodb.Table(TABLE)
        meta = table.get_item(Key={"pk": INDEX_ID, "sk": "META"})["Item"]
        assert meta["status"] == "NO_DATA"
        assert int(meta["row_count"]) == 0

    def test_delete_event_calls_delete_from_registry(self, lf):
        mod, _, s3, _, mock_del_reg = lf
        _upload(s3, _simple_xlsx(1))
        mod.lambda_handler(_make_s3_event(), {})

        del_event = _make_s3_event(event_name="ObjectRemoved:Delete")
        mod.lambda_handler(del_event, {})
        mock_del_reg.assert_called_with(INDEX_ID)

    def test_delete_event_non_xlsx_is_skipped(self, lf):
        mod, *_ = lf
        event = _make_s3_event(key="indexes/my_index/readme.txt", event_name="ObjectRemoved:Delete")
        resp = mod.lambda_handler(event, {})
        assert resp["body"] == "{}"


# ---------------------------------------------------------------------------
# Error handling — corrupted file
# ---------------------------------------------------------------------------

class TestErrorHandling:
    def test_bad_xlsx_bytes_returns_error_status(self, lf):
        mod, _, s3, *_ = lf
        s3.put_object(Bucket=BUCKET, Key=KEY, Body=b"this is not a valid xlsx file")
        resp = mod.lambda_handler(_make_s3_event(), {})
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert body["status"] == "error"

    def test_bad_xlsx_writes_error_meta(self, lf):
        mod, dynamodb, s3, *_ = lf
        s3.put_object(Bucket=BUCKET, Key=KEY, Body=b"garbage bytes")
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        meta = table.get_item(Key={"pk": INDEX_ID, "sk": "META"}).get("Item")
        assert meta is not None
        assert meta["status"] == "ERROR"
        assert "error" in meta

    def test_missing_s3_object_returns_error(self, lf):
        """Lambda should catch the S3 NoSuchKey error gracefully."""
        mod, *_ = lf
        # Key not uploaded — S3.get_object will raise
        resp = mod.lambda_handler(_make_s3_event(), {})
        body = json.loads(resp["body"])
        assert body["status"] == "error"

    def test_write_to_registry_failure_does_not_crash_lambda(self, lf):
        """If write_to_registry raises, the Lambda should still return a 200."""
        mod, _, s3, mock_write_reg, _ = lf
        mock_write_reg.side_effect = RuntimeError("Registry unavailable")
        _upload(s3, _simple_xlsx(1))
        resp = mod.lambda_handler(_make_s3_event(), {})
        # The error is caught; statusCode must still be 200
        assert resp["statusCode"] == 200


# ---------------------------------------------------------------------------
# Multiple records in one event
# ---------------------------------------------------------------------------

class TestMultipleRecords:
    def test_only_xlsx_records_are_processed(self, lf):
        mod, dynamodb, s3, *_ = lf
        _upload(s3, _simple_xlsx(2))
        event = {
            "Records": [
                {
                    "eventName": "ObjectCreated:Put",
                    "s3": {"bucket": {"name": BUCKET}, "object": {"key": "indexes/test_vendors/notes.txt"}},
                },
                {
                    "eventName": "ObjectCreated:Put",
                    "s3": {"bucket": {"name": BUCKET}, "object": {"key": KEY}},
                },
            ]
        }
        resp = mod.lambda_handler(event, {})
        body = json.loads(resp["body"])
        assert body["status"] == "ok"
        assert body["row_count"] == 2


# ---------------------------------------------------------------------------
# Value serialisation in stored rows
# ---------------------------------------------------------------------------

class TestValueSerialisation:
    def test_integer_cells_stored_as_string(self, lf):
        mod, dynamodb, s3, *_ = lf
        xlsx = _make_xlsx(["Vendor", "Amount"], [["Acme", 42]])
        _upload(s3, xlsx)
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(INDEX_ID)
        )
        data_rows = [item for item in resp["Items"] if item["sk"] != "META"]
        assert data_rows[0]["Amount"] == "42"

    def test_none_cells_stored_as_empty_string(self, lf):
        mod, dynamodb, s3, *_ = lf
        xlsx = _make_xlsx(["Vendor", "Amount"], [["Acme", None]])
        _upload(s3, xlsx)
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(INDEX_ID)
        )
        data_rows = [item for item in resp["Items"] if item["sk"] != "META"]
        assert data_rows[0]["Amount"] == ""

    def test_date_cells_serialised_to_iso_string(self, lf):
        """openpyxl reads date cells as datetime objects; _to_str calls .isoformat()."""
        mod, dynamodb, s3, *_ = lf
        wb = Workbook()
        ws = wb.active
        ws.append(["Vendor", "Start Date"])
        ws.append(["Acme", date(2024, 6, 15)])
        buf = io.BytesIO()
        wb.save(buf)
        _upload(s3, buf.getvalue())
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(INDEX_ID)
        )
        data_rows = [item for item in resp["Items"] if item["sk"] != "META"]
        # openpyxl returns date cells as datetime objects; .isoformat() produces
        # either "2024-06-15" (pure date) or "2024-06-15T00:00:00" (datetime).
        assert data_rows[0]["Start_Date"].startswith("2024-06-15")

    def test_float_cells_stored_as_string(self, lf):
        mod, dynamodb, s3, *_ = lf
        xlsx = _make_xlsx(["Vendor", "Rate"], [["Acme", 3.14]])
        _upload(s3, xlsx)
        mod.lambda_handler(_make_s3_event(), {})
        table = dynamodb.Table(TABLE)
        resp = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq(INDEX_ID)
        )
        data_rows = [item for item in resp["Items"] if item["sk"] != "META"]
        assert data_rows[0]["Rate"] == "3.14"


# ---------------------------------------------------------------------------
# Sample rows passed to write_to_registry
# ---------------------------------------------------------------------------

class TestSampleRows:
    def test_sample_rows_capped_at_five(self, lf):
        """write_to_registry is called with sample_rows=rows[:5]; verify cap."""
        mod, _, s3, mock_write_reg, _ = lf
        _upload(s3, _simple_xlsx(10))
        mod.lambda_handler(_make_s3_event(), {})
        # sample_rows is passed as a keyword argument
        sample = mock_write_reg.call_args.kwargs["sample_rows"]
        assert len(sample) <= 5

    def test_sample_rows_fewer_than_five_when_small_file(self, lf):
        """When there are only 2 rows the full set is used as sample."""
        mod, _, s3, mock_write_reg, _ = lf
        _upload(s3, _simple_xlsx(2))
        mod.lambda_handler(_make_s3_event(), {})
        sample = mock_write_reg.call_args.kwargs["sample_rows"]
        assert len(sample) == 2
