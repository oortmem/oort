"""The secret scrubber: a port of ``packages/core/src/scrub.ts``, rule for rule.

Memory text from Oort Cloud reaches Python as the cloud stored it, so a secret stored before a
rule existed (or one a cloud deploy lags behind) would otherwise reach a prompt. The TypeScript
SDK scrubs every text field on read; this does the same, with the same pattern families, the same
``[REDACTED:<kind>]`` markers and the same secret-ratio arithmetic. A shared corpus
(``packages/core/test/fixtures``) and the golden vectors in ``contract/sdk/vectors/scrub.json``
pin the two to identical output.

Porting notes (JavaScript regular expressions are not Python's):

* every pattern is compiled with ``re.ASCII`` (JavaScript's ``\\b``, ``\\d``, ``\\w`` and ``/i``
  are ASCII-only without the ``u`` flag), and ``_js`` rewrites ``\\s``, ``.`` and ``$`` to what
  JavaScript means by them (Python's ``\\s`` differs on U+001C..U+001F and U+FEFF, ``.`` matches
  ``\\r``, ``$`` matches before a final newline);
* Python lookbehinds are fixed-width, so the variable-width ones become a fixed lookbehind plus a
  ``pre`` check or a hand-written search (``_scheme_before``, ``_basic_find``, ``_not_after_marker``)
  that looks only at the text the lookbehind can reach (never a search from the start per
  candidate, which is quadratic), and the PEM rule pairs its markers by bisection (``_pem_find``);
* ``removed`` and the ratio count UTF-16 code units, as JavaScript's ``.length`` does.
"""

from __future__ import annotations

import math
import re
from bisect import bisect_left
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Pattern, Sequence, Tuple

__all__ = ["scrub", "clean", "clean_field", "scrub_many", "ScrubResult", "Redaction", "RULE_KINDS", "shannon_entropy"]

DROP_RATIO = 0.5
ENTROPY_MIN = 4.0
MARK = "[REDACTED:"

# JavaScript's \s, exactly.
_WS = r" \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def _js(src: str, dotall: bool = False) -> str:
    """Rewrite a JavaScript pattern's ``\\s``, ``\\S``, ``.`` and ``$`` for Python's ``re``."""
    out: List[str] = []
    i = 0
    in_cls = False
    n = len(src)
    while i < n:
        c = src[i]
        if c == "\\" and i + 1 < n:
            nx = src[i + 1]
            if nx == "s":
                out.append(_WS if in_cls else f"[{_WS}]")
            elif nx == "S":
                out.append(f"[^{_WS}]")
            else:
                out.append(c + nx)
            i += 2
            continue
        if in_cls:
            if c == "]":
                in_cls = False
            out.append(c)
        elif c == "[":
            in_cls = True
            out.append(c)
            if src[i + 1 : i + 2] == "^":
                out.append("^")
                i += 1
        elif c == "." and not dotall:
            out.append(r"[^\n\r\u2028\u2029]")
        elif c == "$":
            out.append(r"\Z")
        else:
            out.append(c)
        i += 1
    return "".join(out)


def _re(src: str, flags: str = "") -> Pattern[str]:
    f = re.ASCII
    if "i" in flags:
        f |= re.IGNORECASE
    return re.compile(_js(src, "s" in flags), f | (re.DOTALL if "s" in flags else 0))


def _u16(s: str) -> int:
    """The length JavaScript gives a string: UTF-16 code units."""
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def _tail16(text: str, at: int, n: int) -> str:
    """``text.slice(max(0, at - n), at)`` with ``n`` UTF-16 units (a split pair is left out)."""
    window = text[max(0, at - n) : at]
    if window.isascii():  # every unit is one code point: the common case, with no loop
        return window
    used = 0
    i = at
    while i > 0:
        w = 2 if ord(text[i - 1]) > 0xFFFF else 1
        if used + w > n:
            break
        used += w
        i -= 1
    return text[i:at]


@dataclass
class Redaction:
    kind: str
    count: int


@dataclass
class ScrubResult:
    text: str
    redactions: List[Redaction]
    #: Fraction of the original characters that were redacted (0 for empty input).
    secret_ratio: float


@dataclass
class _Rep:
    out: str
    removed: int
    #: Input characters replaced, from the match start (default: the match).
    length: Optional[int] = None


Hit = Callable[[str, int, str], Optional[_Rep]]
Pre = Callable[[str, int], bool]


