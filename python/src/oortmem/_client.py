"""``Oort`` and ``AsyncOort``: Oort memory from Python, with the TypeScript SDK's semantics.

A handle's scope (agent, end user, org, project, judge role) is fixed when it is made, and no
method takes a scope argument: ``scoped()`` derives a handle from trusted host code. Making a
handle does no I/O; the first call connects.
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Union

from ._cloud import CloudClient, CloudOps, CloudPrincipal, cloud_url, local_only
from ._daemon import home_from, unsupported_platform
from ._format import format_for_prompt
from ._keys import KEY_SOURCES, find_oort_key
from ._local import DaemonClient, quote_id
from ._project import CONFIGURED_ID_PREFIX, resolve_project, stated_privacy
from ._secret import _Secret
from ._validate import (
    check_agent,
    check_facts,
    check_id,
    check_name,
    check_query,
    check_recall,
    check_recent,
    check_turn,
    check_type,
    check_user,
    turn_wire,
    view_of,
    wire_date,
)
from .errors import (
    OortCloudOnlyError,
    OortError,
    OortInternalError,
    OortNeedsLoginError,
    OortRefusedError,
    OortUsageError,
)
from .types import (
    ConfirmResult,
    ConsolidateResult,
    EndUserCount,
    EndUserErasure,
    EndUserExport,
    Explanation,
    ForgetResult,
    JudgeResult,
    JudgmentList,
    ObserveResult,
    PinResult,
    RecallResult,
    RecentResult,
    RecordJudgmentView,
    RememberResult,
    Turn,
    Whoami,
    from_wire,
)

__all__ = ["Oort", "AsyncOort", "OortJudge", "AsyncOortJudge", "OortEndUsers", "AsyncOortEndUsers"]

MODES = ("auto", "local", "cloud", "remote")


class _Unset:
    __slots__ = ()

    def __repr__(self) -> str:
        return "<unset>"


UNSET: Any = _Unset()


def _usage(message: str, reason: str = "invalid-argument") -> OortUsageError:
    return OortUsageError(message, reason=reason)


def _not_in_mode(option: str, mode: str) -> OortUsageError:
    hint = {
        "local": " Local mode's engine runs in `oort serve`, which reads its own keys and config: set them in the daemon's environment or with `oort keys set`.",
    }.get(mode, "")
    return _usage(f"{option} is not an option in {mode} mode.{hint}")


class _Env(dict):
    """The environment a handle reads (keys among it): never shown by ``repr``."""

    def __repr__(self) -> str:
        return f"<environment: {len(self)} variables>"

    __str__ = __repr__


class _Root:
    """What a root handle and every handle ``scoped()`` derives from it share."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.closed = False
        self.mode: Optional[str] = None
        self.daemon: Optional[DaemonClient] = None
        self.cloud: Optional[CloudClient] = None
        self.executor: Optional[ThreadPoolExecutor] = None


class _Scope:
    """One handle's fixed principal."""

    __slots__ = ("agent", "user", "user_given", "agent_level", "org", "project", "cwd", "project_config", "judge_role", "operator")

    def __init__(self, **kw: Any) -> None:
        for k in self.__slots__:
            setattr(self, k, kw.get(k))

    def replace(self, **kw: Any) -> "_Scope":
        d = {k: getattr(self, k) for k in self.__slots__}
        d.update(kw)
        return _Scope(**d)


