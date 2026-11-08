"""Cloud mode: Oort Cloud over HTTPS, as the TypeScript SDK calls it (``sdk/cloud.ts``, and the
cloud leg of ``engine/recall.ts``). No Node, nothing written to disk. Results come back in the
SDK's wire shape (camelCase), which the client turns into dataclasses.

Oort Cloud scrubs secrets server-side before anything is stored or reaches a model; this client
sends turns and queries as given, as the CLI does (CON-108 Q3).
"""

from __future__ import annotations

import json
import math
import re
import threading
import urllib.parse
from typing import Any, Dict, List, Mapping, Optional

from . import __version__
from ._format import _ms
from ._scrub import clean_field as _clean
from ._secret import _Secret
from ._transport import DaemonOutdated, TcpTransport, Unreachable
from ._validate import iso
from .errors import (
    OortError,
    OortInternalError,
    OortNotFoundError,
    OortRefusedError,
    OortUsageError,
    cloud_error,
    end_users_unsupported,
    parse_retry_after,
)

DEFAULT_CLOUD_URL = "https://api.oortcloud.dev"
_LOOPBACK = ("localhost", "127.0.0.1", "[::1]", "::1")
_FULL_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
RECENT_SCAN = 500
#: The key capability that lets a server key act for its account's end users (CON-132).
END_USERS_CAPABILITY = "end-users"
#: The request header that names the end user a server key acts for (CON-132).
END_USER_HEADER = "Oort-User"


def end_users_allowed(me: Any) -> bool:
    """Whether a whoami answer lists the ``end-users`` capability: exactly that string, in a list."""
    caps = me.get("capabilities") if isinstance(me, Mapping) else None
    return isinstance(caps, list) and END_USERS_CAPABILITY in caps
_OUTCOMES = ("added", "reinforced", "updated", "superseded", "corrected", "skipped")


def cloud_url(raw: Optional[str]) -> str:
    """The API root: https, or http to a loopback host only (the key travels in every request),
    with no credentials, query or fragment."""
    if raw is None or raw == "":
        return DEFAULT_CLOUD_URL
    try:
        u = urllib.parse.urlsplit(raw)
        host = u.hostname or ""
        _ = u.port
    except ValueError:
        u = None  # type: ignore[assignment]
        host = ""
    ok = u is not None and (
        u.scheme == "https" or (u.scheme == "http" and (host in _LOOPBACK or f"[{host}]" in _LOOPBACK))
    )
    if not ok or u.username or u.password or u.query or u.fragment or not host:
        raise OortUsageError(
            "url (or OORT_CLOUD_URL) must be an https URL, or http to localhost, with no credentials or query.",
            reason="invalid-argument",
        )
    return f"{u.scheme}://{u.netloc}{u.path.rstrip('/')}"


def _status(m: Mapping[str, Any], now_ms: float) -> str:
    j = m.get("judgment")
    if isinstance(j, Mapping) and j.get("withdrawn") is not None:
        return "withdrawn"
    vf = _ms(m.get("validFrom") or "")
    vt = m.get("validTo")
    expired_at = m.get("expiredAt")
    current = expired_at is None and vf <= now_ms and (vt is None or now_ms < _ms(vt))
    if current:
        return "current"
    if m.get("endReason") == "corrected":
        return "corrected"
    if m.get("endReason") == "superseded":
        return "superseded"
    if expired_at is not None or (vt is not None and _ms(vt) <= now_ms):
        return "expired"
    return "not-yet-valid"


