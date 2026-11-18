"""Places and spatial filters: a port of core's ``place.ts``, rule for rule.

Cloud mode has no TypeScript in the path, so a place, a ``within`` path and a ``near`` query are
checked here with core's rules before anything is sent, and the places, place paths and distances
Oort Cloud sends back are checked with the same rules. A refusal is a ``PlaceError`` naming the
field (``place.pose.x``), never its value.

Letters, marks and digits are read from Python's own Unicode database (``unicodedata``). A
character newer than it is refused, never let through. The invisible characters
(Default_Ignorable_Code_Point) and the letters of joining scripts are tables taken from core's
regular expressions, since ``unicodedata`` has neither property.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from decimal import Decimal
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from ._scrub import clean

__all__ = [
    "PlaceError",
    "check_place",
    "check_near",
    "check_place_path",
    "check_spatial_filter",
    "matches_spatial",
    "place_distance",
    "place_identity",
    "remember_turn_ref",
    "scrubbed_fact",
]

#: The default frame.
DEFAULT_FRAME = "map"
#: The largest coordinate, extent or radius: 10,000 km, in metres.
MAX_METRES = 1e7
MAX_SEGMENTS = 16
MAX_PATH = 256
_MAX_SAFE_INTEGER = 2**53 - 1

_Ranges = Sequence[Tuple[int, int]]


def _class(ranges: _Ranges) -> "re.Pattern[str]":
    return re.compile("[" + "".join(f"{chr(a)}-{chr(b)}" for a, b in ranges) + "]")


#: Unicode's Default_Ignorable_Code_Point, as ``\p{Default_Ignorable_Code_Point}``.
_INVISIBLE = _class(
    [
        (0xAD, 0xAD), (0x34F, 0x34F), (0x61C, 0x61C), (0x115F, 0x1160), (0x17B4, 0x17B5),
        (0x180B, 0x180F), (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164),
        (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3),
        (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF),
    ]
)  # fmt: skip
#: Every virama (Canonical_Combining_Class 9), as core lists them.
_VIRAMA = _class(
    [
        (0x094D, 0x094D), (0x09CD, 0x09CD), (0x0A4D, 0x0A4D), (0x0ACD, 0x0ACD), (0x0B4D, 0x0B4D),
        (0x0BCD, 0x0BCD), (0x0C4D, 0x0C4D), (0x0CCD, 0x0CCD), (0x0D3B, 0x0D3C), (0x0D4D, 0x0D4D),
        (0x0DCA, 0x0DCA), (0x0E3A, 0x0E3A), (0x0EBA, 0x0EBA), (0x0F84, 0x0F84), (0x1039, 0x103A),
        (0x1714, 0x1715), (0x1734, 0x1734), (0x17D2, 0x17D2), (0x1A60, 0x1A60), (0x1B44, 0x1B44),
        (0x1BAA, 0x1BAB), (0x1BF2, 0x1BF3), (0x2D7F, 0x2D7F), (0xA806, 0xA806), (0xA82C, 0xA82C),
        (0xA8C4, 0xA8C4), (0xA953, 0xA953), (0xA9C0, 0xA9C0), (0xAAF6, 0xAAF6), (0xABED, 0xABED),
        (0x10A3F, 0x10A3F), (0x11046, 0x11046), (0x11070, 0x11070), (0x1107F, 0x1107F),
        (0x110B9, 0x110B9), (0x11133, 0x11134), (0x111C0, 0x111C0), (0x11235, 0x11235),
        (0x112EA, 0x112EA), (0x1134D, 0x1134D), (0x113CE, 0x113D0), (0x11442, 0x11442),
        (0x114C2, 0x114C2), (0x115BF, 0x115BF), (0x1163F, 0x1163F), (0x116B6, 0x116B6),
        (0x1172B, 0x1172B), (0x11839, 0x11839), (0x1193D, 0x1193E), (0x119E0, 0x119E0),
        (0x11A34, 0x11A34), (0x11A47, 0x11A47), (0x11A99, 0x11A99), (0x11C3F, 0x11C3F),
        (0x11D44, 0x11D45), (0x11D97, 0x11D97), (0x11F41, 0x11F42), (0x1612F, 0x1612F),
    ]
)  # fmt: skip
#: The letters of the scripts whose letters join: Arabic, Syriac, NKo, Mandaic, Mongolian, Adlam,
#: Hanifi Rohingya, Manichaean and Psalter Pahlavi (``(?=\p{L})[\p{sc=Arabic}...]``).
_JOINING_LETTER = _class(
    [
        (0x620, 0x63F), (0x641, 0x64A), (0x66E, 0x66F), (0x671, 0x6D3), (0x6D5, 0x6D5),
        (0x6E5, 0x6E6), (0x6EE, 0x6EF), (0x6FA, 0x6FC), (0x6FF, 0x6FF), (0x710, 0x710),
        (0x712, 0x72F), (0x74D, 0x77F), (0x7CA, 0x7EA), (0x7F4, 0x7F5), (0x7FA, 0x7FA),
        (0x840, 0x858), (0x860, 0x86A), (0x870, 0x887), (0x889, 0x88F), (0x8A0, 0x8C9),
        (0x1820, 0x1878), (0x1880, 0x1884), (0x1887, 0x18A8), (0x18AA, 0x18AA), (0xFB50, 0xFBB1),
        (0xFBD3, 0xFD3D), (0xFD50, 0xFD8F), (0xFD92, 0xFDC7), (0xFDF0, 0xFDFB), (0xFE70, 0xFE74),
        (0xFE76, 0xFEFC), (0x10AC0, 0x10AC7), (0x10AC9, 0x10AE4), (0x10B80, 0x10B91),
        (0x10D00, 0x10D23), (0x10EC2, 0x10EC7), (0x1E900, 0x1E943), (0x1E94B, 0x1E94B),
        (0x1EE00, 0x1EE03), (0x1EE05, 0x1EE1F), (0x1EE21, 0x1EE22), (0x1EE24, 0x1EE24),
        (0x1EE27, 0x1EE27), (0x1EE29, 0x1EE32), (0x1EE34, 0x1EE37), (0x1EE39, 0x1EE39),
        (0x1EE3B, 0x1EE3B), (0x1EE42, 0x1EE42), (0x1EE47, 0x1EE47), (0x1EE49, 0x1EE49),
        (0x1EE4B, 0x1EE4B), (0x1EE4D, 0x1EE4F), (0x1EE51, 0x1EE52), (0x1EE54, 0x1EE54),
        (0x1EE57, 0x1EE57), (0x1EE59, 0x1EE59), (0x1EE5B, 0x1EE5B), (0x1EE5D, 0x1EE5D),
        (0x1EE5F, 0x1EE5F), (0x1EE61, 0x1EE62), (0x1EE64, 0x1EE64), (0x1EE67, 0x1EE6A),
        (0x1EE6C, 0x1EE72), (0x1EE74, 0x1EE77), (0x1EE79, 0x1EE7C), (0x1EE7E, 0x1EE7E),
        (0x1EE80, 0x1EE89), (0x1EE8B, 0x1EE9B), (0x1EEA1, 0x1EEA3), (0x1EEA5, 0x1EEA9),
        (0x1EEAB, 0x1EEBB),
    ]
)  # fmt: skip
_ZWNJ = "\u200c"
_ZWJ = "\u200d"
_SEGMENT_SYMBOLS = "._:@-"
_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}")
_FIELD = re.compile(r"[^A-Za-z0-9_.-]")
_LONE_SURROGATE = re.compile("[" + chr(0xD800) + "-" + chr(0xDFFF) + "]")
_SURROGATE_PAIR = re.compile("[" + chr(0xD800) + "-" + chr(0xDBFF) + "][" + chr(0xDC00) + "-" + chr(0xDFFF) + "]")

_PLACE_KEYS = ("nodeId", "mapId", "mapVersion", "frame", "pose", "extent", "geo", "sigma")


class PlaceError(Exception):
    """A place, path or filter core's rules refuse. ``at`` is the field (``place.pose.x``);
    the message is core's (``place.pose.x must be a number from ...``), never a value."""

    def __init__(self, at: str, why: str) -> None:
        super().__init__(f"{at} {why}")
        self.at = at