class Oort:
    """A handle on Oort memory.

    ``mode='auto'`` (the default) uses what ``oort setup`` chose on this machine
    (``$OORT_HOME/cloud.json``), else local. Services pass ``mode``, ``project`` (or ``None``) and,
    for end users, ``org`` explicitly.

    - ``local``: the engine runs in ``oort serve`` on this machine (Node 22.15+), reached over its
      Unix socket and started on first use (``autostart``).
    - ``cloud``: Oort Cloud over HTTPS with the Oort key (``api_key``, ``OORT_API_KEY``, or
      ``oort login``). No Node needed.
    - ``remote``: an ``oort serve --listen`` service, with its token (``token`` or
      ``OORT_SERVE_TOKEN``).
    """

    def __init__(
        self,
        *,
        mode: str = "auto",
        home: Optional[str] = None,
        cwd: Optional[str] = None,
        project: Any = UNSET,
        project_config: bool = True,
        agent: Optional[str] = None,
        user: Any = UNSET,
        agent_level: bool = False,
        org: Optional[str] = None,
        api_key: Optional[str] = None,
        key_sources: Optional[Sequence[str]] = None,
        url: Optional[str] = None,
        token: Optional[str] = None,
        judge_role: str = "agent",
        operator: Optional[str] = None,
        timeout: float = 30.0,
        autostart: bool = True,
        env: Optional[Mapping[str, str]] = None,
        _internals: Optional[Mapping[str, Any]] = None,
    ) -> None:
        if mode not in MODES:
            raise _usage("options: invalid field mode.")
        self._env: Dict[str, str] = _Env(os.environ if env is None else env)
        if home is not None:
            if not isinstance(home, str) or home == "":
                raise _usage("options: invalid field home.")
            self._env["OORT_HOME"] = home
        if not (isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and 0 < timeout <= 600):
            raise _usage("options: invalid field timeout.")
        if not isinstance(project_config, bool):
            raise _usage("options: invalid field project_config.")
        if not isinstance(autostart, bool):
            raise _usage("options: invalid field autostart.")
        if judge_role not in ("agent", "expert"):
            raise _usage("options: invalid field judge_role.")
        if operator is not None and not (
            isinstance(operator, str) and 1 <= len(operator.strip()) and len(operator) <= 128 and operator.isprintable() and operator.isascii()
        ):
            raise _usage("options: invalid field operator.")
        sources = list(KEY_SOURCES if key_sources is None else key_sources)
        if not all(s in KEY_SOURCES for s in sources):
            raise _usage("options: invalid field key_sources.")
        if api_key is not None and (not isinstance(api_key, str) or api_key == ""):
            raise _usage("options: invalid field api_key.")
        if api_key is not None and "explicit" not in sources:
            raise _usage(
                "api_key was given, but key_sources leaves out 'explicit', so it would be ignored; add 'explicit' to key_sources or drop api_key."
            )
        if project is not UNSET and project is not None:
            check_name("project", project)
        from_env = agent is None
        name = agent if agent is not None else (self._env.get("OORT_AGENT") or None)
        check_agent(name, from_env=from_env and name is not None)
        check_user(user, org, given=user is not UNSET, org_required=mode != "remote")
        if not isinstance(agent_level, bool):
            raise _usage("options: invalid field agent_level.")
        if agent_level and user is not UNSET:
            raise _usage("agent_level=True and user cannot both be given: an end user is not org-level memory.")
        self._home = home_from(self._env)
        self._options = {
            "mode": mode,
            "home": home,
            "url": url,
            # Presence only: the values live in _Secret holders, never as plain strings.
            "token": None if token is None else True,
            "api_key": None if api_key is None else True,
            "user_given": user is not UNSET,
            "agent_level": agent_level,
            "org": org,
            "judge_role": judge_role,
            "operator": operator,
            "cwd": cwd,
            "autostart": autostart,
        }
        self._sources = sources
        self._timeout = float(timeout)
        self._autostart = autostart
        self._internals = dict(_internals or {})
        self._api_key = None if api_key is None else _Secret(api_key)
        self._token = None if token is None else _Secret(token)
        self._url = url
        self._root = _Root()
        self._is_root = True
        self._scope = _Scope(
            agent=name,
            user=None if user is UNSET else user,
            user_given=user is not UNSET,
            agent_level=agent_level,
            org=org,
            project=project,
            cwd=os.path.abspath(cwd) if cwd is not None else os.getcwd(),
            project_config=project_config,
            judge_role=judge_role,
            operator=operator,
        )
        if mode != "auto":
            self._check_mode(mode)
        self._judge = OortJudge(self)

    # --- modes ------------------------------------------------------------------------------

    def _check_mode(self, mode: str) -> None:
        """An option the mode does not take is a usage error, never silently ignored."""
        o = self._options
        explicit = o["mode"] == mode
        if o["agent_level"] and mode != "remote":
            raise _not_in_mode("agent_level", mode)
        if mode == "local":
            for k in ("url", "token", "api_key"):
                if o[k] is not None:
                    raise _not_in_mode(k, mode)
            if unsupported_platform():
                raise _usage(
                    "Local mode is not supported on Windows: use mode='cloud', or mode='remote' against an oort serve service.",
                    "node-missing",
                )
            return
        if mode == "cloud":
            # user and org take the local rules (CON-132): the key's account is the tenant, and
            # org is the host's name for it (not sent), still required with user.
            if o["token"] is not None:
                raise _not_in_mode("token", mode)
            if o["judge_role"] != "agent" or o["operator"] is not None:
                raise _not_in_mode("judge_role", mode)
            if explicit and o["home"] is not None:
                raise _not_in_mode("home", mode)
            cloud_url(self._url if self._url is not None else self._env.get("OORT_CLOUD_URL"))
            return
        # remote: an oort serve service; the token decides the org, and the service has no cwd.
        for k in ("api_key", "org", "cwd", "home"):
            if o[k] is not None:
                raise _not_in_mode(k, mode)
        if not o["user_given"] and not o["agent_level"]:
            raise _usage(
                "mode='remote' needs user= (the end user whose Planet this is) or agent_level=True (deliberate org-level or agent-level memory): a service acts for no one by default.",
                "user-missing",
            )
        if o["judge_role"] != "agent":
            raise _usage(
                "judge_role='expert' is refused in remote mode: a service token is not a person.", "expert-only"
            )
        self._remote_url()

    def _remote_url(self) -> str:
        import urllib.parse

        url = self._url
        if not url:
            raise _usage("mode='remote' needs url (the oort serve --listen address).")
        u = urllib.parse.urlsplit(url)
        host = u.hostname or ""
        if u.scheme not in ("http", "https") or not host or u.username or u.password or u.query or u.fragment:
            raise _usage("url must be an http(s) URL with no credentials or query.")
        loopback = host in ("localhost", "::1") or host.startswith("127.")
        if u.scheme == "http" and not loopback:
            raise _usage(
                "The service token is never sent over plain http to another host: use https (a TLS proxy in front of oort serve), or 127.0.0.1."
            )
        return url

    def _mode(self) -> str:
        """The mode, resolved once (``auto`` reads ``$OORT_HOME/cloud.json``)."""
        root = self._root
        if root.mode is not None:
            return root.mode
        with root.lock:
            if root.mode is None:
                m = self._options["mode"]
                if m == "auto":
                    m = "cloud" if _store_is_cloud(self._home) else "local"
                    self._check_mode(m)
                root.mode = m
        return root.mode  # type: ignore[return-value]

    @property
    def mode(self) -> str:
        """``local``, ``cloud`` or ``remote`` (``auto`` resolves on first use)."""
        return self._mode()

    def _daemon(self) -> DaemonClient:
        root = self._root
        if root.daemon is None:
            with root.lock:
                if root.daemon is None:
                    remote = root.mode == "remote"
                    token = self._token
                    if remote and token is None:
                        t = self._env.get("OORT_SERVE_TOKEN", "")
                        if not t:
                            raise OortNeedsLoginError(
                                "mode='remote' needs the service token: pass token=, or set OORT_SERVE_TOKEN.",
                                fix=None,
                                reason="no-key",
                            )
                        token = _Secret(t)
                    kw: Dict[str, Any] = {}
                    for k in ("find", "start"):
                        if k in self._internals:
                            kw[k] = self._internals[k]
                    root.daemon = DaemonClient(
                        home=self._home,
                        env=self._env,
                        timeout=self._timeout,
                        autostart=self._autostart,
                        url=self._remote_url() if remote else None,
                        token=token if remote else None,
                        **kw,
                    )
        return root.daemon

    def _cloud(self) -> CloudOps:
        root = self._root
        if root.cloud is None:
            with root.lock:
                if root.cloud is None:
                    url = cloud_url(self._url if self._url is not None else self._env.get("OORT_CLOUD_URL"))
                    key = find_oort_key(
                        explicit=None if self._api_key is None else self._api_key.reveal(),
                        env=self._env,
                        home=self._home,
                        sources=self._sources,
                        keychain=self._internals.get("keychain"),
                    )
                    if key is None:
                        raise OortNeedsLoginError(
                            "Cloud mode needs the Oort key: run `oort login`, or pass api_key=.",
                            fix="oort login",
                            reason="no-key",
                        )
                    root.cloud = CloudClient(url, key, self._timeout, self._env)
        s = self._scope
        # An end user's handle names them on every memory call (Oort-User, CON-132).
        return CloudOps(root.cloud, self._now_ms, s.user if s.user_given else None)

    def _now_ms(self) -> float:
        now = self._internals.get("now")
        return float(now()) if now is not None else time.time() * 1000

    def _principal(self) -> CloudPrincipal:
        s = self._scope
        cwd_project = resolve_project(s.cwd, self._home)
        if s.project is UNSET:
            project = cwd_project
        elif s.project is None:
            project = None
        else:
            project = CONFIGURED_ID_PREFIX + s.project
        privacy = stated_privacy(s.cwd) if s.project_config and project is not None and project == cwd_project else None
        star = s.agent is not None and _agent_is_star(self._home, s.agent)
        if star and s.user_given:
            raise OortRefusedError(
                "This agent is configured as a Star, and a Star is shared by every user of the agent; an end-user handle gets their Planet only. Use an agent that writes the Planet (`oort connect <agent> --no-star`).",
                reason="star-with-user",
            )
        return CloudPrincipal(project, privacy, s.agent, star, [])

    def _headers(self) -> Dict[str, str]:
        s = self._scope
        remote = self._root.mode == "remote"
        h: Dict[str, str] = {}
        if not remote:
            import urllib.parse

            h["Oort-Cwd"] = urllib.parse.quote(s.cwd, safe="/")
            if not s.project_config:
                h["Oort-Project-Config"] = "0"
        if s.project is not UNSET:
            h["Oort-Project"] = "-" if s.project is None else s.project
        elif remote:
            h["Oort-Project"] = "-"
        if s.agent is not None:
            h["Oort-Agent"] = s.agent
        if s.user_given:
            h["Oort-User"] = s.user
        elif remote:
            h["Oort-User"] = "-"  # agent_level=True: deliberate org-level memory
        if s.org is not None and not remote:
            h["Oort-Org"] = s.org
        if s.judge_role == "expert":
            h["Oort-Judge-Role"] = "expert"
            if s.operator is not None:
                h["Oort-Operator"] = s.operator
        return h

    def _run(self, local: Callable[[DaemonClient, Dict[str, str]], Any], cloud: Optional[Callable[[CloudOps, CloudPrincipal], Any]]) -> Any:
        if self._root.closed:
            raise OortUsageError("This Oort handle is closed.", reason="closed")
        try:
            mode = self._mode()
            if mode == "cloud":
                if cloud is None:
                    raise OortInternalError("unreachable: no cloud operation")
                return cloud(self._cloud(), self._principal())
            return local(self._daemon(), self._headers())
        except OortError:
            raise
        except (TypeError, ValueError, KeyError, AttributeError) as e:
            raise OortInternalError(f"An internal error stopped this call ({type(e).__name__}).") from None

    # --- memory -----------------------------------------------------------------------------

    def recall(
        self,
        query: str,
        *,
        limit: int = 10,
        mode: Optional[str] = None,
        as_of: Any = None,
        known_at: Any = None,
        include: Optional[Sequence[str]] = None,
        budget_chars: Optional[int] = None,
        include_withdrawn: bool = False,
        speed: str = "full",
        infer_time: bool = True,
    ) -> RecallResult:
        """Recall memories for ``query``: the person's Planet (and this agent's Star) for the
        project and global memories. ``mode`` picks a temporal view (``as-of`` with ``as_of``,
        ``known-at`` with ``known_at``, ``history``); with neither date nor mode, a date in the
        query ("on 2 April") picks one unless ``infer_time=False``."""
        opts: Dict[str, Any] = {
            "limit": limit,
            "mode": mode,
            "asOf": wire_date(as_of),
            "knownAt": wire_date(known_at),
            "include": None if include is None else list(include),
            "budgetChars": budget_chars,
            "includeWithdrawn": include_withdrawn,
            "speed": speed,
            "inferTime": infer_time,
        }
        opts = {k: v for k, v in opts.items() if v is not None}

        def local(d: DaemonClient, h: Dict[str, str]) -> RecallResult:
            data = d.call("POST", "/v1/recall", h, {"query": query, **opts})
            return _recall_result(data, budget_chars)

        def cloud(c: CloudOps, p: CloudPrincipal) -> RecallResult:
            q = check_query(query)
            check_recall(opts)
            return _recall_result(c.recall(p, q, opts, view_of(opts)), budget_chars)

        return self._run(local, cloud)

    def observe(self, turn: Union[Turn, Mapping[str, Any], None] = None, /, **fields: Any) -> ObserveResult:
        """Run the write path on one turn: ``observe(user=..., assistant=...)``, or a ``Turn`` /
        mapping (``user``, ``assistant``, ``tools``, ``at``, ``session_id``, ``turn_ref``). It
        scrubs, gates, writes and reconciles, and can take seconds: call it after answering."""
        if turn is not None and fields:
            raise _usage("observe takes a turn or its fields, not both.")
        t = turn_wire(turn if turn is not None else fields)

        def cloud(c: CloudOps, p: CloudPrincipal) -> ObserveResult:
            check_turn(t)
            return from_wire(ObserveResult, c.observe(p, t))

        return self._run(lambda d, h: from_wire(ObserveResult, d.call("POST", "/v1/observe", h, t)), cloud)

    def remember(self, facts: Union[str, Sequence[str]], *, type: Optional[str] = None) -> RememberResult:  # noqa: A002
        """Save up to 5 facts (500 characters each) through the write path, each framed as
        something the user said."""
        lst = [facts] if isinstance(facts, str) else facts
        body: Dict[str, Any] = {"facts": list(lst) if isinstance(lst, (list, tuple)) else lst}
        if type is not None:
            body["type"] = type

        def cloud(c: CloudOps, p: CloudPrincipal) -> RememberResult:
            fs = check_facts(facts)
            check_type(type)
            return from_wire(RememberResult, c.remember(p, fs, type))

        return self._run(lambda d, h: from_wire(RememberResult, d.call("POST", "/v1/remember", h, body)), cloud)

    def forget(self, id: str, *, everywhere: bool = False) -> ForgetResult:  # noqa: A002
        """Forget a memory (a full id, or a unique prefix of at least 8 characters).
        ``everywhere=True`` (cloud) also withdraws its shared Constellation copies."""

        def cloud(c: CloudOps, p: CloudPrincipal) -> ForgetResult:
            ref = check_id(id)
            if not isinstance(everywhere, bool):
                raise _usage("forget options: invalid field everywhere.")
            return from_wire(ForgetResult, c.forget(p, ref, everywhere))

        return self._run(
            lambda d, h: from_wire(
                ForgetResult,
                d.call("DELETE", f"/v1/memories/{quote_id(id)}", h, query={"everywhere": everywhere or None}),
            ),
            cloud,
        )

    def pin(self, id: str) -> PinResult:  # noqa: A002
        """Keep a memory out of cold storage. ``changed`` is ``None`` in cloud mode."""
        return self._pin(id, True)

    def unpin(self, id: str) -> PinResult:  # noqa: A002
        return self._pin(id, False)

    def _pin(self, id: str, pinned: bool) -> PinResult:  # noqa: A002
        verb = "pin" if pinned else "unpin"
        return self._run(
            lambda d, h: from_wire(PinResult, d.call("POST", f"/v1/memories/{quote_id(id)}/{verb}", h)),
            lambda c, p: from_wire(PinResult, c.pin(p, check_id(id), pinned)),
        )

    def recent(self, *, since: Any = None, limit: int = 20) -> RecentResult:
        """The newest memories, at most ``limit`` (1 to 100), changed at or after ``since``."""
        s = wire_date(since)

        def cloud(c: CloudOps, p: CloudPrincipal) -> RecentResult:
            check_recent(s, limit)
            return from_wire(RecentResult, c.recent(p, s, limit))

        return self._run(
            lambda d, h: from_wire(RecentResult, d.call("GET", "/v1/memories", h, query={"since": s, "limit": limit})),
            cloud,
        )

    def explain(self, id: str) -> Explanation:  # noqa: A002
        """Why a memory exists: its decisions, and the chain of memories it superseded."""
        return self._run(
            lambda d, h: from_wire(Explanation, d.call("GET", f"/v1/memories/{quote_id(id)}/explain", h)),
            lambda c, p: from_wire(Explanation, c.explain(p, check_id(id))),
        )

    def whoami(self) -> Whoami:
        """Which store, agent, user and spaces this handle reads and writes, and how each model
        role is served. Calls no model."""

        def local(d: DaemonClient, h: Dict[str, str]) -> Whoami:
            data = d.call("GET", "/v1/whoami", h)
            if self._root.mode == "remote":
                data["mode"] = "remote"
            return from_wire(Whoami, data)

        return self._run(local, lambda c, p: from_wire(Whoami, c.whoami(p)))

    def consolidate(self, *, budget_ms: Optional[int] = None) -> ConsolidateResult:
        """Tiers, expiry and cold eviction for this handle's principal (local only). Calls no
        model; a multi-user host runs it per end user."""
        body = {} if budget_ms is None else {"budgetMs": budget_ms}

        def cloud(c: CloudOps, p: CloudPrincipal) -> ConsolidateResult:
            raise local_only("Consolidation")

        return self._run(lambda d, h: from_wire(ConsolidateResult, d.call("POST", "/v1/consolidate", h, body)), cloud)

    @property
    def judge(self) -> "OortJudge":
        """Judgment memory: ``record``, ``apply``, ``list`` and ``confirm`` (local only)."""
        return self._judge

    @property
    def end_users(self) -> "OortEndUsers":
        """The account's end users in Oort Cloud (CON-132): ``erase(user)``, ``export(user)``
        (CON-137) and ``count()``.
        Cloud mode with a server key, on a handle not scoped to an end user."""
        return OortEndUsers(self)

    def _end_users_ops(self) -> CloudOps:
        """The account's cloud operations, for ``end_users``: never from an end user's handle."""
        if self._mode() != "cloud":
            raise OortCloudOnlyError(
                "end_users works on Oort Cloud end users. Locally, an end user lives under your org in your own store.",
                reason="end-users",
            )
        if self._scope.user_given:
            raise OortUsageError(
                "end_users acts for the account; this handle is scoped to an end user. Call it on the handle you made the end user's from.",
                reason="user-not-supported",
            )
        return CloudOps(self._cloud().c, self._now_ms)

    # --- handles ----------------------------------------------------------------------------

    def scoped(
        self,
        *,
        user: Any = UNSET,
        project: Any = UNSET,
        agent: Optional[str] = None,
        judge_role: Optional[str] = None,
    ) -> "Oort":
        """A handle sharing this one's connection, its scope narrowed: an end ``user`` (their
        Planet only, under this handle's org), another ``project`` (``None``: global only), another
        ``agent``, or ``judge_role='agent'``. Hand only such a handle to model-facing tools."""
        if self._root.closed:
            raise OortUsageError("This Oort handle is closed.", reason="closed")
        if judge_role is not None and judge_role != "agent":
            raise _usage("scoped options: invalid field judge_role.")
        if project is not UNSET and project is not None:
            check_name("project", project)
        check_agent(agent)
        s = self._scope
        if user is not UNSET:
            check_user(user, s.org, given=True, org_required=self._mode() != "remote")
            if s.user_given and user != s.user:
                # A handle for one end user never becomes another's (CON-132 hardening).
                raise OortUsageError(
                    "This handle is scoped to an end user and cannot switch to another: derive each end user's handle from the handle you made it from.",
                    reason="user-hop",
                )
        child = object.__new__(type(self))
        child.__dict__.update(self.__dict__)
        child._is_root = False
        child._scope = s.replace(
            **({"user": user, "user_given": True} if user is not UNSET else {}),
            **({"project": project} if project is not UNSET else {}),
            **({"agent": agent} if agent is not None else {}),
            **({"judge_role": "agent", "operator": None} if judge_role == "agent" else {}),
        )
        child._judge = OortJudge(child)
        return child

    def close(self) -> None:
        """Close the connections. Idempotent; on a derived handle it does nothing."""
        if not self._is_root or self._root.closed:
            return
        root = self._root
        root.closed = True
        if root.daemon is not None:
            root.daemon.close()
        if root.cloud is not None:
            root.cloud.close()
        if root.executor is not None:
            root.executor.shutdown(wait=False)

    def __enter__(self) -> "Oort":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _summary(self) -> Dict[str, Any]:
        s = self._scope
        return {
            "org": s.org or "local",
            "user": s.user if s.user_given else None,
            "agent": s.agent,
            "project": None if s.project is UNSET else s.project,
        }

    def __repr__(self) -> str:
        mode = self._root.mode or self._options["mode"]
        return f"Oort(mode={mode!r}, scope={self._summary()!r})"

    def __reduce__(self):
        raise TypeError("an Oort handle cannot be pickled")


