"""Argument checks and wire conversion.

Local mode sends arguments to ``oort serve``, whose TypeScript SDK checks them (one set of rules,
one set of messages). Cloud mode has no TypeScript in the path, so these are the SDK's strict
schemas (``validate.ts``) and temporal rules (``context.ts`` ``viewOf``), ported: an invalid
argument is an ``OortUsageError`` (``invalid-argument``) before any request, naming the field,
never its value.
"""

from __future__ import annotations

import dataclasses
import re
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .errors import OortUsageError
from .types import Turn, camel

LIMITS = {
    "query_bytes": 2048,
    "recall_limit": 50,
    "turn_bytes": 128 * 1024,
    "turn_ref": 128,
    "remember_facts": 5,
    "fact_chars": 500,
    "recent_limit": 100,
    "id_min_prefix": 8,
    "id_max": 128,
}

#: A name (agent, user, org, project): one word, no spaces or control characters.
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$")
AGENT_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
#: An end user's id (CON-132; the same rule in TypeScript and Oort Cloud): 1 to 128 characters,
#: a letter or digit first, then letters, digits and ``_ . : @ -``. Never trimmed or normalized.
USER_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}")
#: Ids that would read as someone other than an end user, compared without case.
RESERVED_USER_IDS = ("self", "anonymous", "default", "local", "root", "count")
_USER_MISSING = (
    "user-missing",
    "user was given but is empty: a missing end-user id never falls back to the operator. Leave the user key out to act as the person.",
)
_SELF = ("self-not-derivable", 'user cannot be "self": a handle for an end user never reaches the person\u2019s own memories.')
_BAD_USER = (
    "bad-user",
    "user is not a valid end-user id: 1 to 128 letters, digits and _ . : @ -, starting with a letter or digit, and not self, anonymous, default, local, root or count.",
)


def user_id_problem(user: Any) -> Optional[Tuple[str, str]]:
    """Why ``user`` is not an end-user id (``reason``, ``message``), or ``None`` when it is one."""
    # Blank (empty or only whitespace) reads as a dropped id, never as a name.
    if user is None or (isinstance(user, str) and user.strip() == ""):
        return _USER_MISSING
    if not isinstance(user, str) or not USER_ID.fullmatch(user):
        return _BAD_USER
    low = user.lower()
    if low == "self":
        return _SELF
    if low in RESERVED_USER_IDS:
        return _BAD_USER
    return None


def check_user_id(user: Any) -> None:
    """Refuses anything but an end-user id, before any I/O."""
    p = user_id_problem(user)
    if p is not None:
        raise OortUsageError(p[1], reason=p[0])
_ID = re.compile(r"^[A-Za-z0-9_:.-]+$")
LEVELS = ("self", "planet", "star", "constellation", "galaxy")


def bad(what: str, fields: Sequence[str], unknown: bool = False) -> OortUsageError:
    clean = [re.sub(r"[^A-Za-z0-9_.-]", "_", f)[:64] for f in fields]
    noun = "field" if len(clean) == 1 else "fields"
    kind = "unknown or invalid" if unknown else "invalid"
    return OortUsageError(f"{what}: {kind} {noun} {', '.join(clean)}.", reason="invalid-argument")


def js_len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def utf8(s: str) -> int:
    return len(s.encode("utf-8", "surrogatepass"))


def is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def iso(v: Any) -> str:
    """A date as the SDK sends it: ``new Date(v).toISOString()`` (UTC, milliseconds, ``Z``)."""
    if isinstance(v, datetime):
        d = v if v.tzinfo is not None else v.astimezone()
        d = d.astimezone(timezone.utc)
        return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"
    if isinstance(v, date):
        return f"{v.isoformat()}T00:00:00.000Z"
    from ._format import _ms

    ms = _ms(v)
    d = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(ms) % 1000:03d}Z"


