import json


def truncate_text(value, max_length: int):
    text = str(value or "")
    return text[:max_length]


def safe_int(value, default: int, *, minimum: int | None = None, maximum: int | None = None) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    if minimum is not None:
        parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def extract_json_object(text: str):
    if not text:
        raise ValueError("JSON text is empty")
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("No JSON object found in text")
    return json.loads(text[start : end + 1])
