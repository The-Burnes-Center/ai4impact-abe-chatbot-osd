"""
Unit tests for the session-handler Lambda.

Covers:
  - Session creation (add_session / append_chat_entry upsert path)
  - Session retrieval (get_session — found, missing)
  - Session update (update_session, append_chat_entry)
  - Session deletion (delete_session, delete_user_sessions)
  - Session listing (list_sessions_by_user_id, list_all_sessions_by_user_id)
  - Context summary update (update_context_summary)
  - DynamoDB error handling (ResourceNotFoundException, ConditionalCheckFailedException,
    ProvisionedThroughputExceededException, ValidationException, generic 500)
  - Input validation (unknown operation, invalid JSON body)
  - Title truncation at 80 characters
  - utc_now_iso format

Uses moto to mock DynamoDB — no real AWS calls are made.
"""
import importlib.util
import json
import os
import sys
from unittest.mock import MagicMock, patch

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

# ---------------------------------------------------------------------------
# Path helpers — add handler dir and Python layer to sys.path
# ---------------------------------------------------------------------------

HANDLER_DIR = os.path.dirname(os.path.abspath(__file__))
LAYER_DIR = os.path.abspath(
    os.path.join(HANDLER_DIR, "..", "layers", "python-common", "python")
)

for _d in (HANDLER_DIR, LAYER_DIR):
    if _d not in sys.path:
        sys.path.insert(0, _d)

_LF_PATH = os.path.join(HANDLER_DIR, "lambda_function.py")

TABLE = "test-session-table"
USER_ID = "user-abc-123"
SESSION_ID = "sess-xyz-456"

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def env_vars(monkeypatch):
    monkeypatch.setenv("DDB_TABLE_NAME", TABLE)
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")