class OortJudge:
    """Judgment memory (local only): an expert's decisions as precedents."""

    def __init__(self, oort: Oort) -> None:
        self._o = oort

    def record(
        self,
        *,
        subject: str,
        verdict: str,
        reason: str,
        domain: str,
        by: str,
        ref: Optional[str] = None,
        verdicts: Optional[Sequence[str]] = None,
        criteria: Optional[Sequence[str]] = None,
        decided_at: Any = None,
    ) -> RecordJudgmentView:
        """Record an expert's decision. In agent role (the default), ``by`` must be an expert in
        ``judge.experts``, it counts against the daily cap, and it is stored unconfirmed."""
        body = _drop_none(
            {
                "subject": subject,
                "verdict": verdict,
                "reason": reason,
                "domain": domain,
                "by": by,
                "ref": ref,
                "verdicts": None if verdicts is None else list(verdicts),
                "criteria": None if criteria is None else list(criteria),
                "decidedAt": wire_date(decided_at),
            }
        )
        return self._o._run(
            lambda d, h: from_wire(RecordJudgmentView, d.call("POST", "/v1/judgments", h, body)), _local_only("Judgments")
        )

    def apply(
        self,
        item: Union[str, Mapping[str, Any]],
        *,
        details: Optional[str] = None,
        domain: Optional[str] = None,
        by: Optional[str] = None,
        ref: Optional[str] = None,
        limit: Optional[int] = None,
        threshold: Optional[float] = None,
        min_similarity: Optional[float] = None,
        min_agreement: Optional[float] = None,
        include_imported: Optional[bool] = None,
        include_agent_recorded: Optional[bool] = None,
    ) -> JudgeResult:
        """Judge a new case by precedent: a prediction, never the expert's decision."""
        extra = _drop_none({"details": details, "domain": domain, "by": by, "ref": ref})
        if isinstance(item, Mapping):
            if extra:
                raise _usage("judge.apply takes an item mapping or its fields, not both.")
            wire_item: Any = {(_camel(k)): v for k, v in item.items()}
        else:
            wire_item = {"summary": item, **extra} if extra else item
        body = {
            "item": wire_item,
            **_drop_none(
                {
                    "limit": limit,
                    "threshold": threshold,
                    "minSimilarity": min_similarity,
                    "minAgreement": min_agreement,
                    "includeImported": include_imported,
                    "includeAgentRecorded": include_agent_recorded,
                }
            ),
        }
        return self._o._run(
            lambda d, h: from_wire(JudgeResult, d.call("POST", "/v1/judgments/apply", h, body)), _local_only("Judgments")
        )

    def list(
        self, *, domain: Optional[str] = None, by: Optional[str] = None, all: bool = False, limit: Optional[int] = None  # noqa: A002
    ) -> JudgmentList:
        q = {"domain": domain, "by": by, "all": all or None, "limit": limit}
        return self._o._run(
            lambda d, h: from_wire(JudgmentList, d.call("GET", "/v1/judgments", h, query=q)), _local_only("Judgments")
        )

    def confirm(self, id: str) -> ConfirmResult:  # noqa: A002
        """Confirm an agent's record of a judgment (expert role only)."""
        return self._o._run(
            lambda d, h: from_wire(ConfirmResult, d.call("POST", f"/v1/judgments/{quote_id(id)}/confirm", h)),
            _local_only("Judgments"),
        )