def field(k: Any) -> str:
    """A field name as an error may show it (core's ``field``): never a value. A character outside
    the BMP is two UTF-16 units in JavaScript, so two ``_``."""
    s = k if isinstance(k, str) else str(k)
    return "".join(("__" if ord(c) > 0xFFFF else "_") if _FIELD.match(c) else c for c in s)[:64]


def _fail(at: str, why: str) -> "PlaceError":
    return PlaceError(at, why)


def _object(v: Any, at: str) -> Mapping[Any, Any]:
    if not isinstance(v, Mapping):
        raise _fail(at, "must be an object")
    return v


def _only(o: Mapping[Any, Any], at: str, keys: Sequence[str]) -> None:
    for k in o:
        if k not in keys:
            raise _fail(f"{at}.{field(k)}", "is not a known field")


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _num(v: Any, at: str, lo: float, hi: float, open_: bool = False) -> Any:
    ok = _is_number(v) and not (isinstance(v, float) and not math.isfinite(v))
    if not ok or v > hi or (v <= lo if open_ else v < lo):
        raise _fail(at, f"must be a number {'above' if open_ else 'from'} {js_number(lo)} to {js_number(hi)}")
    return v


def _word(v: Any, at: str) -> str:
    if not isinstance(v, str) or not _WORD.fullmatch(v):
        raise _fail(at, "must be one word of 1 to 128 letters, digits and . _ : @ / -")
    return v