def _make_table(dynamodb):
    """Create the ChatHistory DynamoDB table with the TimeIndex GSI."""
    table = dynamodb.create_table(
        TableName=TABLE,
        KeySchema=[
            {"AttributeName": "user_id", "KeyType": "HASH"},
            {"AttributeName": "session_id", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "user_id", "AttributeType": "S"},
            {"AttributeName": "session_id", "AttributeType": "S"},
            {"AttributeName": "time_stamp", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "TimeIndex",
                "KeySchema": [
                    {"AttributeName": "user_id", "KeyType": "HASH"},
                    {"AttributeName": "time_stamp", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    return table


def _load_lf(dynamodb_resource):
    """Load lambda_function.py and patch its module-level DynamoDB resource/table."""
    # Evict stale cached abe_utils sub-modules
    for mod_name in list(sys.modules.keys()):
        if mod_name.startswith("abe_utils"):
            sys.modules.pop(mod_name)

    spec = importlib.util.spec_from_file_location("session_handler_lf", _LF_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    # Replace module-level DynamoDB resource and table with the moto-backed versions
    mod.dynamodb = dynamodb_resource
    mod.table = dynamodb_resource.Table(TABLE)
    return mod


@pytest.fixture()
def ctx():
    """
    Yield (lf_module, moto_table) inside a live moto mock_aws context.
    The table is fully provisioned with the TimeIndex GSI.
    """
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        _make_table(ddb)
        lf = _load_lf(ddb)
        yield lf, ddb.Table(TABLE)


def _invoke(lf, body: dict) -> dict:
    """Call lambda_handler with a body dict; return the parsed response."""
    response = lf.lambda_handler({"body": json.dumps(body)}, {})
    response["_parsed"] = json.loads(response["body"])
    return response


def _seed_session(table, user_id=USER_ID, session_id=SESSION_ID,
                  title="Test Session", history=None, time_stamp=None):
    """Directly insert a session item into the moto table."""
    table.put_item(Item={
        "user_id": user_id,
        "session_id": session_id,
        "title": title,
        "chat_history": history or [{"role": "user", "content": "hello"}],
        "time_stamp": time_stamp or "2025-01-01T00:00:00Z",
    })


# ---------------------------------------------------------------------------
# utc_now_iso
# ---------------------------------------------------------------------------


class TestUtcNowIso:
    def test_format_ends_with_z(self, ctx):
        lf, _ = ctx
        ts = lf.utc_now_iso()
        assert ts.endswith("Z"), f"Expected ISO timestamp ending in Z, got: {ts}"

    def test_format_no_microseconds(self, ctx):
        lf, _ = ctx
        ts = lf.utc_now_iso()
        # Should be YYYY-MM-DDTHH:MM:SSZ — 20 characters exactly
        assert len(ts) == 20, f"Unexpected timestamp length: {ts}"

    def test_no_plus_offset(self, ctx):
        lf, _ = ctx
        ts = lf.utc_now_iso()
        assert "+00:00" not in ts


# ---------------------------------------------------------------------------
# add_session
# ---------------------------------------------------------------------------


class TestAddSession:
    def test_creates_new_session_returns_200(self, ctx):
        lf, table = ctx
        resp = _invoke(lf, {
            "operation": "add_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "title": "My Chat",
            "new_chat_entry": {"role": "user", "content": "hi"},
        })
        assert resp["statusCode"] == 200
        assert resp["_parsed"]["created"] is True

    def test_creates_session_with_provided_title(self, ctx):
        lf, table = ctx
        resp = _invoke(lf, {
            "operation": "add_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "title": "Custom Title",
            "new_chat_entry": {"role": "user", "content": "hi"},
        })
        assert resp["_parsed"]["title"] == "Custom Title"

    def test_creates_session_stores_chat_entry_in_ddb(self, ctx):
        lf, table = ctx
        entry = {"role": "user", "content": "first message"}
        _invoke(lf, {
            "operation": "add_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "title": "A Session",
            "new_chat_entry": entry,
        })
        item = table.get_item(Key={"user_id": USER_ID, "session_id": SESSION_ID})["Item"]
        assert item["chat_history"] == [entry]
        assert item["title"] == "A Session"

    def test_auto_generates_title_when_none_provided(self, ctx):
        lf, table = ctx
        resp = _invoke(lf, {
            "operation": "add_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "title": None,
            "new_chat_entry": {"role": "user", "content": "hi"},
        })
        assert resp["statusCode"] == 200
        title = resp["_parsed"]["title"]
        assert title.startswith("Chat on ")

    def test_auto_generates_title_when_field_absent(self, ctx):
        lf, table = ctx
        resp = _invoke(lf, {
            "operation": "add_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "new_chat_entry": {"role": "user", "content": "hi"},
        })
        assert resp["statusCode"] == 200
        assert resp["_parsed"]["title"].startswith("Chat on ")

    def test_title_truncated_to_80_chars(self, ctx):
        lf, table = ctx
        long_title = "A" * 120
        resp = _invoke(lf, {
            "operation": "add_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "title": long_title,
            "new_chat_entry": {"role": "user", "content": "hi"},
        })
        assert resp["statusCode"] == 200
        assert len(resp["_parsed"]["title"]) == 80

    def test_duplicate_session_returns_409(self, ctx):
        lf, table = ctx
        payload = {
            "operation": "add_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "title": "First",
            "new_chat_entry": {"role": "user", "content": "hi"},
        }
        _invoke(lf, payload)
        resp = _invoke(lf, payload)
        assert resp["statusCode"] == 409

    def test_time_stamp_written_to_ddb(self, ctx):
        lf, table = ctx
        _invoke(lf, {
            "operation": "add_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "title": "TS test",
            "new_chat_entry": {"role": "user", "content": "hi"},
        })
        item = table.get_item(Key={"user_id": USER_ID, "session_id": SESSION_ID})["Item"]
        assert "time_stamp" in item
        assert item["time_stamp"].endswith("Z")


# ---------------------------------------------------------------------------
# get_session
# ---------------------------------------------------------------------------


class TestGetSession:
    def test_returns_existing_session(self, ctx):
        lf, table = ctx
        _seed_session(table)
        resp = _invoke(lf, {
            "operation": "get_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
        })
        assert resp["statusCode"] == 200
        body = resp["_parsed"]
        assert body["session_id"] == SESSION_ID
        assert body["user_id"] == USER_ID

    def test_returns_empty_dict_for_missing_session(self, ctx):
        lf, _ = ctx
        resp = _invoke(lf, {
            "operation": "get_session",
            "user_id": USER_ID,
            "session_id": "does-not-exist",
        })
        assert resp["statusCode"] == 200
        assert resp["_parsed"] == {}

    def test_returns_chat_history_intact(self, ctx):
        lf, table = ctx
        history = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi there"},
        ]
        _seed_session(table, history=history)
        resp = _invoke(lf, {
            "operation": "get_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
        })
        assert resp["_parsed"]["chat_history"] == history


# ---------------------------------------------------------------------------
# update_session
# ---------------------------------------------------------------------------


class TestUpdateSession:
    def test_appends_chat_entry(self, ctx):
        lf, table = ctx
        _seed_session(table, history=[{"role": "user", "content": "first"}])
        resp = _invoke(lf, {
            "operation": "update_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "new_chat_entry": {"role": "assistant", "content": "response"},
        })
        assert resp["statusCode"] == 200
        item = table.get_item(Key={"user_id": USER_ID, "session_id": SESSION_ID})["Item"]
        assert len(item["chat_history"]) == 2
        assert item["chat_history"][1]["role"] == "assistant"

    def test_updates_time_stamp(self, ctx):
        lf, table = ctx
        _seed_session(table, time_stamp="2020-01-01T00:00:00Z")
        _invoke(lf, {
            "operation": "update_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "new_chat_entry": {"role": "user", "content": "new msg"},
        })
        item = table.get_item(Key={"user_id": USER_ID, "session_id": SESSION_ID})["Item"]
        assert item["time_stamp"] != "2020-01-01T00:00:00Z"

    def test_returns_404_for_missing_session(self, ctx):
        lf, _ = ctx
        resp = _invoke(lf, {
            "operation": "update_session",
            "user_id": USER_ID,
            "session_id": "nonexistent-session",
            "new_chat_entry": {"role": "user", "content": "msg"},
        })
        assert resp["statusCode"] == 404

    def test_returns_200_with_attributes(self, ctx):
        lf, table = ctx
        _seed_session(table)
        resp = _invoke(lf, {
            "operation": "update_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "new_chat_entry": {"role": "user", "content": "msg"},
        })
        assert resp["statusCode"] == 200


# ---------------------------------------------------------------------------
# append_chat_entry
# ---------------------------------------------------------------------------


class TestAppendChatEntry:
    def test_upserts_new_session_when_not_exists(self, ctx):
        lf, table = ctx
        resp = _invoke(lf, {
            "operation": "append_chat_entry",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "new_chat_entry": {"role": "user", "content": "hello"},
            "title": "New Session",
        })
        assert resp["statusCode"] == 200
        assert resp["_parsed"]["created"] is True

    def test_appends_to_existing_session(self, ctx):
        lf, table = ctx
        _seed_session(table, history=[{"role": "user", "content": "first"}])
        resp = _invoke(lf, {
            "operation": "append_chat_entry",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "new_chat_entry": {"role": "assistant", "content": "second"},
            "title": "Existing Session",
        })
        assert resp["statusCode"] == 200
        assert resp["_parsed"]["created"] is False
        item = table.get_item(Key={"user_id": USER_ID, "session_id": SESSION_ID})["Item"]
        assert len(item["chat_history"]) == 2

    def test_does_not_overwrite_existing_title(self, ctx):
        lf, table = ctx
        _seed_session(table, title="Original Title")
        _invoke(lf, {
            "operation": "append_chat_entry",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "new_chat_entry": {"role": "user", "content": "msg"},
            "title": "New Title Attempt",
        })
        item = table.get_item(Key={"user_id": USER_ID, "session_id": SESSION_ID})["Item"]
        assert item["title"] == "Original Title"

    def test_auto_generates_title_when_none_provided(self, ctx):
        lf, table = ctx
        resp = _invoke(lf, {
            "operation": "append_chat_entry",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "new_chat_entry": {"role": "user", "content": "hi"},
            "title": None,
        })
        assert resp["statusCode"] == 200
        assert resp["_parsed"]["title"].startswith("Chat on ")

    def test_title_truncated_to_80_chars(self, ctx):
        lf, table = ctx
        resp = _invoke(lf, {
            "operation": "append_chat_entry",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "new_chat_entry": {"role": "user", "content": "hi"},
            "title": "B" * 200,
        })
        assert resp["statusCode"] == 200
        assert len(resp["_parsed"]["title"]) == 80


# ---------------------------------------------------------------------------
# delete_session
# ---------------------------------------------------------------------------


class TestDeleteSession:
    def test_deletes_existing_session(self, ctx):
        lf, table = ctx
        _seed_session(table)
        resp = _invoke(lf, {
            "operation": "delete_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
        })
        assert resp["statusCode"] == 200
        assert resp["_parsed"]["deleted"] is True
        item = table.get_item(Key={"user_id": USER_ID, "session_id": SESSION_ID})
        assert "Item" not in item

    def test_deletes_nonexistent_session_returns_200(self, ctx):
        # DynamoDB delete_item is idempotent; no error for missing items
        lf, _ = ctx
        resp = _invoke(lf, {
            "operation": "delete_session",
            "user_id": USER_ID,
            "session_id": "ghost-session",
        })
        assert resp["statusCode"] == 200
        assert resp["_parsed"]["deleted"] is True

    def test_response_includes_session_id(self, ctx):
        lf, table = ctx
        _seed_session(table)
        resp = _invoke(lf, {
            "operation": "delete_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
        })
        assert resp["_parsed"]["id"] == SESSION_ID


# ---------------------------------------------------------------------------
# delete_user_sessions
# ---------------------------------------------------------------------------


class TestDeleteUserSessions:
    def test_deletes_all_sessions_for_user(self, ctx):
        lf, table = ctx
        for i in range(3):
            _seed_session(
                table,
                session_id=f"sess-{i}",
                time_stamp=f"2025-01-0{i + 1}T00:00:00Z",
            )
        resp = _invoke(lf, {
            "operation": "delete_user_sessions",
            "user_id": USER_ID,
        })
        assert resp["statusCode"] == 200
        deleted = resp["_parsed"]
        assert len(deleted) == 3
        assert all(d["deleted"] for d in deleted)

    def test_returns_empty_list_when_no_sessions(self, ctx):
        lf, _ = ctx
        resp = _invoke(lf, {
            "operation": "delete_user_sessions",
            "user_id": "user-with-no-sessions",
        })
        assert resp["statusCode"] == 200
        assert resp["_parsed"] == []

    def test_each_result_has_id_and_deleted_keys(self, ctx):
        lf, table = ctx
        _seed_session(table)
        resp = _invoke(lf, {
            "operation": "delete_user_sessions",
            "user_id": USER_ID,
        })
        for entry in resp["_parsed"]:
            assert "id" in entry
            assert "deleted" in entry


# ---------------------------------------------------------------------------
# list_sessions_by_user_id
# ---------------------------------------------------------------------------


class TestListSessionsByUserId:
    def test_returns_sessions_sorted_by_time_stamp_desc(self, ctx):
        lf, table = ctx
        timestamps = [
            "2025-01-01T10:00:00Z",
            "2025-01-03T10:00:00Z",
            "2025-01-02T10:00:00Z",
        ]
        for i, ts in enumerate(timestamps):
            _seed_session(table, session_id=f"sess-{i}", time_stamp=ts)

        resp = _invoke(lf, {
            "operation": "list_sessions_by_user_id",
            "user_id": USER_ID,
        })
        assert resp["statusCode"] == 200
        sessions = resp["_parsed"]
        assert len(sessions) == 3
        ts_list = [s["time_stamp"] for s in sessions]
        assert ts_list == sorted(ts_list, reverse=True)

    def test_returns_empty_list_for_unknown_user(self, ctx):
        lf, _ = ctx
        resp = _invoke(lf, {
            "operation": "list_sessions_by_user_id",
            "user_id": "unknown-user",
        })
        assert resp["statusCode"] == 200
        assert resp["_parsed"] == []

    def test_response_contains_required_fields(self, ctx):
        lf, table = ctx
        _seed_session(table)
        resp = _invoke(lf, {
            "operation": "list_sessions_by_user_id",
            "user_id": USER_ID,
        })
        session = resp["_parsed"][0]
        assert "session_id" in session
        assert "title" in session
        assert "time_stamp" in session

    def test_list_all_sessions_operation_alias(self, ctx):
        lf, table = ctx
        for i in range(3):
            _seed_session(
                table,
                session_id=f"sess-{i}",
                time_stamp=f"2025-01-0{i + 1}T00:00:00Z",
            )
        resp = _invoke(lf, {
            "operation": "list_all_sessions_by_user_id",
            "user_id": USER_ID,
        })
        assert resp["statusCode"] == 200
        assert len(resp["_parsed"]) == 3

    def test_title_whitespace_stripped_in_listing(self, ctx):
        lf, table = ctx
        _seed_session(table, title="  Padded Title  ")
        resp = _invoke(lf, {
            "operation": "list_sessions_by_user_id",
            "user_id": USER_ID,
        })
        assert resp["_parsed"][0]["title"] == "Padded Title"


# ---------------------------------------------------------------------------
# update_context_summary
# ---------------------------------------------------------------------------


class TestUpdateContextSummary:
    def test_writes_summary_to_existing_session(self, ctx):
        lf, table = ctx
        _seed_session(table)
        resp = _invoke(lf, {
            "operation": "update_context_summary",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "context_summary": "Summary of the conversation so far.",
        })
        assert resp["statusCode"] == 200
        assert resp["_parsed"]["updated"] is True
        item = table.get_item(Key={"user_id": USER_ID, "session_id": SESSION_ID})["Item"]
        assert item["context_summary"] == "Summary of the conversation so far."

    def test_writes_empty_summary(self, ctx):
        lf, table = ctx
        _seed_session(table)
        resp = _invoke(lf, {
            "operation": "update_context_summary",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            "context_summary": "",
        })
        assert resp["statusCode"] == 200

    def test_context_summary_defaults_to_empty_string_when_absent(self, ctx):
        lf, table = ctx
        _seed_session(table)
        resp = _invoke(lf, {
            "operation": "update_context_summary",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
            # no context_summary key
        })
        assert resp["statusCode"] == 200


# ---------------------------------------------------------------------------
# lambda_handler dispatch and input validation
# ---------------------------------------------------------------------------


class TestLambdaHandlerDispatch:
    def test_unknown_operation_returns_400(self, ctx):
        lf, _ = ctx
        resp = _invoke(lf, {
            "operation": "fly_to_the_moon",
            "user_id": USER_ID,
        })
        assert resp["statusCode"] == 400

    def test_unknown_operation_message_includes_sent_operation(self, ctx):
        lf, _ = ctx
        resp = _invoke(lf, {"operation": "do_something_unknown", "user_id": USER_ID})
        assert "do_something_unknown" in resp["_parsed"]

    def test_invalid_json_body_returns_400(self, ctx):
        lf, _ = ctx
        resp = lf.lambda_handler({"body": "not-valid-json{"}, {})
        assert resp["statusCode"] == 400

    def test_missing_body_uses_empty_defaults_and_returns_400(self, ctx):
        lf, _ = ctx
        # No body at all → parse_json_body returns {} → operation is None → 400
        resp = lf.lambda_handler({}, {})
        assert resp["statusCode"] == 400

    def test_body_as_dict_is_accepted(self, ctx):
        """parse_json_body also accepts a dict body (API GW proxy integration variation)."""
        lf, table = ctx
        _seed_session(table)
        resp = lf.lambda_handler(
            {
                "body": {
                    "operation": "get_session",
                    "user_id": USER_ID,
                    "session_id": SESSION_ID,
                }
            },
            {},
        )
        assert resp["statusCode"] == 200

    def test_response_has_cors_headers(self, ctx):
        lf, table = ctx
        _seed_session(table)
        resp = _invoke(lf, {
            "operation": "get_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
        })
        assert resp["headers"]["Access-Control-Allow-Origin"] == "*"

    def test_response_content_type_is_json(self, ctx):
        lf, table = ctx
        _seed_session(table)
        resp = _invoke(lf, {
            "operation": "get_session",
            "user_id": USER_ID,
            "session_id": SESSION_ID,
        })
        assert resp["headers"]["Content-Type"] == "application/json"


# ---------------------------------------------------------------------------
# DynamoDB error handling (patched ClientError injection)
# ---------------------------------------------------------------------------


def _client_error(code: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": "mocked error"}},
        "OperationName",
    )


class TestDynamoDbErrors:
    def test_get_session_resource_not_found_returns_404(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "get_item", side_effect=_client_error("ResourceNotFoundException")):
            resp = _invoke(lf, {
                "operation": "get_session",
                "user_id": USER_ID,
                "session_id": SESSION_ID,
            })
        assert resp["statusCode"] == 404

    def test_get_session_generic_error_returns_500(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "get_item", side_effect=_client_error("InternalServerError")):
            resp = _invoke(lf, {
                "operation": "get_session",
                "user_id": USER_ID,
                "session_id": SESSION_ID,
            })
        assert resp["statusCode"] == 500

    def test_add_session_resource_not_found_returns_404(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "put_item", side_effect=_client_error("ResourceNotFoundException")):
            resp = _invoke(lf, {
                "operation": "add_session",
                "user_id": USER_ID,
                "session_id": SESSION_ID,
                "title": "T",
                "new_chat_entry": {},
            })
        assert resp["statusCode"] == 404

    def test_add_session_conditional_check_failed_returns_409(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "put_item", side_effect=_client_error("ConditionalCheckFailedException")):
            resp = _invoke(lf, {
                "operation": "add_session",
                "user_id": USER_ID,
                "session_id": SESSION_ID,
                "title": "T",
                "new_chat_entry": {},
            })
        assert resp["statusCode"] == 409

    def test_add_session_generic_error_returns_500(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "put_item", side_effect=_client_error("ProvisionedThroughputExceededException")):
            resp = _invoke(lf, {
                "operation": "add_session",
                "user_id": USER_ID,
                "session_id": SESSION_ID,
                "title": "T",
                "new_chat_entry": {},
            })
        assert resp["statusCode"] == 500

    def test_update_session_resource_not_found_returns_404(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "update_item", side_effect=_client_error("ResourceNotFoundException")):
            resp = _invoke(lf, {
                "operation": "update_session",
                "user_id": USER_ID,
                "session_id": SESSION_ID,
                "new_chat_entry": {},
            })
        assert resp["statusCode"] == 404

    def test_update_session_conditional_check_failed_returns_404(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "update_item", side_effect=_client_error("ConditionalCheckFailedException")):
            resp = _invoke(lf, {
                "operation": "update_session",
                "user_id": USER_ID,
                "session_id": SESSION_ID,
                "new_chat_entry": {},
            })
        assert resp["statusCode"] == 404

    def test_update_session_generic_error_returns_500(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "update_item", side_effect=_client_error("InternalServerError")):
            resp = _invoke(lf, {
                "operation": "update_session",
                "user_id": USER_ID,
                "session_id": SESSION_ID,
                "new_chat_entry": {},
            })
        assert resp["statusCode"] == 500

    def test_append_chat_entry_client_error_returns_500(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "update_item", side_effect=_client_error("InternalServerError")):
            resp = _invoke(lf, {
                "operation": "append_chat_entry",
                "user_id": USER_ID,
                "session_id": SESSION_ID,
                "new_chat_entry": {},
                "title": "T",
            })
        assert resp["statusCode"] == 500

    def test_delete_session_resource_not_found_returns_404(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "delete_item", side_effect=_client_error("ResourceNotFoundException")):
            resp = _invoke(lf, {
                "operation": "delete_session",
                "user_id": USER_ID,
                "session_id": SESSION_ID,
            })
        assert resp["statusCode"] == 404

    def test_delete_session_generic_error_returns_500(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "delete_item", side_effect=_client_error("InternalServerError")):
            resp = _invoke(lf, {
                "operation": "delete_session",
                "user_id": USER_ID,
                "session_id": SESSION_ID,
            })
        assert resp["statusCode"] == 500

    def test_list_sessions_resource_not_found_returns_404(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "query", side_effect=_client_error("ResourceNotFoundException")):
            resp = _invoke(lf, {
                "operation": "list_sessions_by_user_id",
                "user_id": USER_ID,
            })
        assert resp["statusCode"] == 404

    def test_list_sessions_throughput_exceeded_returns_429(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "query", side_effect=_client_error("ProvisionedThroughputExceededException")):
            resp = _invoke(lf, {
                "operation": "list_sessions_by_user_id",
                "user_id": USER_ID,
            })
        assert resp["statusCode"] == 429

    def test_list_sessions_validation_exception_returns_400(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "query", side_effect=_client_error("ValidationException")):
            resp = _invoke(lf, {
                "operation": "list_sessions_by_user_id",
                "user_id": USER_ID,
            })
        assert resp["statusCode"] == 400

    def test_list_sessions_generic_error_returns_500(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "query", side_effect=_client_error("InternalServerError")):
            resp = _invoke(lf, {
                "operation": "list_sessions_by_user_id",
                "user_id": USER_ID,
            })
        assert resp["statusCode"] == 500

    def test_list_sessions_unexpected_exception_returns_500(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "query", side_effect=RuntimeError("boom")):
            resp = _invoke(lf, {
                "operation": "list_sessions_by_user_id",
                "user_id": USER_ID,
            })
        assert resp["statusCode"] == 500

    def test_update_context_summary_client_error_returns_500(self, ctx):
        lf, _ = ctx
        with patch.object(lf.table, "update_item", side_effect=_client_error("InternalServerError")):
            resp = _invoke(lf, {
                "operation": "update_context_summary",
                "user_id": USER_ID,
                "session_id": SESSION_ID,
                "context_summary": "text",
            })
        assert resp["statusCode"] == 500
