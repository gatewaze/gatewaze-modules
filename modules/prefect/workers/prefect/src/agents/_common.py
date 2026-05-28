"""Shared helpers for agent session wrappers.

Extracted from `agents/discovery.py` so the triage + processing wrappers
don't copy-paste the Claude SDK message parsing / JSON extraction logic.
"""

from __future__ import annotations

import re
from typing import Any


def extract_text(message: Any) -> str:
    """Best-effort text extraction from a Claude SDK stream message.

    Handles the common message shapes (string content, list of typed
    content blocks) and falls back to stringification.
    """
    content = getattr(message, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        pieces: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    pieces.append(text)
            else:
                text = getattr(item, "text", None)
                if isinstance(text, str):
                    pieces.append(text)
        return "\n".join(pieces)
    return ""


def extract_json_block(text: str) -> str:
    """Pull the first well-formed JSON object out of agent output.

    Tolerates markdown code fences, leading commentary, and trailing prose.
    Raises ValueError if no object can be located.
    """
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        return fenced.group(1)

    brace_start = text.find("{")
    brace_end = text.rfind("}")
    if brace_start != -1 and brace_end > brace_start:
        return text[brace_start : brace_end + 1]

    raise ValueError("No JSON object found in agent output")


def record_usage(message: Any, guard) -> None:
    """Record token usage on `guard` if the message carries a usage block.

    Raises `CostExceeded` (from the guard) if the recorded spend crosses
    the budget; callers should let this propagate so the flow marks the
    run as `aborted_cost_exceeded`.
    """
    usage = getattr(message, "usage", None)
    if usage is None:
        return
    guard.record(
        input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
        output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
    )
    guard.assert_within_budget()
