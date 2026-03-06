import json


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