def _frame(v: Any, at: str) -> str:
    f = _word(v, at)
    if f.lower() == "odom":
        raise _fail(at, "cannot be odom: odometry drifts, use the map frame")
    return f


def _cat(c: str) -> str:
    return unicodedata.category(c)


def _segment_ok(s: str) -> bool:
    """Core's ``SEGMENT``: a letter, digit or symbol, then letters, marks, digits, symbols and the
    joiners, 1 to 64 characters."""
    if not 1 <= len(s) <= 64:
        return False
    first = s[0]
    if not (first in _SEGMENT_SYMBOLS or _cat(first)[0] in "LN"):
        return False
    return all(c in _SEGMENT_SYMBOLS or c in (_ZWNJ, _ZWJ) or _cat(c)[0] in "LMN" for c in s[1:])


def _joiner_allowed(s: str, i: int) -> bool:
    """Core's ``CONTEXT_J`` at ``s[i]`` (a joiner): after a virama, or a ZWNJ between two letters of
    a joining script with only nonspacing marks around it."""
    if i > 0 and _VIRAMA.match(s[i - 1]):
        return True
    if s[i] != _ZWNJ:
        return False
    j = i - 1
    while j >= 0 and _cat(s[j]) == "Mn":
        j -= 1
    if j < 0 or not _JOINING_LETTER.match(s[j]):
        return False
    k = i + 1
    while k < len(s) and _cat(s[k]) == "Mn":
        k += 1
    return k < len(s) and bool(_JOINING_LETTER.match(s[k]))


def _has_invisible(s: str) -> bool:
    for i, c in enumerate(s):
        if _INVISIBLE.match(c) and not (c in (_ZWNJ, _ZWJ) and _joiner_allowed(s, i)):
            return True
    return False


def _js_len(s: str) -> int:
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def check_place_path(raw: Any, at: str = "place.nodeId") -> str:
    """A place path, checked and in Unicode NFC: 1 to 16 segments of 1 to 64 letters (with their
    combining marks), digits and ``. _ : @ -``, with no invisible characters but the joiners
    IDNA's ContextJ rules allow."""
    v = unicodedata.normalize("NFC", js_text(raw)) if isinstance(raw, str) else raw
    if not isinstance(v, str) or _js_len(v) > MAX_PATH:
        raise _fail(at, f"must be a place path of at most {MAX_PATH} characters")
    segments = v.split("/")
    # Before the segment pattern, so a soft hyphen or a stray joiner is named for what it is.
    if any(_has_invisible(s) for s in segments):
        raise _fail(at, "cannot hold invisible characters such as variation selectors, or a joiner outside a word")
    if len(segments) > MAX_SEGMENTS or not all(_segment_ok(s) for s in segments):
        raise _fail(
            at, f"must be 1 to {MAX_SEGMENTS} segments joined by /, each 1 to 64 letters, digits and . _ : @ -"
        )
    return v


