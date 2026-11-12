"""Result types: the TypeScript SDK's views (docs/sdk.md), as frozen dataclasses.

Fields are snake_case here and camelCase on the wire, converted mechanically (``validFrom`` is
``valid_from``). An optional TypeScript field that is absent is ``None``. Ids are full ids and
times are ISO 8601 strings. Callers must ignore fields they do not know: a minor release may add
some.
"""

from __future__ import annotations

import dataclasses
import re
import sys
import typing
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Mapping, Optional, Union

__all__ = [
    "MemoryType",
    "MemoryStatus",
    "IncludeLevel",
    "RecallMode",
    "Outcome",
    "OortWarning",
    "Origin",
    "JudgmentSubject",
    "Withdrawal",
    "Pack",
    "JudgmentView",
    "MemoryView",
    "RecallWhy",
    "RecalledMemory",
    "Temporal",
    "RecallResult",
    "ObservedMemory",
    "ObserveResult",
    "RememberedFact",
    "RememberResult",
    "ForgetResult",
    "PinResult",
    "RecentResult",
    "Decision",
    "ExplainedMemory",
    "ChainLink",
    "Explanation",
    "RecordJudgmentView",
    "Precedent",
    "Prediction",
    "JudgeResult",
    "JudgmentList",
    "ConfirmResult",
    "ConsolidateResult",
    "Whoami",
    "EndUserErasure",
    "EndUserExport",
    "EndUserCount",
    "Turn",
]

MemoryType = Literal["semantic", "episodic", "procedural", "preference", "judgment"]
MemoryStatus = Literal["current", "superseded", "corrected", "expired", "not-yet-valid", "withdrawn"]
IncludeLevel = Literal["self", "planet", "star", "constellation", "galaxy"]
RecallMode = Literal["current", "as-of", "history", "known-at"]
Outcome = Literal["added", "reinforced", "updated", "superseded", "corrected", "skipped"]

_FROZEN = dict(frozen=True, slots=True, kw_only=True)


@dataclass(**_FROZEN)
class OortWarning:
    """An ``oort.v1`` warning code (``lexical-only``, ``recall-degraded``, ...) and a line for
    people. (``Warning`` in TypeScript; renamed so it never shadows Python's built-in.)"""

    code: str
    message: str


@dataclass(**_FROZEN)
class Origin:
    level: IncludeLevel
    space: str
    author: Optional[str] = None
    overridden_by: Optional[str] = None


@dataclass(**_FROZEN)
class JudgmentSubject:
    summary: str
    ref: Optional[str] = None


@dataclass(**_FROZEN)
class Withdrawal:
    at: str
    by: str


@dataclass(**_FROZEN)
class Pack:
    id: str
    name: str


@dataclass(**_FROZEN)
class JudgmentView:
    id: str
    subject: JudgmentSubject
    verdict: str
    verdicts: List[str]
    reason: str
    criteria: List[str]
    domain: str
    by: str
    decided_at: str
    #: ``mcp``: recorded by an agent (MCP, or an SDK in agent role). ``sdk``: by expert-role code.
    via: str
    status: MemoryStatus
    #: A person recorded it, or confirmed an agent's record of it.
    confirmed: bool
    #: Recorded by an agent and not confirmed: judging leaves it out by default.
    agent_recorded: bool
    withdrawn: Optional[Withdrawal] = None
    pack: Optional[Pack] = None


@dataclass(**_FROZEN)
class Pose:
    """A position in metres on a map: x forward, y left, z up; yaw in radians."""

    x: float
    y: float
    z: Optional[float] = None
    yaw: Optional[float] = None


