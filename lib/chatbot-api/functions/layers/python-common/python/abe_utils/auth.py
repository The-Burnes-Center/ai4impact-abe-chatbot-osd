import json
import re

from .validation import truncate_text

# Cognito display names often look like "Last, First (A&F)" — same convention as the web app.
_NAME_WITH_AGENCY = re.compile(r"^.+\s*\([^)]+\)\s*$")


def get_claims(event: dict | None) -> dict:
    return (
        (event or {})
        .get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )


def get_roles(event: dict | None) -> list[str]:
    claims = get_claims(event)
    raw_roles = claims.get("custom:role", "[]")
    if isinstance(raw_roles, list):
        return [str(role) for role in raw_roles]
    try:
        parsed = json.loads(raw_roles)
    except (TypeError, json.JSONDecodeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(role) for role in parsed]


def is_admin_request(event: dict | None) -> bool:
    return any("Admin" in role for role in get_roles(event))


def get_audit_actor_label(event: dict | None, *, max_length: int = 200) -> str:
    """Human-readable actor for audit logs: prefers name (agency) from JWT, then email or username."""
    claims = get_claims(event)
    raw_name = str(claims.get("name") or "").strip()
    email = str(claims.get("email") or "").strip()
    username = str(claims.get("cognito:username") or claims.get("username") or "").strip()
    custom_agency = str(claims.get("custom:agency") or claims.get("custom:Agency") or "").strip()

    if raw_name:
        if _NAME_WITH_AGENCY.match(raw_name):
            return truncate_text(raw_name, max_length)
        if custom_agency and custom_agency.lower() != "unknown":
            return truncate_text(f"{raw_name} ({custom_agency})", max_length)
        return truncate_text(raw_name, max_length)

    if custom_agency:
        return truncate_text(custom_agency, max_length)

    if email:
        return truncate_text(email, max_length)

    if username:
        return truncate_text(username, max_length)

    return "Admin"
