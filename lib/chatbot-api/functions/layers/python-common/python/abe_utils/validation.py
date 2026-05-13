import json
import re


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


_CODE_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```", re.IGNORECASE)


def _find_balanced_json_object(text: str) -> str | None:
    """Scan ``text`` for the first balanced ``{...}`` block, respecting string
    literals and escapes. Returns the substring or ``None`` if none is found.

    Naive ``find('{')`` / ``rfind('}')`` slicing breaks when the model output
    contains multiple JSON-looking fragments, prose with stray braces, or echoes
    an example schema before its real answer. Tracking brace depth while
    skipping content inside double-quoted strings reliably picks out the first
    well-formed object.
    """
    depth = 0
    start = -1
    in_string = False
    escape = False
    for i, ch in enumerate(text):
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth == 0:
                continue
            depth -= 1
            if depth == 0 and start != -1:
                return text[start : i + 1]
    return None


def extract_json_object(text: str):
    """Pull a JSON object out of an LLM response.

    Tries, in order:
      1. ``json.loads`` on the whole string (covers well-behaved models).
      2. ``json.loads`` on the contents of a ```json``` / ``` ``` code fence.
      3. The first balanced ``{...}`` block found by a brace-depth scanner.

    Raises ``ValueError`` if no valid JSON object can be recovered.
    """
    if not text:
        raise ValueError("JSON text is empty")

    stripped = text.strip()
    try:
        result = json.loads(stripped)
        if isinstance(result, dict):
            return result
    except (json.JSONDecodeError, ValueError):
        pass

    fence_match = _CODE_FENCE_RE.search(stripped)
    if fence_match:
        inner = fence_match.group(1).strip()
        try:
            result = json.loads(inner)
            if isinstance(result, dict):
                return result
        except (json.JSONDecodeError, ValueError):
            pass

    candidate = _find_balanced_json_object(stripped)
    if candidate:
        return json.loads(candidate)

    raise ValueError("No JSON object found in text")