def _tag(kind: str) -> str:
    return f"{MARK}{kind}]"


def _with_digit(kind: str, skip: int) -> Hit:
    def hit(m: str, offset: int, text: str) -> Optional[_Rep]:
        return _Rep(_tag(kind), _u16(m)) if re.search(r"[0-9]", m[skip:]) else None

    return hit


def _keep_name(kind: str, prefix: Pattern[str]) -> Hit:
    def hit(m: str, offset: int, text: str) -> Optional[_Rep]:
        p = prefix.match(m)
        cut = len(p.group(0)) if p else 0
        value = m[cut:]
        if MARK in value or cut == 0:
            return None
        return _Rep(f"{m[:cut]}{_tag(kind)}", _u16(value))

    return hit


_KEYWORD = _re(r"secret|token|passw(?:or)?d|api_?key|private_?key|access_?key", "i")

_SUFFIXES = [
    "count", "limit", "budget", "length", "size", "type", "name", "path", "per", "izer", "ize",
    "url", "uri", "endpoint", "arn", "ttl", "expiry", "region", "file",
]  # fmt: skip
_SNAKE_SUFFIX = _re(f"_(?:{'|'.join(_SUFFIXES)}|expires_(?:in|at))$", "i")
_CAMEL_SUFFIX = _re(
    "[a-z](?:" + "|".join(x[0].upper() + x[1:] for x in _SUFFIXES) + "|Expires(?:In|At))$"
)
_CONTINUATION = _re(
    r"^(?:KEY|VALUE|STRING|TEXT|RAW|PLAIN|ENCODED|Key|Value|String|Text|Raw|Plain|Encoded)"
)
_COUNTER_SNAKE = _re(r"^(?:max|min|num|count)_", "i")
_COUNTER_CAMEL = _re(r"^(?:max|min|num|count)[A-Z]")
_MANY_WORD = _re(r"^(?:secret|passw(?:or)?d)$", "i")
_MANY_REST = _re(r"^[sS]\d*$")
_REST_OK = _re(r"^\d*(?:_.*)?$")
_TOKEN_WORD = _re(r"^token$", "i")
_PLURAL_REST = _re(r"^[sS]$")


def _env_key(key: str) -> Optional[str]:
    """``'always'``, ``'unless-count'`` (a plural ``TOKENS``) or None, judged on word boundaries."""
    if _COUNTER_SNAKE.search(key) or _COUNTER_CAMEL.search(key):
        return None
    if _SNAKE_SUFFIX.search(key) or _CAMEL_SUFFIX.search(key):
        return None
    plural = False
    for k in _KEYWORD.finditer(key):
        i = k.start()
        word = k.group(0)
        prev = key[i - 1] if i > 0 else None
        start_ok = (
            prev is None
            or prev == "_"
            or word == word.upper()
            or (re.search(r"[a-z]", prev) is not None and re.search(r"[A-Z]", word[0]) is not None)
        )
        if not start_ok:
            continue
        rest = key[i + len(word) :]
        many = _MANY_WORD.search(word) is not None and _MANY_REST.search(rest) is not None
        if _REST_OK.search(rest) or _CONTINUATION.search(rest) or many:
            return "always"
        if _TOKEN_WORD.search(word) and _PLURAL_REST.search(rest):
            plural = True
    return "unless-count" if plural else None


_COUNT_VALUE = _re(
    r"^(?:[~<>\u2248][ \t]*)?(?:-?\d[\d_,.]*[kKmM]?|\d+(?:ms|s|m|h|d)(?:\d+(?:ms|s|m|h))*"
    r"|true|false|null|none|undefined|NaN|True|False|None)$"
)

_ESC_TAIL = r'(?:[nrtbf"\\/]|u[0-9A-Fa-f]{4})'
#: Just after an escape (JavaScript's variable lookbehind, as two fixed ones).
_AFTER_ESC = r'(?:(?<=\\[nrtbf"\\/])|(?<=\\u[0-9A-Fa-f]{4}))'
_ESC_ANY = _re(r"\\" + _ESC_TAIL)
_VALUE_START_ESC = r"\\(?:[nrtbf\"]|u00[01][0-9A-Fa-f])"