@dataclass(**_FROZEN)
class Place:
    """Where a memory is (spatial memory, 0.9.0 or newer; local mode only). ``remember``,
    ``observe`` and ``recall(near=...)`` also take a mapping with these keys."""

    #: A place path, root first, whole segments: ``site:hq/floor:2/room:B/shelf:B3``.
    node_id: Optional[str] = None
    #: The map the coordinates are in. Required with ``pose``.
    map_id: Optional[str] = None
    #: Recorded, not filtered on.
    map_version: Optional[int] = None
    #: Default ``map``. ``odom`` is refused: it drifts.
    frame: Optional[str] = None
    pose: Optional[Pose] = None
    #: The region around ``pose``: ``{"dx", "dy", "dz"?}`` (full sizes, centred) or ``{"radius"}``.
    extent: Optional[Dict[str, float]] = None
    #: WGS84 ``{"lat", "lon", "alt"?}``; stored and returned, not searchable yet.
    geo: Optional[Dict[str, float]] = None
    #: Pose uncertainty in metres (1 sigma).
    sigma: Optional[float] = None


@dataclass(**_FROZEN)
class NearQuery:
    """``recall(near=...)``: within ``radius`` metres of ``pose`` on the same map and frame."""

    map_id: str
    pose: Pose
    #: Metres, more than 0.
    radius: float
    #: Default ``map``.
    frame: Optional[str] = None


@dataclass(**_FROZEN)
class MemoryView:
    id: str
    #: Scrubbed again on read.
    text: str
    type: MemoryType
    tier: Literal["hot", "warm", "cold"]
    pinned: bool
    status: MemoryStatus
    valid_from: str
    valid_to: Optional[str]
    #: When it was recorded (transaction time).
    recorded_at: str
    updated_at: str
    entities: List[str] = field(default_factory=list)
    origin: Optional[Origin] = None
    judgment: Optional[JudgmentView] = None
    #: Where it is (0.9.0 or newer), when it was remembered with a place.
    place: Optional[Place] = None


@dataclass(**_FROZEN)
class RecallWhy:
    """Diagnostic (experimental): may change in a minor release."""

    coverage: float
    activation: float
    lexical_rank: Optional[int] = None
    dense_rank: Optional[int] = None
    reranked: Optional[float] = None
    dense: Optional[float] = None
    chain: Optional[bool] = None
    #: With ``near`` or ``within``: the memory's place path.
    place_path: Optional[str] = None
    #: With ``near``: metres from the query point to the memory's region (0 inside it).
    distance_m: Optional[float] = None


@dataclass(**_FROZEN)
class RecalledMemory(MemoryView):
    #: The fused score, comparable only within one result.
    score: float
    why: RecallWhy
    stale: Optional[bool] = None


@dataclass(**_FROZEN)
class Temporal:
    mode: RecallMode
    inferred: bool
    as_of: Optional[str] = None
    known_at: Optional[str] = None


@dataclass(**_FROZEN)
class RecallResult:
    memories: List[RecalledMemory]
    abstained: bool
    temporal: Temporal
    #: The spaces read, as labels.
    read: List[str]
    degraded: List[str]
    warnings: List[OortWarning]
    #: The block budget ``format_for_prompt`` uses for this result by default.
    budget_chars: Optional[int] = field(default=None, repr=False, compare=False)


@dataclass(**_FROZEN)
class ObservedMemory:
    outcome: Outcome
    id: Optional[str] = None
    supersedes: Optional[str] = None
    reason: Optional[str] = None


@dataclass(**_FROZEN)
class ObserveResult:
    outcome: Outcome
    memories: List[ObservedMemory]
    counts: Dict[str, int]
    warnings: List[OortWarning]
    #: Cloud mode only: this ``turn_ref`` was saved before.
    duplicate: Optional[bool] = None


@dataclass(**_FROZEN)
class RememberedFact:
    fact: int
    outcome: Outcome
    id: Optional[str] = None
    supersedes: Optional[str] = None
    reason: Optional[str] = None


@dataclass(**_FROZEN)
class RememberResult:
    results: List[RememberedFact]
    warnings: List[OortWarning]