def _pose(v: Any, at: str, with_yaw: bool) -> Dict[str, Any]:
    o = _object(v, at)
    _only(o, at, ("x", "y", "z", "yaw") if with_yaw else ("x", "y", "z"))
    p: Dict[str, Any] = {
        "x": _num(o.get("x"), f"{at}.x", -MAX_METRES, MAX_METRES),
        "y": _num(o.get("y"), f"{at}.y", -MAX_METRES, MAX_METRES),
    }
    if "z" in o:
        p["z"] = _num(o["z"], f"{at}.z", -MAX_METRES, MAX_METRES)
    if with_yaw and "yaw" in o:
        p["yaw"] = _num(o["yaw"], f"{at}.yaw", -1e3, 1e3)
    return p


def _extent(v: Any, at: str, p: Mapping[str, Any]) -> Dict[str, Any]:
    o = _object(v, at)
    if "radius" in o:
        if len(o) != 1:
            raise _fail(at, "is a box (dx, dy, dz) or a sphere (radius), not both")
        return {"radius": _num(o["radius"], f"{at}.radius", 0, MAX_METRES, True)}
    _only(o, at, ("dx", "dy", "dz"))
    b: Dict[str, Any] = {
        "dx": _num(o.get("dx"), f"{at}.dx", 0, MAX_METRES, True),
        "dy": _num(o.get("dy"), f"{at}.dy", 0, MAX_METRES, True),
    }
    if "dz" in o:
        if "z" not in p:
            raise _fail(f"{at}.dz", "needs place.pose.z")
        b["dz"] = _num(o["dz"], f"{at}.dz", 0, MAX_METRES, True)
    return b


def check_place(v: Any, at: str = "place") -> Dict[str, Any]:
    """``v`` as a place (camelCase keys, as on the wire), checked, with only the known fields in a
    fixed order. A key that is present counts, even with ``None`` (JSON's null), as in core."""
    o = _object(v, at)
    _only(o, at, _PLACE_KEYS)
    p: Dict[str, Any] = {}
    if "nodeId" in o:
        p["nodeId"] = check_place_path(o["nodeId"], f"{at}.nodeId")
    if "mapId" in o:
        p["mapId"] = _word(o["mapId"], f"{at}.mapId")
    if "mapVersion" in o:
        mv = o["mapVersion"]
        whole = (isinstance(mv, int) and not isinstance(mv, bool)) or (
            isinstance(mv, float) and math.isfinite(mv) and mv.is_integer()
        )
        if not whole or not 0 <= mv <= _MAX_SAFE_INTEGER:
            raise _fail(f"{at}.mapVersion", "must be a whole number from 0")
        p["mapVersion"] = mv
    if "frame" in o:
        p["frame"] = _frame(o["frame"], f"{at}.frame")
    if "pose" in o:
        if "mapId" not in p:
            raise _fail(f"{at}.mapId", "is required with a pose")
        p["pose"] = _pose(o["pose"], f"{at}.pose", True)
    if "extent" in o:
        if "pose" not in p:
            raise _fail(f"{at}.extent", "needs a pose")
        p["extent"] = _extent(o["extent"], f"{at}.extent", p["pose"])
    if "geo" in o:
        g = _object(o["geo"], f"{at}.geo")
        _only(g, f"{at}.geo", ("lat", "lon", "alt"))
        geo: Dict[str, Any] = {
            "lat": _num(g.get("lat"), f"{at}.geo.lat", -90, 90),
            "lon": _num(g.get("lon"), f"{at}.geo.lon", -180, 180),
        }
        if "alt" in g:
            geo["alt"] = _num(g["alt"], f"{at}.geo.alt", -MAX_METRES, MAX_METRES)
        p["geo"] = geo
    if "sigma" in o:
        p["sigma"] = _num(o["sigma"], f"{at}.sigma", 0, MAX_METRES)
    if "nodeId" not in p and "pose" not in p and "geo" not in p:
        raise _fail(at, "needs a nodeId, a pose or geo")
    return p


