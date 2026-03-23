import re

# Matches inline KB chunk markers inserted by websocket-chat (insertCitationMarkers): [1], [2], …
_CITATION_BRACKETS = re.compile(r"\[\d+\]")


def strip_kb_citation_markers(text: str) -> str:
    """Remove inline source/chunk indices like [1] from stored expected answers.

    The chat pipeline inserts these at citation offsets; they are not meaningful for
    regression test text and break readability in the test library UI.
    """
    if not text or not text.strip():
        return text
    cleaned = _CITATION_BRACKETS.sub("", text)
    cleaned = re.sub(r"[ \t]+\n", "\n", cleaned)
    cleaned = re.sub(r"\n[ \t]+", "\n", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    return cleaned.strip()