def is_date(v: Any) -> bool:
    if isinstance(v, (datetime, date)):
        return True
    if not isinstance(v, str):
        return False
    from ._format import _ms
    import math

    return not math.isnan(_ms(v))


def wire_date(v: Any) -> Any:
    """A ``datetime`` or ``date`` as an ISO string; a string as given (the daemon checks it)."""
    return iso(v) if isinstance(v, (datetime, date)) else v


def turn_wire(turn: Any) -> Dict[str, Any]:
    """A ``Turn`` or a mapping (snake_case or camelCase keys) as the wire's turn object.
    Every key is kept, so an unknown one (``place``) is refused, never dropped."""
    if isinstance(turn, Turn):
        raw = {f.name: getattr(turn, f.name) for f in dataclasses.fields(turn) if getattr(turn, f.name) is not None}
    elif isinstance(turn, Mapping):
        raw = dict(turn)
    else:
        raise OortUsageError("turn: invalid field turn.", reason="invalid-argument")
    out: Dict[str, Any] = {}
    for k, v in raw.items():
        if not isinstance(k, str):
            raise bad("turn", ["turn"])
        key = camel(k) if "_" in k else k
        out[key] = wire_date(v) if key == "at" else v
    return out


# ---------------------------------------------------------------------------------------------
# Cloud-mode checks (the SDK's zod schemas).


def check_query(q: Any) -> str:
    if not isinstance(q, str) or q.strip() == "" or utf8(q) > LIMITS["query_bytes"]:
        raise bad("query", ["query"])
    return q


def check_recall(o: Mapping[str, Any]) -> None:
    bad_fields: List[str] = []
    limit = o.get("limit")
    if limit is not None and not (is_int(limit) and 1 <= limit <= LIMITS["recall_limit"]):
        bad_fields.append("limit")
    mode = o.get("mode")
    if mode is not None and mode not in ("current", "as-of", "history", "known-at"):
        bad_fields.append("mode")
    for k in ("asOf", "knownAt"):
        if o.get(k) is not None and not is_date(o[k]):
            bad_fields.append(k)
    inc = o.get("include")
    if inc is not None and not (isinstance(inc, (list, tuple)) and len(inc) >= 1 and all(x in LEVELS for x in inc)):
        bad_fields.append("include")
    b = o.get("budgetChars")
    if b is not None and not (is_int(b) and b > 0):
        bad_fields.append("budgetChars")
    for k in ("includeWithdrawn", "inferTime"):
        if o.get(k) is not None and not isinstance(o[k], bool):
            bad_fields.append(k)
    sp = o.get("speed")
    if sp is not None and sp not in ("full", "fast", "lexical"):
        bad_fields.append("speed")
    if bad_fields:
        raise bad("recall options", bad_fields)


def view_of(o: Mapping[str, Any]) -> Dict[str, str]:
    """The temporal view, exactly as the MCP server's ``viewOf``."""
    mode, as_of, known_at = o.get("mode"), o.get("asOf"), o.get("knownAt")
    if as_of is not None and known_at is not None:
        raise OortUsageError("Use asOf or knownAt, not both.", reason="invalid-argument")
    if mode is None:
        if as_of is not None:
            return {"mode": "as-of", "asOf": iso(as_of)}
        if known_at is not None:
            return {"mode": "known-at", "knownAt": iso(known_at)}
        return {"mode": "current"} if o.get("inferTime") is False else {}
    if mode == "as-of":
        if as_of is None:
            raise OortUsageError('mode "as-of" needs asOf.', reason="invalid-argument")
        return {"mode": mode, "asOf": iso(as_of)}
    if mode == "known-at":
        if known_at is None:
            raise OortUsageError('mode "known-at" needs knownAt.', reason="invalid-argument")
        return {"mode": mode, "knownAt": iso(known_at)}
    if as_of is not None or known_at is not None:
        raise OortUsageError(f'mode "{mode}" takes no asOf or knownAt.', reason="invalid-argument")
    return {"mode": mode}