def _origin(o: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(o, Mapping):
        return None
    lvl = o.get("level")
    level = (
        "planet"
        if lvl == "user"
        else ("galaxy" if o.get("space") == "Galaxy" else "constellation")
        if lvl == "hive"
        else "star"
    )
    out: Dict[str, Any] = {"level": level, "space": o.get("node")}
    if o.get("author") is not None:
        out["author"] = o["author"]
    ob = o.get("overriddenBy")
    if isinstance(ob, Mapping) and ob.get("id") is not None:
        out["overriddenBy"] = ob["id"]
    return out


def memory_view(m: Mapping[str, Any], now_ms: float) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "id": m.get("id"),
        "text": _clean(m.get("text")),
        "type": m.get("type"),
        "tier": m.get("tier"),
        "pinned": m.get("pinned") is True,
        "status": _status(m, now_ms),
        "validFrom": m.get("validFrom"),
        "validTo": m.get("validTo"),
        "recordedAt": m.get("createdAt"),
        "updatedAt": m.get("updatedAt"),
        "entities": [_clean(e) for e in (m.get("entities") or [])],
    }
    origin = _origin(m.get("origin"))
    if origin is not None:
        out["origin"] = origin
    return out


def _recalled(m: Mapping[str, Any], now_ms: float) -> Dict[str, Any]:
    e = m.get("explanation") if isinstance(m.get("explanation"), Mapping) else {}
    why: Dict[str, Any] = {"coverage": e.get("coverage", 0), "activation": e.get("activation", 0)}
    for k in ("lexicalRank", "denseRank", "reranked", "dense"):
        if e.get(k) is not None:
            why[k] = e[k]
    if e.get("chain") is True:
        why["chain"] = True
    out = {**memory_view(m, now_ms), "score": e.get("fused", 0), "why": why}
    if e.get("stale") is True:
        out["stale"] = True
    return out


def _activation(m: Mapping[str, Any], now_ms: float, d: float = 0.5, ws: float = 1.0) -> float:
    """Core's ACT-R base-level activation, with the default parameters."""
    log = m.get("accessLog") if isinstance(m.get("accessLog"), Mapping) else {}
    hour = 3_600_000
    min_age = 1 / 60
    total = 0.0
    cs = log.get("compactedSum") or 0
    if cs > 0 and log.get("compactedAt") is not None:
        delta = max((now_ms - _ms(log["compactedAt"])) / hour, 0)
        h = max(log.get("compactedMeanAgeHours") or 0, min_age)
        total = cs * (1 + delta / h) ** -d
    for t in log.get("recent") or []:
        total += max((now_ms - _ms(t)) / hour, min_age) ** -d
    if not total > 0:
        total = (24 * 365) ** -d
    return math.log(total) + ws * float(m.get("salience") or 0)


