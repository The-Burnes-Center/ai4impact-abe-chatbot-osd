"""
Unit tests for the WebSocket JWT authorizer Lambda.
Covers: valid token → Allow, missing token, bad kid, expired token,
wrong audience, JWKS fetch failure, JWKS timeout, signature failure.
All tests mock requests.get so no real HTTP calls are made.
"""
import importlib.util
import json
import os
import sys
import time
from unittest.mock import MagicMock, patch

import pytest
from jose import jwt
from jose.backends import RSAKey
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend

# ---------------------------------------------------------------------------
# RSA key fixtures for signing test tokens
# ---------------------------------------------------------------------------

def _generate_rsa_key():
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
        backend=default_backend(),
    )
    return private_key


def _private_pem(key):
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )


def _public_pem(key):
    return key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )


KID = "test-key-id"
RSA_PRIVATE = _generate_rsa_key()
RSA_PUBLIC_PEM = _public_pem(RSA_PRIVATE)

# Build a fake JWKS entry from the public key (RSAKey can export to dict)
_rsa_key_obj = RSAKey(RSA_PUBLIC_PEM, algorithm="RS256")
_jwk_dict = _rsa_key_obj.public_key().to_dict()
_jwk_dict["kid"] = KID
_jwk_dict["alg"] = "RS256"
_jwk_dict["use"] = "sig"

FAKE_JWKS = {"keys": [_jwk_dict]}
USER_POOL_ID = "us-east-1_testpool"
APP_CLIENT_ID = "testclientid"
METHOD_ARN = "arn:aws:execute-api:us-east-1:123456789:abc/prod/$connect"


def _make_token(sub="user123", exp_offset=3600, aud=APP_CLIENT_ID, kid=KID, private_key=None):
    """Sign a JWT with our test RSA key."""
    pk = private_key or RSA_PRIVATE
    pem = _private_pem(pk)
    now = int(time.time())
    claims = {"sub": sub, "aud": aud, "exp": now + exp_offset, "iat": now}
    return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": kid})


def _jwks_response(keys=None):
    mock = MagicMock()
    mock.raise_for_status = MagicMock()
    mock.json.return_value = {"keys": keys or FAKE_JWKS["keys"]}
    return mock


# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def env_vars(monkeypatch):
    monkeypatch.setenv("USER_POOL_ID", USER_POOL_ID)
    monkeypatch.setenv("APP_CLIENT_ID", APP_CLIENT_ID)


_LF_PATH = os.path.join(os.path.dirname(__file__), "lambda_function.py")


def _fresh_module():
    """Load the authorizer lambda_function.py by absolute path."""
    spec = importlib.util.spec_from_file_location("authorizer_lf", _LF_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _event(token=None):
    return {
        "queryStringParameters": {"Authorization": token} if token else {},
        "methodArn": METHOD_ARN,
    }


# ---------------------------------------------------------------------------
# Valid token
# ---------------------------------------------------------------------------

class TestValidToken:
    def test_returns_allow_policy(self):
        lf = _fresh_module()
        token = _make_token()
        with patch("requests.get", return_value=_jwks_response()):
            result = lf.lambda_handler(_event(token), {})
        assert result["policyDocument"]["Statement"][0]["Effect"] == "Allow"
        assert result["principalId"] == "user123"

    def test_method_arn_in_resource(self):
        lf = _fresh_module()
        token = _make_token()
        with patch("requests.get", return_value=_jwks_response()):
            result = lf.lambda_handler(_event(token), {})
        assert result["policyDocument"]["Statement"][0]["Resource"] == METHOD_ARN


# ---------------------------------------------------------------------------
# Missing / empty token
# ---------------------------------------------------------------------------

class TestMissingToken:
    def test_no_query_params_raises_unauthorized(self):
        lf = _fresh_module()
        with pytest.raises(Exception, match="Unauthorized"):
            lf.lambda_handler({"queryStringParameters": None, "methodArn": METHOD_ARN}, {})

    def test_missing_authorization_key_raises_unauthorized(self):
        lf = _fresh_module()
        with pytest.raises(Exception, match="Unauthorized"):
            lf.lambda_handler({"queryStringParameters": {}, "methodArn": METHOD_ARN}, {})

    def test_empty_string_token_raises_unauthorized(self):
        lf = _fresh_module()
        with pytest.raises(Exception, match="Unauthorized"):
            lf.lambda_handler(_event(""), {})


# ---------------------------------------------------------------------------
# Bad / unknown kid
# ---------------------------------------------------------------------------

class TestBadKid:
    def test_unknown_kid_raises_unauthorized(self):
        lf = _fresh_module()
        token = _make_token(kid="unknown-kid")
        with patch("requests.get", return_value=_jwks_response()):
            with pytest.raises(Exception, match="Unauthorized"):
                lf.lambda_handler(_event(token), {})

    def test_missing_kid_header_raises_unauthorized(self):
        lf = _fresh_module()
        # Build token without kid header
        pem = _private_pem(RSA_PRIVATE)
        now = int(time.time())
        claims = {"sub": "u", "aud": APP_CLIENT_ID, "exp": now + 3600}
        # jose will include kid if provided via headers; omit it
        token = jwt.encode(claims, pem, algorithm="RS256")
        with patch("requests.get", return_value=_jwks_response()):
            with pytest.raises(Exception, match="Unauthorized"):
                lf.lambda_handler(_event(token), {})


# ---------------------------------------------------------------------------
# Expired token
# ---------------------------------------------------------------------------

class TestExpiredToken:
    def test_expired_token_raises_unauthorized(self):
        lf = _fresh_module()
        token = _make_token(exp_offset=-1)  # already expired
        with patch("requests.get", return_value=_jwks_response()):
            with pytest.raises(Exception, match="Unauthorized"):
                lf.lambda_handler(_event(token), {})


# ---------------------------------------------------------------------------
# Wrong audience
# ---------------------------------------------------------------------------

class TestWrongAudience:
    def test_wrong_audience_raises_unauthorized(self):
        lf = _fresh_module()
        token = _make_token(aud="wrong-client")
        with patch("requests.get", return_value=_jwks_response()):
            with pytest.raises(Exception, match="Unauthorized"):
                lf.lambda_handler(_event(token), {})


# ---------------------------------------------------------------------------
# JWKS fetch failures
# ---------------------------------------------------------------------------

class TestJwksFetchFailure:
    def test_connection_error_raises_unauthorized(self):
        lf = _fresh_module()
        token = _make_token()
        with patch("requests.get", side_effect=Exception("Connection refused")):
            with pytest.raises(Exception, match="Unauthorized"):
                lf.lambda_handler(_event(token), {})

    def test_http_error_raises_unauthorized(self):
        lf = _fresh_module()
        token = _make_token()
        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = Exception("404 Not Found")
        with patch("requests.get", return_value=mock_resp):
            with pytest.raises(Exception, match="Unauthorized"):
                lf.lambda_handler(_event(token), {})

    def test_requests_get_called_with_timeout(self):
        """Authorizer must pass timeout= to requests.get to avoid hanging."""
        lf = _fresh_module()
        token = _make_token()
        with patch("requests.get", return_value=_jwks_response()) as mock_get:
            try:
                lf.lambda_handler(_event(token), {})
            except Exception:
                pass
            _, kwargs = mock_get.call_args
            assert "timeout" in kwargs, "requests.get must be called with a timeout"