_ENV_VALUE = _re(
    r"\"(?:[^\"\\\n]|\\.)*\"|\"[^\"\n]*\"|'[^'\n]*'|\\\"[^\"\\\n]*\\\""
    r"|\[[ \t]*(?:\"[^\"\n]*\"|'[^'\n]*')(?:[ \t]*,[ \t]*(?:\"[^\"\n]*\"|'[^'\n]*'))*[ \t]*\]"
    r"|(?![\[{](?:[\s\"'\[\]{}\d]|$)|" + _VALUE_START_ESC + r")"
    r"(?:\\[\\\"]|[^\s\"',}\])]|[,}\])](?![\s\"',}\])]|$))+"
)
_ENV_HEAD_KEY = _re(r"^[\"']?(?:export[ \t]+)?([A-Za-z][A-Za-z0-9_]*)")
_QUOTED_ELEM = _re(r"\"[^\"\n]*\"|'[^'\n]*'")


def _env_secret(head: str, offset: int, text: str) -> Optional[_Rep]:
    hk = _ENV_HEAD_KEY.search(head)
    level = _env_key(hk.group(1)) if hk else None
    if level is None:
        return None
    vm = _ENV_VALUE.match(text, offset + len(head))
    raw = vm.group(0) if vm else None
    if raw is None or MARK in raw:
        return None
    length = len(head) + len(raw)
    # An array is `[` then a quote (the bare alternative never starts `[ ` or `['`); a bare value
    # that merely starts with a bracket (`token=[abc]`) is redacted whole, below.
    if re.search(r"^\[[ \t]*[\"']", raw):
        if level == "unless-count":
            return None
        removed = 0

        def sub(mm: "re.Match[str]") -> str:
            nonlocal removed
            q = mm.group(0)
            if _u16(q) <= 2:
                return q
            removed += _u16(q) - 2
            return f"{q[0]}{_tag('env-secret')}{q[0]}"

        out = _QUOTED_ELEM.sub(sub, raw)
        return None if removed == 0 else _Rep(f"{head}{out}", removed, length)
    value = raw
    quote = ""
    for q in ('\\"', '"', "'"):
        if len(value) >= 2 * len(q) and value.startswith(q) and value.endswith(q):
            quote = q
            value = value[len(q) : -len(q)]
            break
    if value == "":
        return None
    count = _ESC_ANY.split(value)[0]
    if level == "unless-count" and (
        _COUNT_VALUE.search(count) or (quote != "" and re.search(_js(r"\s"), value))
    ):
        return None
    return _Rep(f"{head}{quote}{_tag('env-secret')}{quote}", _u16(value), length)


def shannon_entropy(s: str) -> float:
    """Shannon entropy in bits per character."""
    if len(s) == 0:
        return 0.0
    counts: Dict[str, int] = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = _u16(s)
    h = 0.0
    for c in counts.values():
        p = c / n
        h -= p * math.log2(p)
    return h