@dataclass(**_FROZEN)
class ForgetResult:
    forgotten: str
    #: Cloud ``everywhere``: Constellations whose copy only you contributed to, withdrawn.
    withdrawn: Optional[List[str]] = None
    #: Cloud ``everywhere``: Constellations where others contributed too (a removal request).
    requested: Optional[List[str]] = None
    #: Cloud ``everywhere``: Constellations not reached; call again later with the full id.
    unreachable: Optional[List[str]] = None


@dataclass(**_FROZEN)
class PinResult:
    id: str
    pinned: bool
    #: ``None``: cloud mode cannot tell.
    changed: Optional[bool]


@dataclass(**_FROZEN)
class RecentResult:
    memories: List[MemoryView]
    warnings: List[OortWarning]


@dataclass(**_FROZEN)
class Decision:
    stage: str
    question: str
    answer: str
    probability: float


@dataclass(**_FROZEN)
class ExplainedMemory(MemoryView):
    salience: float
    activation: float
    source: str


@dataclass(**_FROZEN)
class ChainLink:
    id: str
    text: str
    valid_from: str
    valid_to: Optional[str]
    end_reason: Optional[Literal["superseded", "corrected", "expired"]]


@dataclass(**_FROZEN)
class Explanation:
    memory: ExplainedMemory
    decisions: List[Decision]
    chain: List[ChainLink]
    hidden_links: int


@dataclass(**_FROZEN)
class RecordJudgmentView:
    outcome: Literal["added", "corrected", "unchanged"]
    id: str
    status: Literal["agent-recorded", "recorded"]
    #: Kinds of secret redacted before saving.
    redacted: List[str]
    corrects: Optional[str] = None
    embed_failed: Optional[bool] = None


@dataclass(**_FROZEN)
class Precedent:
    id: str
    subject: JudgmentSubject
    verdict: str
    reason: str
    criteria: List[str]
    domain: str
    by: str
    decided_at: str
    similarity: float
    near: bool
    via: str
    confirmed: bool
    agent_recorded: bool
    agrees: Optional[bool] = None
    pack: Optional[Pack] = None


@dataclass(**_FROZEN)
class Prediction:
    """A prediction from precedents, never the expert's decision."""

    verdict: str
    probability: float
    probabilities: Dict[str, float]


@dataclass(**_FROZEN)
class JudgeResult:
    status: Literal["suggested", "needs-expert", "precedents-only"]
    precedents: List[Precedent]
    verdicts: List[str]
    agreement: Dict[str, float]
    similarity: Literal["dense", "lexical"]
    threshold: float
    min_similarity: float
    #: Experimental.
    decisions: List[Decision]
    why: Optional[str] = None
    prediction: Optional[Prediction] = None
    degraded: Optional[List[str]] = None
    imported_excluded: Optional[int] = None
    agent_recorded_excluded: Optional[int] = None


@dataclass(**_FROZEN)
class JudgmentList:
    judgments: List[JudgmentView]


@dataclass(**_FROZEN)
class ConfirmResult:
    id: str
    changed: bool


@dataclass(**_FROZEN)
class ConsolidateResult:
    promoted: List[str]
    demoted: List[str]
    evicted: List[str]
    expired: List[str]
    skipped: int
    complete: bool


@dataclass(**_FROZEN)
class Whoami:
    mode: Literal["local", "cloud", "remote"]
    account: Optional[str]
    agent: Optional[str]
    project: Optional[str]
    user: Optional[str]
    reads: List[str]
    writes_to: str
    version: str
    routes: Dict[str, str]


@dataclass(**_FROZEN)
class EndUserErasure:
    """What ``end_users.erase`` removed (Oort Cloud, CON-132): the id you erased, and counts."""

    erased: str
    memories: int
    cold_copies: int
    turn_refs: int
    cursors: int