def check_near(v: Any, at: str = "near") -> Dict[str, Any]:
    """A ``near`` query, checked (as ``check_place``)."""
    o = _object(v, at)
    _only(o, at, ("mapId", "frame", "pose", "radius"))
    if "mapId" not in o:
        raise _fail(f"{at}.mapId", "is required")
    n: Dict[str, Any] = {"mapId": _word(o["mapId"], f"{at}.mapId")}
    frame = _frame(o["frame"], f"{at}.frame") if "frame" in o else None
    n["pose"] = _pose(o.get("pose"), f"{at}.pose", False)
    n["radius"] = _num(o.get("radius"), f"{at}.radius", 0, MAX_METRES, True)
    if frame is not None:
        n["frame"] = frame
    return n


def check_spatial_filter(v: Any) -> Dict[str, Any]:
    """A spatial filter (``within``, ``near``), checked; an empty one is no filter."""
    o = _object(v, "spatial")
    _only(o, "spatial", ("within", "near"))
    out: Dict[str, Any] = {}
    if "within" in o:
        out["within"] = check_place_path(o["within"], "within")
    if "near" in o:
        out["near"] = check_near(o["near"])
    return out


def frame_of(p: Mapping[str, Any]) -> str:
    f = p.get("frame")
    return DEFAULT_FRAME if f is None else f


def within_path(node_id: Optional[str], path: str) -> bool:
    """True when ``node_id`` holds ``path``'s segments as a run of whole segments."""
    if node_id is None:
        return False
    return f"/{path}/" in f"/{node_id}/"


def _half_sizes(p: Mapping[str, Any]) -> Tuple[float, float, Optional[float]]:
    pose = p["pose"]
    e = p.get("extent")
    if e is None:
        return 0, 0, (None if pose.get("z") is None else 0)
    if "radius" in e:
        r = e["radius"]
        return r, r, (None if pose.get("z") is None else r)
    return e["dx"] / 2, e["dy"] / 2, (None if e.get("dz") is None else e["dz"] / 2)


def place_distance(p: Optional[Mapping[str, Any]], q: Mapping[str, Any]) -> Optional[float]:
    """Metres from ``q``'s point to the place's region (0 inside it), or ``None`` when they cannot
    be compared: no coordinates, or another map or frame."""
    if p is None or p.get("pose") is None or p.get("mapId") != q["mapId"] or frame_of(p) != frame_of(q):
        return None
    c = p["pose"]
    hx, hy, hz = _half_sizes(p)
    qz = q["pose"].get("z")
    use_z = hz is not None and c.get("z") is not None and qz is not None
    dx = q["pose"]["x"] - c["x"]
    dy = q["pose"]["y"] - c["y"]
    dz = qz - c["z"] if use_z else 0
    e = p.get("extent")
    if e is not None and "radius" in e:
        return max(math.hypot(dx, dy, dz) - e["radius"], 0)
    ax = max(abs(dx) - hx, 0)
    ay = max(abs(dy) - hy, 0)
    az = max(abs(dz) - hz, 0) if use_z and hz is not None else 0
    return math.hypot(ax, ay, az)


def matches_spatial(place: Optional[Mapping[str, Any]], f: Mapping[str, Any]) -> bool:
    """True when a memory at ``place`` passes every filter ``f`` sets."""
    within = f.get("within")
    if within is not None and not within_path(None if place is None else place.get("nodeId"), within):
        return False
    near = f.get("near")
    if near is not None:
        d = place_distance(place, near)
        if d is None or d > near["radius"]:
            return False
    return True


# ---------------------------------------------------------------------------------------------
# The turn ref of a remember with a place, byte for byte as the TypeScript SDK's.


def js_number(v: Any) -> str:
    """A number as JavaScript's ``String(n)`` and ``JSON.stringify`` write it."""
    if isinstance(v, bool) or not _is_number(v):
        raise TypeError("not a number")
    if isinstance(v, int):
        return str(v)
    if not math.isfinite(v):
        return "null"
    if v == 0:
        return "0"
    sign = "-" if v < 0 else ""
    # The shortest digits that read back as v (both languages pick them), placed as ECMAScript's
    # Number::toString places them: v is 0.digits times 10 to the n.
    t = Decimal(repr(abs(v))).normalize().as_tuple()
    digits = "".join(str(d) for d in t.digits)
    k = len(digits)
    n = k + int(t.exponent)
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        out = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + out