class OortEndUsers:
    """The account's end users in Oort Cloud (CON-132): per-user memory a server key writes with
    ``scoped(user=...)``. Requires Oort Cloud with server keys: refused with
    ``end-users-unsupported`` when whoami does not list the key's ``end-users`` capability."""

    def __init__(self, oort: Oort) -> None:
        self._o = oort

    def _run(self, fn: Callable[[CloudOps], Any]) -> Any:
        o = self._o
        if o._root.closed:
            raise OortUsageError("This Oort handle is closed.", reason="closed")
        try:
            return fn(o._end_users_ops())
        except OortError:
            raise
        except (TypeError, ValueError, KeyError, AttributeError) as e:
            raise OortInternalError(f"An internal error stopped this call ({type(e).__name__}).") from None

    def erase(self, user: str) -> EndUserErasure:
        """Erase an end user completely: every memory stored for them, with its indexes and cold
        copies. The account's own memory and every other end user are untouched; erasing one who
        has nothing is not an error. A write for them still in flight is refused
        (``end-user-erased``)."""
        # The same rules as scoped(user=...): never empty, never self, an explicit org.
        check_user(user, self._o._scope.org, given=True)
        return self._run(lambda c: from_wire(EndUserErasure, c.erase_end_user(user)))

    def export(self, user: str) -> EndUserExport:
        """Export an end user's memories (CON-137): every memory stored for them, in every tier
        and validity state, as Oort export JSON Lines. Nothing of the account's own memory or any
        other end user. Exporting one who was erased, or never had a memory, is not an error: the
        export is empty (``memories == 0``), the same either way."""
        check_user(user, self._o._scope.org, given=True)
        return self._run(lambda c: from_wire(EndUserExport, c.export_end_user(user)))

    def count(self) -> EndUserCount:
        """How many end users the account has, and its plan's limit."""
        return self._run(lambda c: from_wire(EndUserCount, c.count_end_users()))


