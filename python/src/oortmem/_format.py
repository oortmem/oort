"""``format_for_prompt``: the ``<oort-memory>`` block the hooks inject, built from a recall.

A port of the TypeScript SDK's ``formatForPrompt`` for a result rebuilt from its documented
fields (``views.ts`` ``fromView`` and core's ``formatForInjection``), character for character:
the same labels, the same budget arithmetic (in UTF-16 code units, as JavaScript counts), the same
Constellation quota, and the same escaping. The shared vectors in
``contract/sdk/vectors/format-for-prompt.json`` pin it to the TypeScript output.

Escaping: a memory's ``[`` and ``]`` become ``\\[`` and ``\\]`` (so text cannot pass for a label),
and the ``<`` of any ``<oort-...`` or ``</oort-...`` tag becomes ``&lt;`` (so text cannot close
the block). The scrubber's ``[REDACTED:kind]`` markers stay as they are. Each text is scrubbed
here first, with the port of core's scrubber (``_scrub.py``), and only then escaped: an escape
inside a secret would hide it from a scrub that ran after it, and a memory from Oort Cloud arrives
as the cloud stored it (a secret stored before a rule existed, or while a deploy lags a rule).
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any, List, Mapping, Optional, Union

from ._scrub import clean as _scrub_text
from .types import RecallResult, RecalledMemory, from_wire

__all__ = ["format_for_prompt", "DEFAULT_BUDGET_CHARS"]

#: Default block budget, as the config's ``recall.budgetChars``.
DEFAULT_BUDGET_CHARS = 6000
#: The share of the budget Constellation and Galaxy memories may take.
HIVE_QUOTA = 0.4

_OPEN = "<oort-memory>\n"
_CLOSE = "\n</oort-memory>"
_DAY_MS = 86_400_000

# JavaScript's \s, exactly (Python's \s differs on U+001C..U+001F and U+FEFF).
_JS_SPACE = r"[\t\n\u000b\u000c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"
_BLOCK_TAG = re.compile(f"<(?={_JS_SPACE}*/?{_JS_SPACE}*oort-)", re.IGNORECASE | re.ASCII)
_REDACTED = re.compile(r"(\[REDACTED:[a-z0-9-]+\])")


def _js_len(s: str) -> int:
    """The length JavaScript gives a string: UTF-16 code units."""
    return len(s.encode("utf-16-le")) // 2


def _ms(iso: str) -> float:
    """``Date.parse`` for the ISO 8601 forms Oort writes (``Z`` or an offset; a date alone is
    UTC midnight). NaN when it cannot be read."""
    s = iso.strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
            d = datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
        else:
            if s.endswith(("Z", "z")):
                s = s[:-1] + "+00:00"
            # Fractions beyond microseconds (JavaScript keeps milliseconds).
            s = re.sub(r"(\.\d{6})\d+", r"\1", s)
            d = datetime.fromisoformat(s)
            if d.tzinfo is None:
                # JavaScript reads a date-time without an offset as local time.
                d = d.astimezone()
    except ValueError:
        return math.nan
    return float(math.floor(d.timestamp() * 1000 + 1e-6))


def _age(valid_from: str, now_ms: float) -> str:
    vf = _ms(valid_from)
    if math.isnan(vf):
        return "NaNy ago"  # what JavaScript prints for an unreadable date, kept for parity
    days = max(0, math.floor((now_ms - vf) / _DAY_MS))
    if days < 1:
        return "today"
    if days < 2:
        return "yesterday"
    if days < 7:
        return f"{days}d ago"
    if days < 30:
        return f"{days // 7}w ago"
    if days < 365:
        return f"{days // 30}mo ago"
    return f"{days // 365}y ago"


def _ended(m: RecalledMemory) -> bool:
    return m.status not in ("current", "not-yet-valid")


def _is_current(m: RecalledMemory, now_ms: float) -> bool:
    # fromView: expiredAt is set (to updatedAt) only for an ended memory with no validTo.
    expired_at = m.updated_at if _ended(m) and m.valid_to is None else None
    if expired_at is not None:
        return False
    vf = _ms(m.valid_from)
    if not vf <= now_ms:  # NaN compares false, as in JavaScript
        return False
    if m.valid_to is None:
        return True
    return now_ms < _ms(m.valid_to)


def _when(m: RecalledMemory, now_ms: float) -> str:
    if _is_current(m, now_ms):
        return _age(m.valid_from, now_ms)
    span = f"{m.valid_from[:10]} to {'now' if m.valid_to is None else m.valid_to[:10]}"
    return f"{span}, later corrected" if m.status == "corrected" else span


def _hive(m: RecalledMemory) -> bool:
    return m.origin is not None and m.origin.level in ("constellation", "galaxy")


def _label(m: RecalledMemory, labelled: bool, now_ms: float) -> str:
    parts = [m.type]
    if labelled and m.origin is not None:
        parts.append(m.origin.space)
    parts.append(_when(m, now_ms))
    if m.origin is not None and m.origin.overridden_by is not None:
        parts.append("overridden by a narrower memory")
    return ", ".join(parts)


def _escape(part: str) -> str:
    part = part.replace("[", "\\[").replace("]", "\\]")
    return _BLOCK_TAG.sub("&lt;", part)


def injectable_text(text: str) -> str:
    """Memory text as it goes into the block: scrubbed, then escaped, the redaction markers kept
    readable."""
    pieces = _REDACTED.split(_scrub_text(text))
    return "".join(p if i % 2 == 1 else _escape(p) for i, p in enumerate(pieces))


def _render(memories: List[RecalledMemory], budget: int, now_ms: float) -> str:
    total = _js_len(_OPEN) + _js_len(_CLOSE)
    hive = 0
    lines: List[str] = []
    labelled = any(_hive(m) for m in memories)
    for m in memories:
        note = f" (may be outdated; last confirmed {_age(m.valid_from, now_ms)})" if m.stale else ""
        line = f"- [{_label(m, labelled, now_ms)}] {injectable_text(m.text)}{note}"
        cost = _js_len(line) + (1 if lines else 0)
        from_hive = _hive(m)
        if from_hive and hive + cost > HIVE_QUOTA * budget:
            continue
        if total + cost > budget:
            break
        lines.append(line)
        total += cost
        if from_hive:
            hive += cost
    return "" if not lines else _OPEN + "\n".join(lines) + _CLOSE


def format_for_prompt(
    result: Union[RecallResult, Mapping[str, Any]],
    *,
    budget_chars: Optional[int] = None,
    now: Optional[datetime] = None,
) -> str:
    """A recall's memories as the ``<oort-memory>`` block, whole lines only, within
    ``budget_chars`` (default: the recall's ``budget_chars``, else 6000). Inject memory into a
    prompt only through this: a stored memory cannot close the block or forge a label.

    ``result`` is a ``RecallResult`` or its wire form (a dict with camelCase keys). ``now`` dates
    the labels (default: the current time)."""
    r = result if isinstance(result, RecallResult) else from_wire(RecallResult, result)
    if budget_chars is not None and (
        not isinstance(budget_chars, int) or isinstance(budget_chars, bool) or budget_chars <= 0
    ):
        from .errors import OortUsageError

        raise OortUsageError(
            "format_for_prompt: invalid field budget_chars.", reason="invalid-argument"
        )
    budget = budget_chars or r.budget_chars or DEFAULT_BUDGET_CHARS
    at = datetime.now(timezone.utc) if now is None else now
    now_ms = float(math.floor(at.timestamp() * 1000 + 1e-6))
    return _render(list(r.memories), budget, now_ms)