@dataclass(**_FROZEN)
class EndUserExport:
    """One end user's memories, exported (Oort Cloud, CON-137): what an access or portability
    request asks for. ``jsonl`` is the Oort export format (docs/export-format.md, version 1 from
    Oort Cloud): the manifest line, then one memory per line, in every tier and validity state.
    Write it to a ``.jsonl`` file to hand over; ``oort import <file>`` reads it into a
    self-hosted store."""

    exported: str
    memories: int
    jsonl: str


@dataclass(**_FROZEN)
class EndUserCount:
    """How many end users the account has, and how many its plan includes (CON-132)."""

    end_users: int
    limit: int


@dataclass(**_FROZEN)
class Turn:
    """One exchange to observe. ``observe`` also takes a mapping with these keys."""

    user: str
    assistant: str
    #: Tool-call summaries; truncated to 16 x 512 bytes, never refused.
    tools: Optional[List[str]] = None
    #: ISO 8601 (or a datetime); default now.
    at: Optional[Any] = None
    session_id: Optional[str] = None
    #: At most 128 characters; deduplicated by Oort Cloud only.
    turn_ref: Optional[str] = None
    #: Where this turn happened (a ``Place`` or a mapping): the memories it writes carry it.
    #: 0.9.0 or newer; local mode only.
    place: Optional[Any] = None


# --------------------------------------------------------------------------------------------
# Wire names and conversion.


def camel(name: str) -> str:
    """``valid_from`` -> ``validFrom``."""
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


_SNAKE = re.compile(r"(?<!^)(?=[A-Z])")


def snake(name: str) -> str:
    """``validFrom`` -> ``valid_from``."""
    return _SNAKE.sub("_", name).lower()


_HINTS: Dict[type, Dict[str, Any]] = {}


def _hints(cls: type) -> Dict[str, Any]:
    h = _HINTS.get(cls)
    if h is None:
        h = typing.get_type_hints(cls, vars(sys.modules[__name__]))
        _HINTS[cls] = h
    return h


def _convert(tp: Any, v: Any) -> Any:
    if v is None:
        return None
    origin = typing.get_origin(tp)
    if origin is Union:
        args = [a for a in typing.get_args(tp) if a is not type(None)]
        return _convert(args[0], v) if len(args) == 1 else v
    if origin in (list, List):
        (inner,) = typing.get_args(tp) or (Any,)
        return [_convert(inner, x) for x in v] if isinstance(v, list) else []
    if origin in (dict, Dict):
        return dict(v) if isinstance(v, Mapping) else {}
    if dataclasses.is_dataclass(tp) and isinstance(tp, type):
        return from_wire(tp, v)
    return v


T = typing.TypeVar("T")


def from_wire(cls: "type[T]", data: Any) -> T:
    """A wire object (camelCase) as dataclass ``cls``; unknown fields are ignored."""
    if not isinstance(data, Mapping):
        raise TypeError(f"{cls.__name__}: not an object")
    hints = _hints(cls)
    kw: Dict[str, Any] = {}
    for f in dataclasses.fields(cls):  # type: ignore[arg-type]
        if not f.init:
            continue
        key = camel(f.name)
        if key in data:
            kw[f.name] = _convert(hints[f.name], data[key])
        elif f.default is dataclasses.MISSING and f.default_factory is dataclasses.MISSING:
            # A required field the service left out: None rather than a failed call.
            kw[f.name] = None
    return cls(**kw)


def to_wire(value: Any) -> Any:
    """A result (or any dataclass) back to its wire shape: camelCase keys, absent ``None`` s
    dropped. ``to_wire(r)`` is what ``oort serve`` and Oort Cloud's SDK shape send."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        out: Dict[str, Any] = {}
        for f in dataclasses.fields(value):
            if not f.repr:
                continue
            v = getattr(value, f.name)
            if v is None and f.default is None:
                continue
            out[camel(f.name)] = to_wire(v)
        return out
    if isinstance(value, list):
        return [to_wire(x) for x in value]
    if isinstance(value, dict):
        return {k: to_wire(v) for k, v in value.items()}
    return value