class CloudClient:
    def __init__(self, url: str, key: _Secret, timeout: float, env: Mapping[str, str]) -> None:
        self.url = url
        self._key = key
        self._http = TcpTransport(url, timeout, env)
        # Whether this key may act for end users, checked once (CON-132). Only a yes is kept: a
        # refusal or a failed check is asked again, so an Oort Cloud upgrade needs no restart.
        self._end_users = False
        self._end_users_lock = threading.Lock()

    def __repr__(self) -> str:
        return f"CloudClient(url={self.url!r})"

    def require_end_users(self) -> None:
        """Refuses (``end-users-unsupported``) unless whoami lists the key's ``end-users``
        capability: an Oort Cloud from before CON-132 ignores ``Oort-User`` and would write the
        end user's memories into the account's own Planet."""
        if self._end_users:
            return
        with self._end_users_lock:
            if self._end_users:
                return
            if not end_users_allowed(self.call("GET", "/v1/whoami")):
                raise end_users_unsupported()
            self._end_users = True

    def call(self, method: str, route: str, body: Optional[Any] = None, user: Optional[str] = None) -> Any:
        """One request. With ``user``, it names that end user (``Oort-User``), and only once the
        key's capability is known."""
        if user is not None:
            self.require_end_users()
        headers = {
            "Authorization": f"Bearer {self._key.reveal()}",
            "User-Agent": f"oortmem-python/{__version__}",
            "Accept": "application/json",
        }
        if user is not None:
            headers[END_USER_HEADER] = user
        payload = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        try:
            r = self._http.request(method, route, headers, payload)
        except Unreachable as e:
            raise cloud_error(0, "timeout" if e.timeout else None) from None
        except DaemonOutdated:
            raise cloud_error(0) from None
        if r.status < 200 or r.status >= 300:
            code = msg = None
            try:
                err = json.loads(r.body.decode("utf-8")).get("error") or {}
                code = err.get("code") if isinstance(err.get("code"), str) else None
                msg = err.get("message") if isinstance(err.get("message"), str) else None
            except (ValueError, AttributeError, UnicodeDecodeError):
                pass
            # A redirect is never followed: the key must not travel to another origin.
            raise cloud_error(r.status, code, msg, parse_retry_after(r.headers.get("retry-after")))
        if r.status == 204 or not r.body:
            return None
        try:
            return json.loads(r.body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise OortInternalError("An internal error stopped this call (SyntaxError).") from None

    def close(self) -> None:
        self._http.close()


def _id_path(i: str) -> str:
    return "/v1/memories/" + urllib.parse.quote(i, safe="")


def find_memory(c: CloudClient, ref: str, user: Optional[str] = None) -> Mapping[str, Any]:
    m = c.call("GET", _id_path(ref), user=user)
    if not isinstance(m, Mapping):
        raise OortInternalError("An internal error stopped this call (TypeError).")
    return m


class CloudOps:
    """The SDK's cloud operations, for one handle's principal. ``user`` is the end user the
    memory calls name (``Oort-User``, CON-132), or ``None`` for the account."""

    def __init__(self, client: CloudClient, now_ms, user: Optional[str] = None) -> None:
        self.c = client
        self.now_ms = now_ms
        self.user = user

    def _call(self, method: str, route: str, body: Optional[Any] = None) -> Any:
        """A memory route: as this handle's end user when it has one."""
        return self.c.call(method, route, body, user=self.user)

    def _find(self, ref: str) -> Mapping[str, Any]:
        return find_memory(self.c, ref, self.user)

    # The principal: project id, its stated privacy, the agent, and whether it keeps a Star.
    def _project(self, p: "CloudPrincipal") -> Dict[str, Any]:
        if p.project is None:
            return {}
        out: Dict[str, Any] = {"project": p.project}
        if p.stated_privacy is not None:
            out["projectPrivate"] = p.stated_privacy
        return out

    def _refuse_star(self, p: "CloudPrincipal") -> None:
        if p.star:
            a = p.agent
            raise OortRefusedError(
                f"{a} keeps its memories in its own Star, which Oort Cloud does not have yet, so nothing was saved (your Planet in the cloud is left as it is). Run `oort connect {a} --no-star` to write your Planet, or `oort cloud use --local`.",
                fix=f"oort connect {a} --no-star",
                reason="star-in-cloud",
            )

    def recall(self, p: "CloudPrincipal", query: str, o: Mapping[str, Any], view: Mapping[str, str]) -> Dict[str, Any]:
        speed = o.get("speed") or "full"
        include = o.get("include")
        if self.user is not None and include is not None and any(lvl not in ("planet", "self") for lvl in include):
            # An end user reads their Planet only (CON-132, as a local end-user handle).
            raise OortRefusedError(
                "This end user's handle reads only their Planet: leave star, constellation and galaxy out of include.",
                reason="scope-denied",
            )
        body: Dict[str, Any] = {"text": query, **self._project(p)}
        if o.get("include") is not None:
            body["include"] = list(o["include"])
        if p.agent is not None:
            body["agent"] = p.agent
        body.update(view)
        body["k"] = o.get("limit") or 10
        if speed != "full":
            body["rerank"] = False
        if speed == "lexical":
            body["embed"] = False
        r = self._call("POST", "/v1/recall", body)
        if not isinstance(r, Mapping) or not isinstance(r.get("memories"), list):
            raise OortInternalError("An internal error stopped this call (TypeError).")
        now = self.now_ms()
        degraded = [
            d
            for d in (r.get("degraded") or [])
            if not (speed != "full" and d == "no-reranker") and not (speed == "lexical" and d == "no-embedder")
        ]
        warnings = list(p.warnings)
        if degraded:
            warnings.append({"code": "recall-degraded", "message": f"recall degraded ({', '.join(degraded)})."})
        temporal = r.get("temporal")
        if view.get("mode") is not None and temporal is None:
            warnings.append(
                {
                    "code": "time-mode-unreported",
                    "message": f'the store did not report the time mode, so "{view["mode"]}" may not have been applied; these may be current facts.',
                }
            )
        return {
            "memories": [_recalled(m, now) for m in r["memories"]],
            "abstained": r.get("abstained") is True,
            "temporal": temporal if isinstance(temporal, Mapping) else {"mode": view.get("mode") or "current", "inferred": False},
            "read": list(r.get("read") or []),
            "degraded": degraded,
            "warnings": warnings,
        }

    def _observe_view(self, r: Any, p: "CloudPrincipal") -> Dict[str, Any]:
        if not isinstance(r, Mapping):
            raise OortInternalError("An internal error stopped this call (TypeError).")
        oc = lambda s: s if s in _OUTCOMES else "added"  # noqa: E731
        out: Dict[str, Any] = {
            "outcome": oc(r.get("outcome")),
            "memories": [
                {"outcome": oc(m.get("action")), **({"id": m["id"]} if m.get("id") is not None else {})}
                for m in (r.get("memories") or [])
                if isinstance(m, Mapping)
            ],
            "counts": {k: v for k, v in (r.get("counts") or {}).items() if k in _OUTCOMES},
            "warnings": list(p.warnings),
        }
        if r.get("duplicate") is True:
            out["duplicate"] = True
        return out

    def observe(self, p: "CloudPrincipal", t: Mapping[str, Any]) -> Dict[str, Any]:
        self._refuse_star(p)
        obs: Dict[str, Any] = {
            "user": t["user"],
            "assistant": t["assistant"],
            "at": iso(t["at"]) if t.get("at") is not None else iso_now(self.now_ms()),
        }
        if t.get("sessionId") is not None:
            obs["session"] = t["sessionId"]
        if t.get("tools"):
            obs["tools"] = [_truncate_utf8(x, 512) for x in t["tools"][:16]]
        body: Dict[str, Any] = {**self._project(p)}
        if t.get("turnRef") is not None:
            body["turnRef"] = t["turnRef"]
        body["observation"] = obs
        return self._observe_view(self._call("POST", "/v1/observe", body), p)

    def remember(self, p: "CloudPrincipal", facts: List[str], type_: Optional[str]) -> Dict[str, Any]:
        self._refuse_star(p)
        hint = "" if type_ is None else f" (a {type_} fact)"
        results = []
        for i, fact in enumerate(facts):
            r = self._call(
                "POST",
                "/v1/observe",
                {
                    **self._project(p),
                    "observation": {
                        "user": f"Remember this{hint}: {fact}",
                        "assistant": f"Noted: {fact}",
                        "at": iso_now(self.now_ms()),
                    },
                },
            )
            v = self._observe_view(r, p)
            first = (r.get("memories") or [{}])[0] if isinstance(r, Mapping) else {}
            item: Dict[str, Any] = {"fact": i, "outcome": v["outcome"]}
            if isinstance(first, Mapping) and first.get("id") is not None:
                item["id"] = first["id"]
            if v["outcome"] == "skipped":
                item["reason"] = "not durable"
            results.append(item)
        return {"results": results, "warnings": list(p.warnings)}

    def forget(self, p: "CloudPrincipal", ref: str, everywhere: bool) -> Dict[str, Any]:
        self._refuse_star(p)
        if everywhere and self.user is not None:
            # Constellation copies are the account's: an end user has none (the API refuses it too).
            raise OortUsageError(
                "forget(everywhere=True) withdraws the account's Constellation copies; an end user has none. Leave everywhere out.",
                reason="user-not-supported",
            )
        if everywhere:
            target = self._everywhere_target(ref)
            r = self.c.call("DELETE", _id_path(target) + "?everywhere=1") or {}
            ids = lambda v: [x for x in v if isinstance(x, str)] if isinstance(v, list) else []  # noqa: E731
            return {
                "forgotten": target,
                "withdrawn": ids(r.get("withdrawn")),
                "requested": ids(r.get("requested")),
                "unreachable": ids(r.get("unreachable")),
            }
        m = self._find(ref)
        self._call("DELETE", _id_path(m["id"]))
        return {"forgotten": m["id"]}

    def _everywhere_target(self, ref: str) -> str:
        """As ``oort forget --everywhere``: a memory already forgotten is still found, by its full
        id, through the edges its shared copies left."""
        try:
            m = find_memory(self.c, ref)
        except OortNotFoundError as e:
            if not _FULL_ID.match(ref):
                raise
            try:
                shares = (self.c.call("GET", _id_path(ref) + "/shares") or {}).get("shares") or []
            except OortNotFoundError:
                raise e from None
            live = [s for s in shares if isinstance(s, Mapping) and s.get("withdrawnAt") is None]
            if not live:
                raise e from None
            return ref
        self.c.call("GET", _id_path(m["id"]) + "/shares")
        return m["id"]

    def pin(self, p: "CloudPrincipal", ref: str, pinned: bool) -> Dict[str, Any]:
        self._refuse_star(p)
        m = self._find(ref)
        self._call("POST", _id_path(m["id"]) + ("/pin" if pinned else "/unpin"))
        return {"id": m["id"], "pinned": pinned, "changed": None}

    def recent(self, p: "CloudPrincipal", since: Optional[Any], limit: int) -> Dict[str, Any]:
        now = self.now_ms()
        start = -math.inf if since is None else _ms(iso(since))
        seen: List[Mapping[str, Any]] = []
        cursor: Optional[str] = None
        truncated = False
        page = 0
        while True:
            if page * 100 >= RECENT_SCAN:
                truncated = True
                break
            q: Dict[str, Any] = {}
            if p.project is not None:
                q["project"] = p.project
            q["limit"] = 100
            if cursor is not None:
                q["cursor"] = cursor
            r = self._call("GET", "/v1/memories?" + urllib.parse.urlencode(q)) or {}
            mems = [m for m in (r.get("memories") or []) if isinstance(m, Mapping)]
            seen.extend(mems)
            nxt = r.get("next")
            if nxt is None or not mems:
                break
            cursor = nxt
            page += 1
        kept = sorted(
            (m for m in seen if _ms(m.get("updatedAt") or "") >= start),
            key=lambda m: _ms(m.get("updatedAt") or ""),
            reverse=True,
        )[:limit]
        warnings = (
            [{"code": "recent-truncated", "message": f"only the first {RECENT_SCAN} memories were scanned; older ones may be missing."}]
            if truncated
            else []
        )
        return {"memories": [memory_view(m, now) for m in kept], "warnings": warnings}

    def explain(self, p: "CloudPrincipal", ref: str) -> Dict[str, Any]:
        now = self.now_ms()
        m = self._find(ref)
        chain = []
        hidden = 0
        for link in (m.get("supersedes"), m.get("supersededBy")):
            if link is None:
                continue
            try:
                lk = self._find(link)
            except OortNotFoundError:
                hidden += 1
                continue
            chain.append(
                {
                    "id": lk.get("id"),
                    "text": _clean(lk.get("text")),
                    "validFrom": lk.get("validFrom"),
                    "validTo": lk.get("validTo"),
                    "endReason": lk.get("endReason"),
                }
            )
        source = m.get("source") if isinstance(m.get("source"), Mapping) else {}
        return {
            "memory": {
                **memory_view(m, now),
                "salience": m.get("salience") or 0,
                "activation": _activation(m, now),
                "source": source.get("harness"),
            },
            "decisions": [
                {
                    "stage": d.get("stage"),
                    "question": _clean(d.get("question")),
                    "answer": _clean(d.get("answer")),
                    "probability": d.get("probability"),
                }
                for d in (source.get("decisions") or [])
                if isinstance(d, Mapping)
            ],
            "chain": chain,
            "hiddenLinks": hidden,
        }

    def whoami(self, p: "CloudPrincipal") -> Dict[str, Any]:
        route = "/v1/whoami" + ("" if p.agent is None else "?agent=" + urllib.parse.quote(p.agent, safe=""))
        me = self.c.call("GET", route) or {}
        routes = {"embed": "cloud", "rerank": "cloud", "decide": "cloud", "write": "cloud"}
        if self.user is not None:
            # An end user's handle reads and writes their Planet alone, never the account's spaces.
            planet = f"Planet {self.user}"
            return {
                "mode": "cloud",
                "account": me.get("account"),
                "agent": p.agent,
                "project": p.project,
                "user": self.user,
                "reads": [planet],
                "writesTo": planet,
                "version": __version__,
                "routes": routes,
            }
        spaces = me.get("spaces") if isinstance(me.get("spaces"), list) else [{"level": "planet"}]
        return {
            "mode": "cloud",
            "account": me.get("account"),
            "agent": p.agent,
            "project": p.project,
            "user": None,
            "reads": [
                "your Planet" if s.get("level") == "planet" else f"Constellation {_clean(s.get('name'))}"
                for s in spaces
                if isinstance(s, Mapping)
            ],
            "writesTo": "your Planet",
            "version": __version__,
            "routes": routes,
        }

    # The account's end users (CON-132): sent as the account, after the same capability check.
    def erase_end_user(self, user: str) -> Dict[str, Any]:
        self.c.require_end_users()
        r = self.c.call("DELETE", "/v1/end-users/" + urllib.parse.quote(user, safe="")) or {}
        e = r.get("erased") if isinstance(r, Mapping) and isinstance(r.get("erased"), Mapping) else {}
        n = lambda v: v if isinstance(v, int) and not isinstance(v, bool) else 0  # noqa: E731
        return {
            "erased": user,
            "memories": n(e.get("memories")),
            "coldCopies": n(e.get("coldCopies")),
            "turnRefs": n(e.get("turnRefs")),
            "cursors": n(e.get("cursors")),
        }

    def count_end_users(self) -> Dict[str, Any]:
        self.c.require_end_users()
        r = self.c.call("GET", "/v1/end-users/count")
        if not isinstance(r, Mapping):
            raise OortInternalError("An internal error stopped this call (TypeError).")
        return {"endUsers": r.get("endUsers"), "limit": r.get("limit")}


def local_only(what: str) -> OortError:
    return OortRefusedError(
        f"{what} is local-only for now: Oort Cloud does not hold it yet. Use mode='local'.",
        fix="oort cloud use --local",
        reason="local-only",
    )


def iso_now(now_ms: float) -> str:
    from datetime import datetime, timezone

    d = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(now_ms) % 1000:03d}Z"


def _truncate_utf8(s: str, n: int) -> str:
    b = s.encode("utf-8")
    if len(b) <= n:
        return s
    return b[:n].decode("utf-8", "ignore")


class CloudPrincipal:
    """A cloud handle's fixed scope: project, its stated privacy, agent, Star, warnings."""

    __slots__ = ("project", "stated_privacy", "agent", "star", "warnings")

    def __init__(self, project: Optional[str], stated_privacy: Optional[bool], agent: Optional[str], star: bool, warnings: List[Dict[str, str]]) -> None:
        self.project = project
        self.stated_privacy = stated_privacy
        self.agent = agent
        self.star = star
        self.warnings = warnings
