import json
from decimal import Decimal


class DecimalJSONEncoder(json.JSONEncoder):
    def default(self, value):
        if isinstance(value, Decimal):
            return float(value)
        return super().default(value)


def parse_json_body(event: dict | None, default: dict | None = None) -> dict:
    if default is None:
        default = {}
    body = (event or {}).get("body")
    if body is None:
        return default
    if isinstance(body, str):
        return json.loads(body) if body else default
    if isinstance(body, dict):
        return body
    return default


def json_response(
    status_code: int,
    body,
    *,
    headers: dict | None = None,
    encoder: type[json.JSONEncoder] = DecimalJSONEncoder,
) -> dict:
    response_headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Content-Type": "application/json",
    }
    if headers:
        response_headers.update(headers)
    return {
        "statusCode": status_code,
        "headers": response_headers,
        "body": json.dumps(body, cls=encoder),
    }