_HEX = _re(r"^[0-9a-f]+$", "i")
_UUID = _re(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i")
_KEYISH = _re(r"(secret|token|key|password)", "i")
TOKEN_MIN = 32
_INTEGRITY = _re(
    r"^(?:sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{86}==)$", "i"
)
_SHA_HEX_LEN = {"sha256": 64, "sha384": 96, "sha512": 128}
_WORDLIKE = _re(r"^(?:[a-z]+|[A-Z][a-z]+|[A-Z]+)\d{0,4}$")
_CHUNK = _re(r"^[A-Za-z0-9+=]{0,8}$")
_GLUE = _re(r"^[A-Za-z0-9+=]{0,16}$")
_PATH_WORD = _re(r"^(?:[a-z]{3,}|[A-Z][a-z]{3,})\d{0,4}$")
_REAL_WORD = _re(r"[a-z]{3}|[-_~]")
_SHA_BEFORE = _re(r"(sha(?:256|384|512)):$", "i")

_CLASS_RES = [_re(r"[A-Z]"), _re(r"[a-z]"), _re(r"[0-9]"), _re(r"[+/=]")]


def _classes(s: str) -> int:
    return sum(1 for r in _CLASS_RES if r.search(s))


def _word_share(s: str) -> float:
    letters = len(re.sub(r"[^A-Za-z]", "", s))
    in_words = sum(len(w.group(0)) for w in re.finditer(r"[A-Z]?[a-z]{3,}", s))
    return 0.0 if letters == 0 else in_words / letters


def _key_like(s: str) -> bool:
    if _classes(s) < 3 or shannon_entropy(s) < ENTROPY_MIN:
        return False
    letters = len(re.sub(r"[^A-Za-z]", "", s))
    digits = len(re.sub(r"[^0-9]", "", s))
    heavy = digits < 3 and letters / len(s) > 0.85
    return _word_share(s) < (0.5 if heavy else 0.75)


def _is_random(s: str) -> bool:
    return len(s) >= TOKEN_MIN and _key_like(s)


def _run_is_key(parts: Sequence[str]) -> bool:
    return len("/".join(parts)) >= TOKEN_MIN and _key_like("".join(parts))


_DIGITS = _re(r"^\d+$")
_SMALL_NUM = _re(r"^\d{1,8}$")
_WORD_A = _re(r"^[A-Za-z][a-z]{2,}\d{0,4}$")
_WORD_B = _re(r"^[A-Z]{1,8}\d{0,4}$")
_WORD_PART = _re(r"^[A-Z]?[a-z]{2,}$")


def _is_word(p: str) -> bool:
    w = re.sub(r"^~+", "", p)
    if w == "" or _DIGITS.search(w):
        return True
    if len(w) <= 11:
        parts = [x for x in re.split(r"[_-]+", w) if x != ""]
        if all(_WORDLIKE.search(x) or _SMALL_NUM.search(x) for x in parts):
            return True
    if _WORD_A.search(w) or _WORD_B.search(w):
        return True
    t = re.sub(r"\d{0,4}$", "", w, count=1)
    t = re.sub(r"([a-z])([A-Z])", r"\1 \2", t)
    parts = [x for x in re.split(r"[ _-]+", t) if x != ""]
    return len(parts) >= 2 and all(_WORD_PART.search(x) for x in parts)


def _classify(p: str, before: str) -> str:
    if _UUID.search(p) or _INTEGRITY.search(p):
        return "word"
    if _HEX.search(p):
        if len(p) == 40:
            return "word"
        sm = _SHA_BEFORE.search(before)
        sha = sm.group(1).lower() if sm else None
        if sha is not None and _SHA_HEX_LEN.get(sha) == len(p):
            return "word"
        if len(p) == 64:
            return "random" if _KEYISH.search(before[-40:]) else "word"
    if _is_word(p):
        return "word"
    if _is_random(p):
        return "random"
    return "word" if re.search(r"[-_~]", p) else "neutral"


def _escape_at(full: str, offset: int, text: str) -> Optional[str]:
    n = 0
    while offset - 1 - n >= 0 and text[offset - 1 - n] == "\\":
        n += 1
    if n % 2 == 0:
        return None
    m = _re(r"^(?:[nrtbf/]|u[0-9A-Fa-f]{4})").search(full)
    return m.group(0) if m else None


_parity: Optional[Tuple[str, bytearray]] = None


def _quote_parity(text: str) -> bytearray:
    odd = bytearray(len(text) + 1)
    inside = 0
    slashes = 0
    for i, ch in enumerate(text):
        odd[i] = inside
        if ch == "\n":
            inside = 0
            slashes = 0
        elif ch == "\\":
            slashes += 1
        else:
            if ch == '"' and slashes % 2 == 0:
                inside ^= 1
            slashes = 0
    odd[len(text)] = inside
    return odd


def _in_json_string(text: str, at: int) -> bool:
    global _parity
    if at < 0:
        return False
    if _parity is None or _parity[0] != text:
        _parity = (text, _quote_parity(text))
    return _parity[1][at] == 1


_NAME = _re(r"^[A-Za-z_][A-Za-z0-9_]*=(?=[^=])")


def _high_entropy(full: str, offset: int, text: str) -> Optional[_Rep]:
    esc = _escape_at(full, offset, text)
    if esc is None:
        return _read_token(full, offset, text)

    def as_json() -> Optional[_Rep]:
        rest = _read_token(full[len(esc) :], offset + len(esc), text)
        return None if rest is None else _Rep(esc + rest.out, rest.removed)

    if _in_json_string(text, offset - 1):
        return as_json() or _read_token(full, offset, text)
    return _read_token(full, offset, text) or as_json()


def _read_token(full: str, offset: int, text: str) -> Optional[_Rep]:
    m = full.rstrip(".")  # the trailing dots, in one pass (a ``\\.*$`` search is quadratic)
    trail = full[len(m) :]
    nm = _NAME.search(m)
    name = nm.group(0) if nm else ""
    r = _judge_token(m[len(name) :], offset + len(name), text)
    return None if r is None else _Rep(name + r.out + trail, r.removed)


def _judge_token(m: str, offset: int, text: str) -> Optional[_Rep]:
    if len(m) < TOKEN_MIN or _INTEGRITY.search(m):
        return None
    bits = re.split(r"([/.])", m)
    parts = [b for i, b in enumerate(bits) if i % 2 == 0]
    seps = [b for i, b in enumerate(bits) if i % 2 == 1]

    def slash(i: int) -> bool:
        return i < len(seps) and seps[i] == "/"

    n = len(parts)
    kinds: List[str] = []
    at = offset
    for i, p in enumerate(parts):
        kinds.append(_classify(p, _tail16(text, at, 40)))
        at += len(p) + (len(seps[i]) if i < len(seps) else 0)

    def chunk(i: int) -> bool:
        p = parts[i]
        return kinds[i] == "word" and bool(_CHUNK.search(p)) and not _PATH_WORD.search(p) and not _DIGITS.search(p)

    def loose(i: int) -> bool:
        return 0 <= i < n and kinds[i] != "word"

    glued = list(kinds)
    i = 0
    while i < n:
        if not loose(i):
            i += 1
            continue
        j = i + 1
        while j < n and slash(j - 1) and kinds[j] == "word" and _GLUE.search(parts[j]):
            j += 1
        if j > i + 1 and j < n and slash(j - 1) and loose(j):
            for k in range(i + 1, j):
                glued[k] = "neutral"
        i = j
    words = sum(1 for i, p in enumerate(parts) if glued[i] == "word" and re.search(r"[a-z]{3}", p))
    if words < (1 if re.search(r"^[.~]/", m) else 2):
        material = [p for i, p in enumerate(parts) if glued[i] != "word" or not _REAL_WORD.search(p)]
        hit = "random" in glued or _run_is_key(material)
        return _Rep(_tag("high-entropy"), _u16(m)) if hit else None
    mark = [False] * n

    def in_key(i: int) -> bool:
        return glued[i] != "word" or chunk(i)

    i = 0
    while i < n:
        if not in_key(i):
            i += 1
            continue
        j = i + 1
        while j < n and slash(j - 1) and in_key(j):
            j += 1
        run = parts[i:j]
        neutral = len("".join(p for k, p in enumerate(run) if glued[i + k] == "neutral"))
        random = "random" in glued[i:j]
        if random or (neutral >= 16 and _run_is_key(run)):
            for k in range(i, j):
                mark[k] = True
        i = j

    def short(j: int) -> bool:
        return bool(_GLUE.search(parts[j]))

    def dotted(j: int) -> bool:
        return j > 0 and j - 1 < len(seps) and seps[j - 1] == "."

    keys = list(mark)
    for i in range(n):
        if not keys[i]:
            continue
        j = i - 1
        while j >= 0 and not keys[j] and slash(j) and short(j) and not dotted(j):
            if parts[j] == "":
                break
            mark[j] = True
            j -= 1
        j = i + 1
        while j < n and not keys[j] and slash(j - 1) and short(j):
            mark[j] = True
            if parts[j] == "":
                break
            j += 1
    if not any(mark):
        return None
    out: List[str] = []
    removed = 0
    for i in range(n):
        piece = parts[i]
        sep = seps[i - 1] if i > 0 else ""
        if not mark[i]:
            out.append(sep + piece)
        elif i > 0 and mark[i - 1]:
            removed += _u16(sep) + _u16(piece)
        else:
            out.append(sep + _tag("high-entropy"))
            removed += _u16(piece)
    return _Rep("".join(out), removed)


# --- the rules ------------------------------------------------------------------------------

_LEAD = re.compile(r"^(?:\\b|\(\?<![^()]*\))")


def _escape_bounded(src: str, own: bool) -> str:
    """An escape-aware left boundary: the rule's own, or just after a JSON escape."""
    if own:
        return src
    lead = _LEAD.match(src)
    if lead is None:
        if src.startswith("(?<"):
            raise ValueError(f"scrub: cannot bound rule: {src}")
        return src
    return f"(?:{lead.group(0)}|{_AFTER_ESC}){src[lead.end():]}"


# The three variable-width lookbehinds JavaScript allows and Python's ``re`` does not. Each is
# emulated in time proportional to the text it actually examines: none of them searches from the
# start of the text per candidate (that is quadratic: ``":" * 200_000`` took minutes).
_SCHEME_RUN = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+.-")
_WORD_CH = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")
_NAME_CH = frozenset("abcdefghijklmnopqrstuvwxyz-")


def _scheme_before(text: str, p: int) -> bool:
    """``(?<=\\b[a-z][a-z0-9+.-]*://)`` (``/i``) at ``p``. Walks back over the one run of scheme
    characters before the ``://`` (``:`` and ``/`` end it, so the runs of different candidates
    never overlap), then looks in that run for a letter that starts a word."""
    q = p - 3
    if q < 0 or text[q:p] != "://":
        return False
    i = q
    while i > 0 and text[i - 1] in _SCHEME_RUN:
        i -= 1
    for s in range(i, q):
        c = text[s]
        if c.isascii() and c.isalpha() and (s == 0 or text[s - 1] not in _WORD_CH):
            return True
    return False


# ``(?<=(?:^|\s|\\[nrt])(?:-u[ \t]+|--user[ \t=]+)(?:[^\s:\\]|\\.)+:)``: the user part holds no
# unescaped whitespace or ``:``, so each flag has at most one end, and the ends of the whole text
# come from one linear forward pass (cached per text) instead of a backward search per candidate.
_BASIC_ENDS = _re(r"(?=((?:^|\s|\\[nrt])(?:-u[ \t]+|--user[ \t=]+)(?:[^\s:\\]|\\.)+:))")
_basic_cache: Optional[Tuple[str, List[int]]] = None
_NON_WS = _re(r"\S+")


def _basic_find(text: str, pos: int) -> Optional[Tuple[int, int]]:
    """The rule's ``(?<=...)\\S+`` search, driven by the lookbehind's ends rather than by ``\\S+``
    (a bare ``(?<=:)\\S+`` match attempt at each ``:`` runs to the end of the word: quadratic)."""
    global _basic_cache
    if _basic_cache is None or _basic_cache[0] is not text:
        _basic_cache = (text, [m.end(1) for m in _BASIC_ENDS.finditer(text)])
    ends = _basic_cache[1]
    for i in range(bisect_left(ends, pos), len(ends)):
        m = _NON_WS.match(text, ends[i])
        if m is not None:
            return m.start(), m.end()
    return None


def _not_after_marker(text: str, p: int) -> bool:
    """The ``(?<!\\[REDACTED:[a-z-]+\\])`` half of high-entropy's left boundary: walks back over
    the ``[a-z-]`` run once (``]`` ends it, so runs of different candidates never overlap)."""
    if p == 0 or text[p - 1] != "]":
        return True
    j = p - 1
    while j > 0 and text[j - 1] in _NAME_CH:
        j -= 1
    return not (j < p - 1 and text.endswith("[REDACTED:", 0, j))


# PEM: ``-----BEGIN ... PRIVATE KEY-----`` up to the first ``-----END ... PRIVATE KEY-----``. As one
# regex with a lazy ``.*?`` every BEGIN with no END after it rescans the rest of the text
# (quadratic), so the two markers are found separately, once per text, and paired by bisection.
# Each marker has exactly one possible end (``-`` is not in ``[A-Z ]``), and a BEGIN whose end is
# past every END means no later BEGIN can match either.
_PEM_BEGIN = _re(r"(?=(-----BEGIN [A-Z ]*PRIVATE KEY-----))")
_PEM_END = _re(r"(?=(-----END [A-Z ]*PRIVATE KEY-----))")
_pem_cache: Optional[Tuple[str, List[int], List[int]]] = None


def _pem_find(text: str, pos: int) -> Optional[Tuple[int, int]]:
    global _pem_cache
    if _pem_cache is None or _pem_cache[0] is not text:
        ends = list(_PEM_END.finditer(text))
        _pem_cache = (text, [m.start(1) for m in ends], [m.end(1) for m in ends])
    _, starts, stops = _pem_cache
    for b in _PEM_BEGIN.finditer(text, pos):
        i = bisect_left(starts, b.end(1))
        if i == len(starts):
            return None
        return b.start(1), stops[i]
    return None


@dataclass
class _Rule:
    kind: str
    re: Pattern[str]
    hit: Optional[Hit] = None
    retry: bool = False
    pre: Optional[Pre] = None
    #: A hand-written search in place of ``re`` (start, end), for a rule whose regex is quadratic.
    find: Optional[Callable[[str, int], Optional[Tuple[int, int]]]] = None


def _rule(
    kind: str,
    src: str,
    flags: str = "",
    *,
    hit: Optional[Hit] = None,
    own: bool = False,
    retry: bool = False,
    pre: Optional[Pre] = None,
    find: Optional[Callable[[str, int], Optional[Tuple[int, int]]]] = None,
) -> _Rule:
    return _Rule(kind, _re(_escape_bounded(src, own), flags), hit, retry, pre, find)


_NB = r"(?<![A-Za-z0-9_-])"
_BASIC_BODY = r"(?<=:)\S+"


def _hit_aws_secret(m: str, offset: int, text: str) -> Optional[_Rep]:
    at = _re(r"[A-Za-z0-9/+=]{40}$").search(m)
    assert at is not None
    return _Rep(f"{m[: at.start()]}{_tag('aws-secret-key')}", _u16(m) - _u16(m[: at.start()]))


def _hit_twilio_sid(m: str, offset: int, text: str) -> Optional[_Rep]:
    if re.search(r"sid|account", _tail16(text, offset, 20), re.IGNORECASE):
        return _Rep(_tag("twilio-sid"), _u16(m))
    return None


def _hit_url_credentials(m: str, offset: int, text: str) -> Optional[_Rep]:
    return None if MARK in m else _Rep(_tag("url-credentials"), _u16(m))


def _hit_basic_auth(m: str, offset: int, text: str) -> Optional[_Rep]:
    if _DIGITS.search(m) or MARK in m:
        return None
    return _Rep(_tag("basic-auth-arg"), _u16(m))


_RULES: List[_Rule] = [
    _rule(
        "pem-private-key",
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
        "s",
        find=_pem_find,
    ),
    _rule("aws-access-key", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    _rule(
        "aws-secret-key",
        r"aws_secret_access_key[ \t]*[=:][ \t]*[\"']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])",
        "i",
        hit=_hit_aws_secret,
    ),
    _rule("github-token", _NB + r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b"),
    _rule("github-token", _NB + r"github_pat_[A-Za-z0-9_]{22,}\b"),
    _rule("anthropic-key", _NB + r"sk-ant-[A-Za-z0-9_-]{20,}"),
    _rule("oort-key", _NB + r"oort_sk_[A-Za-z0-9_-]{16,}"),
    _rule("stripe-key", _NB + r"(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b"),
    _rule("typesafe-key", _NB + r"ts_(?:live|test)_[A-Za-z0-9]{16,}\b"),
    _rule("shopify-key", _NB + r"(?:shpat|shpss|shppa)_[0-9a-f]{32}\b"),
    _rule("digitalocean-token", _NB + r"(?:dop|doo|dor)_v1_[0-9a-f]{64}\b"),
    _rule("mailgun-key", _NB + r"key-[0-9a-f]{32}\b"),
    _rule("gitlab-token", _NB + r"glpat-[A-Za-z0-9_-]{20,}\b"),
    _rule("square-token", _NB + r"sq0(?:atp|csp)-[A-Za-z0-9_-]{22,}\b"),
    _rule("slack-token", _NB + r"xox[abprs]-[A-Za-z0-9-]{10,}\b"),
    _rule("npm-token", _NB + r"npm_[A-Za-z0-9]{36}\b"),
    _rule("huggingface-token", _NB + r"hf_[A-Za-z0-9]{34,}\b"),
    _rule("twilio-sid", _NB + r"AC[0-9a-f]{32}\b", hit=_hit_twilio_sid),
    _rule("twilio-key", _NB + r"SK[0-9a-f]{32}\b"),
    _rule(
        "slack-webhook",
        r"(?<=https://hooks\.slack\.com/services/)T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+",
        own=True,
    ),
    _rule("openai-key", _NB + r"sk-(?:proj-)?[A-Za-z0-9_-]{20,}", hit=_with_digit("openai-key", 3)),
    _rule("voyage-key", _NB + r"pa-[A-Za-z0-9_-]{20,}", hit=_with_digit("voyage-key", 3)),
    _rule("jwt", r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    # JavaScript's lookbehind `(?<=\b[a-z][a-z0-9+.-]*://)` is variable-width: a fixed `(?<=://)`
    # here, and the scheme checked by `_scheme_before`.
    _rule(
        "url-credentials",
        r"(?<=://)[^/\s:@]*:[^\s/]+(?=@[^@\s/]*(?:[/\s]|$))",
        "i",
        hit=_hit_url_credentials,
        own=True,
        pre=_scheme_before,
    ),
    _rule(
        "url-credentials",
        r"(?<=://)[A-Za-z0-9_-]{20,}(?=@[^@\s/]*(?:[/\s]|$))",
        "i",
        own=True,
        pre=_scheme_before,
    ),
    _rule("basic-auth-arg", _BASIC_BODY, hit=_hit_basic_auth, own=True, find=_basic_find),
    _rule(
        "auth-header",
        r"[\"']?(?:\b|" + _AFTER_ESC + r")(?:authorization|x-api-key|api-key|x-auth-token)[\"']?[ \t]*[:=][ \t]*[\"']?"
        r"(?:(?:bearer|basic|token|digest)[ \t]+[\"']{0,2})?[^\s\"']+",
        "i",
        hit=_keep_name(
            "auth-header",
            _re(r"^[^=:]*[=:][ \t]*[\"']?(?:(?:bearer|basic|token|digest)[ \t]+[\"']{0,2})?", "i"),
        ),
        own=True,
    ),
    _rule(
        "env-secret",
        r"(?<![A-Za-z0-9_])[\"']?(?:export[ \t]+)?"
        r"(?=[A-Za-z0-9_]{0,95}?(?:secret|token|passw(?:or)?d|api_?key|private_?key|access_?key))"
        r"[A-Za-z][A-Za-z0-9_]{0,95}\\?[\"']?[ \t]*[=:][ \t]*",
        "i",
        hit=_env_secret,
        retry=True,
    ),
    _rule(
        "high-entropy",
        r"(?<![A-Za-z0-9+/=_.~-])[A-Za-z0-9+/=_.~-]{32,}(?![A-Za-z0-9+/=_.~-]|\[REDACTED:)",
        hit=_high_entropy,
        pre=_not_after_marker,
    ),
]

#: The kind of every rule, in order (one entry per rule).
RULE_KINDS: Tuple[str, ...] = tuple(r.kind for r in _RULES)


def _run(text0: str) -> Tuple[str, List[Redaction], int]:
    global _parity
    text = text0
    removed = 0
    counts: Dict[str, int] = {}
    for rule in _RULES:
        out: List[str] = []
        frm = 0
        pos = 0
        while pos <= len(text):
            if rule.find is not None:
                span = rule.find(text, pos)
                if span is None:
                    break
                start, end = span
                matched = text[start:end]
            else:
                m = rule.re.search(text, pos)
                if m is None:
                    break
                start, end, matched = m.start(), m.end(), m.group(0)
            if rule.pre is not None and not rule.pre(text, start):
                pos = start + 1
                continue
            r = (
                _Rep(_tag(rule.kind), _u16(matched))
                if rule.hit is None
                else rule.hit(matched, start, text)
            )
            if r is None:
                pos = start + 1 if rule.retry else max(end, start + 1)
                continue
            out.append(text[frm:start])
            out.append(r.out)
            frm = start + (r.length if r.length is not None else len(matched))
            pos = max(frm, start + 1)
            counts[rule.kind] = counts.get(rule.kind, 0) + 1
            removed += r.removed
        text = "".join(out) + text[frm:]
    _parity = None
    return text, [Redaction(k, c) for k, c in counts.items()], removed


def scrub(text: str) -> ScrubResult:
    """Redact credentials from text. Pure, deterministic and idempotent."""
    out, redactions, removed = _run(text)
    n = _u16(text)
    return ScrubResult(out, redactions, 0.0 if n == 0 else removed / n)


def clean(text: str) -> str:
    """``scrub(text).text``: what every text field passes through on its way out."""
    return _run(text)[0]


def clean_field(value: Any) -> Any:
    """``clean`` for a field that may be absent or not text: only a string is scrubbed."""
    return clean(value) if isinstance(value, str) else value


def scrub_many(texts: Sequence[str]) -> Tuple[List[str], bool]:
    """Scrub several texts as one observation: the cleaned texts, and whether more than half of
    all their characters were secret (the TypeScript engine drops such an observation)."""
    removed = 0
    total = 0
    cleaned: List[str] = []
    for s in texts:
        out, _, r = _run(s)
        removed += r
        total += _u16(s)
        cleaned.append(out)
    return cleaned, total > 0 and removed / total > DROP_RATIO