_TURN_KEYS = ("user", "assistant", "tools", "at", "sessionId", "turnRef")


def check_turn(t: Mapping[str, Any]) -> None:
    unknown = [k for k in t if k not in _TURN_KEYS]
    if unknown:
        raise bad("turn", unknown, unknown=True)
    fields: List[str] = []
    for k in ("user", "assistant"):
        if not isinstance(t.get(k), str):
            fields.append(k)
    tools = t.get("tools")
    if tools is not None and not (isinstance(tools, list) and all(isinstance(x, str) for x in tools)):
        fields.append("tools")
    if t.get("at") is not None and not is_date(t["at"]):
        fields.append("at")
    sid = t.get("sessionId")
    if sid is not None and not (isinstance(sid, str) and 1 <= js_len(sid) <= 256):
        fields.append("sessionId")
    ref = t.get("turnRef")
    if ref is not None and not (isinstance(ref, str) and 1 <= js_len(ref) <= LIMITS["turn_ref"]):
        fields.append("turnRef")
    if fields:
        raise bad("turn", fields)
    size = utf8(t["user"]) + utf8(t["assistant"]) + sum(utf8(x) for x in (tools or []))
    if size > LIMITS["turn_bytes"]:
        raise bad("turn", ["user"])


def check_facts(facts: Any) -> List[str]:
    lst = [facts] if isinstance(facts, str) else facts
    if not isinstance(lst, (list, tuple)):
        raise bad("facts", ["facts"])
    bad_at = [
        str(i)
        for i, f in enumerate(lst)
        if not (isinstance(f, str) and f.strip() != "" and js_len(f) <= LIMITS["fact_chars"])
    ]
    if bad_at:
        raise bad("facts", bad_at)
    if not 1 <= len(lst) <= LIMITS["remember_facts"]:
        raise bad("facts", ["facts"])
    return list(lst)


def check_type(t: Any) -> None:
    if t is not None and t not in ("semantic", "episodic", "procedural", "preference"):
        raise bad("remember options", ["type"])


def check_id(i: Any) -> str:
    if not (isinstance(i, str) and LIMITS["id_min_prefix"] <= js_len(i) <= LIMITS["id_max"] and _ID.fullmatch(i)):
        raise bad("id", ["id"])
    return i


def check_recent(since: Any, limit: Any) -> None:
    fields = []
    if since is not None and not is_date(since):
        fields.append("since")
    if limit is not None and not (is_int(limit) and 1 <= limit <= LIMITS["recent_limit"]):
        fields.append("limit")
    if fields:
        raise bad("recent options", fields)


def check_name(what: str, v: Optional[str]) -> None:
    if v is not None and not (isinstance(v, str) and NAME.fullmatch(v)):
        raise OortUsageError(f"{what} is not a valid id.", reason="invalid-argument")


def check_agent(v: Optional[str], from_env: bool = False) -> None:
    if v is not None and not (isinstance(v, str) and AGENT_ID.fullmatch(v) and v != "anonymous"):
        label = "OORT_AGENT" if from_env else "agent"
        raise OortUsageError(
            f'{label} is not an agent id: lowercase letters, digits, ".", "_" or "-", starting with a letter or digit (not "anonymous").',
            reason="invalid-argument",
        )


def check_user(user: Any, org: Optional[str], given: bool, org_required: bool = True) -> None:
    """The SDK's end-user rules (section 6.4): a named ``user`` is never empty, never ``self``,
    and needs an explicit ``org`` other than ``local``."""
    if org is not None:
        check_name("org", org)
    if not given:
        return
    check_user_id(user)
    # Remote mode: the service token decides the org (never `local`), so none is named here.
    if org_required and (org is None or org == "local"):
        raise OortUsageError(
            'user needs an explicit org (your tenant), other than "local".', reason="principal-required"
        )