def js_text(s: str) -> str:
    """A string as JavaScript reads it: a surrogate pair held as two Python code points is the one
    character it encodes. A lone surrogate stays as it is."""
    return _SURROGATE_PAIR.sub(lambda m: chr(0x10000 + ((ord(m.group(0)[0]) - 0xD800) << 10) + ord(m.group(0)[1]) - 0xDC00), s)


def js_json_text(out: str) -> str:
    """JSON from ``json.dumps(..., ensure_ascii=False)`` as ``JSON.stringify`` writes it: surrogate
    pairs joined (``js_text``) and a lone surrogate as a ``\\u`` escape, so the text is valid UTF-8."""
    return _LONE_SURROGATE.sub(lambda m: f"\\u{ord(m.group(0)):04x}", js_text(out))


def _js_string(s: str) -> str:
    """A string as ``JSON.stringify`` writes it."""
    return js_json_text(json.dumps(s, ensure_ascii=False))


def _js_json(v: Any) -> str:
    """``JSON.stringify(v)`` for the strings, numbers, lists and dicts a turn ref hashes."""
    if isinstance(v, str):
        return _js_string(v)
    if isinstance(v, Mapping):
        return "{" + ",".join(f"{_js_string(k)}:{_js_json(x)}" for k, x in v.items()) + "}"
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(_js_json(x) for x in v) + "]"
    return js_number(v)


def place_identity(p: Mapping[str, Any]) -> str:
    """What makes two places one for a remember's turn ref: the fields core compares (the place
    path, and the pose on its map and frame). A place with neither is compared by its geo."""
    out: Dict[str, Any] = {}
    if p.get("nodeId") is not None:
        out["nodeId"] = p["nodeId"]
    pose = p.get("pose")
    if pose is not None:
        out["mapId"] = p.get("mapId")
        out["frame"] = frame_of(p)
        out["pose"] = {"x": pose["x"], "y": pose["y"], **({"z": pose["z"]} if pose.get("z") is not None else {})}
    if p.get("nodeId") is None and pose is None and p.get("geo") is not None:
        out["geo"] = p["geo"]
    return _js_json(out)


def _utf8(s: str) -> bytes:
    # As Node hashes a string: a surrogate pair as its character, a lone surrogate as U+FFFD.
    return _LONE_SURROGATE.sub(chr(0xFFFD), js_text(s)).encode("utf-8")


def remember_turn_ref(
    fact: str, type_: Optional[str], project: Optional[str], at: str, place: Optional[Mapping[str, Any]] = None
) -> str:
    """The ``turnRef`` of one remembered fact, as the TypeScript SDK's ``rememberTurnRef``: the
    project, the type hint, the fact (as scrubbed for Oort Cloud, ``scrubbed_fact``) and its
    place, hashed, and the UTC day. Without a place, the input is the one from before places;
    with one, a NUL and a JSON array, so no fact can spell another field."""
    if place is None:
        data = f"{project or ''}\n{type_ or ''}\n{fact}"
    else:
        data = "\0" + _js_json([project or "", type_ or "", fact, place_identity(place)])
    return f"remember:{hashlib.sha256(_utf8(data)).hexdigest()}:{at[:10]}"


def scrubbed_fact(fact: str) -> str:
    """A fact as the TypeScript SDK hashes it: scrubbed as the turn's ``Noted: `` line."""
    noted = "Noted: "
    return clean(noted + fact)[len(noted) :]


def checked_place(raw: Any) -> Optional[Dict[str, Any]]:
    """A place Oort Cloud sent, as core's rules read it, or ``None`` when they refuse it."""
    try:
        return check_place(raw)
    except PlaceError:
        return None


def fields_of(e: PlaceError, key: str) -> List[str]:
    """The field a ``PlaceError`` names, under ``key`` (``near`` + ``near.pose.x`` is ``near.pose.x``),
    as the SDK's ``corePlaceCheck`` reports it."""
    rest = e.at.split(".")[1:]
    return [".".join([key, *rest])]