def _local_only(what: str) -> Callable[[CloudOps, CloudPrincipal], Any]:
    def f(c: CloudOps, p: CloudPrincipal) -> Any:
        raise local_only(what)

    return f


def _camel(k: str) -> str:
    from .types import camel

    return camel(k) if "_" in k else k


def _drop_none(d: Mapping[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _recall_result(data: Mapping[str, Any], budget_chars: Optional[int]) -> RecallResult:
    r = from_wire(RecallResult, data)
    budget = budget_chars if budget_chars is not None else data.get("budgetChars")
    if isinstance(budget, int) and budget > 0:
        object.__setattr__(r, "budget_chars", budget)
    return r


def _store_is_cloud(home: str) -> bool:
    import json

    try:
        with open(os.path.join(home, "cloud.json"), "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return False
    return isinstance(raw, dict) and raw.get("store") == "cloud"


def _agent_is_star(home: str, agent: str) -> bool:
    import json

    try:
        with open(os.path.join(home, "agents.json"), "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return False
    agents = raw.get("agents") if isinstance(raw, dict) else None
    a = agents.get(agent) if isinstance(agents, dict) else None
    return isinstance(a, dict) and a.get("star") is True


# ---------------------------------------------------------------------------------------------
# asyncio


class AsyncOort:
    """``Oort`` for asyncio: the same methods, ``async def``. Calls run on a bounded thread pool
    (8 by default); cancelling one stops the wait, but a request already sent still runs."""

    def __init__(self, *, max_workers: int = 8, **options: Any) -> None:
        self._sync = Oort(**options)
        self._sync._root.executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="oortmem")
        self.judge = AsyncOortJudge(self)
        self.end_users = AsyncOortEndUsers(self)

    @classmethod
    def _wrap(cls, sync: Oort) -> "AsyncOort":
        a = object.__new__(cls)
        a._sync = sync
        a.judge = AsyncOortJudge(a)
        a.end_users = AsyncOortEndUsers(a)
        return a

    async def _call(self, fn: Callable[..., Any], *args: Any, **kw: Any) -> Any:
        loop = asyncio.get_running_loop()
        ex = self._sync._root.executor
        return await loop.run_in_executor(ex, lambda: fn(*args, **kw))

    @property
    def mode(self) -> str:
        return self._sync.mode

    async def recall(self, query: str, **kw: Any) -> RecallResult:
        return await self._call(self._sync.recall, query, **kw)

    async def observe(self, turn: Union[Turn, Mapping[str, Any], None] = None, /, **fields: Any) -> ObserveResult:
        return await self._call(self._sync.observe, turn, **fields)

    async def remember(self, facts: Union[str, Sequence[str]], **kw: Any) -> RememberResult:
        return await self._call(self._sync.remember, facts, **kw)

    async def forget(self, id: str, **kw: Any) -> ForgetResult:  # noqa: A002
        return await self._call(self._sync.forget, id, **kw)

    async def pin(self, id: str) -> PinResult:  # noqa: A002
        return await self._call(self._sync.pin, id)

    async def unpin(self, id: str) -> PinResult:  # noqa: A002
        return await self._call(self._sync.unpin, id)

    async def recent(self, **kw: Any) -> RecentResult:
        return await self._call(self._sync.recent, **kw)

    async def explain(self, id: str) -> Explanation:  # noqa: A002
        return await self._call(self._sync.explain, id)

    async def whoami(self) -> Whoami:
        return await self._call(self._sync.whoami)

    async def consolidate(self, **kw: Any) -> ConsolidateResult:
        return await self._call(self._sync.consolidate, **kw)

    def scoped(self, **kw: Any) -> "AsyncOort":
        return AsyncOort._wrap(self._sync.scoped(**kw))

    async def close(self) -> None:
        self._sync.close()

    async def __aenter__(self) -> "AsyncOort":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    def __repr__(self) -> str:
        return "Async" + repr(self._sync)


class AsyncOortJudge:
    def __init__(self, a: AsyncOort) -> None:
        self._a = a

    async def record(self, **kw: Any) -> RecordJudgmentView:
        return await self._a._call(self._a._sync.judge.record, **kw)

    async def apply(self, item: Union[str, Mapping[str, Any]], **kw: Any) -> JudgeResult:
        return await self._a._call(self._a._sync.judge.apply, item, **kw)

    async def list(self, **kw: Any) -> JudgmentList:
        return await self._a._call(self._a._sync.judge.list, **kw)

    async def confirm(self, id: str) -> ConfirmResult:  # noqa: A002
        return await self._a._call(self._a._sync.judge.confirm, id)


class AsyncOortEndUsers:
    """``OortEndUsers`` for asyncio."""

    def __init__(self, a: AsyncOort) -> None:
        self._a = a

    async def erase(self, user: str) -> EndUserErasure:
        return await self._a._call(self._a._sync.end_users.erase, user)

    async def export(self, user: str) -> EndUserExport:
        return await self._a._call(self._a._sync.end_users.export, user)

    async def count(self) -> EndUserCount:
        return await self._a._call(self._a._sync.end_users.count)


__all__ += ["format_for_prompt"]
