"""Local and remote mode: the memory protocol of ``oort serve`` (CON-108 section 8.1), HTTP/1.1
with JSON, on the daemon's Unix socket (local) or a service's TCP listener with a token (remote).

The daemon runs the TypeScript SDK for every request, so arguments, limits, grants and errors are
the SDK's. This module only sends the handle's scope as headers and reads the ``oort.v1``
envelope back.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.parse
from typing import Any, Callable, Dict, List, Mapping, Optional

from . import __version__
from ._daemon import find_oort, socket_path_for, socket_trust, start_daemon
from ._secret import _Secret
from ._transport import DaemonOutdated, TcpTransport, UnixTransport, Unreachable
from .errors import OortError, OortInternalError, OortNetworkError, OortUsageError, error_from_envelope

PROTOCOL = 1
#: How long autostart waits for the new daemon to answer.
START_WAIT_S = 5.0


def outdated() -> OortError:
    return OortUsageError(
        "The oort serve running for this Oort home is older than the memory protocol (0.7): stop it with `oort serve stop`; the next call starts a current one.",
        fix="oort serve stop",
        reason="daemon-outdated",
    )


def node_missing() -> OortError:
    return OortUsageError(
        "Local mode runs the engine in `oort serve`, which needs Node.js 22.15 or newer and the oort CLI (`npm install -g oortmem`); none was found. Install Node, or use mode='cloud' or mode='remote'.",
        fix=None,
        reason="node-missing",
    )


class DaemonClient:
    """One daemon connection target: the socket (local) or a TCP URL with a token (remote)."""

    def __init__(
        self,
        *,
        home: str,
        env: Mapping[str, str],
        timeout: float,
        autostart: bool,
        url: Optional[str] = None,
        token: Optional[_Secret] = None,
        find: Callable[..., Optional[List[str]]] = find_oort,
        start: Callable[..., None] = start_daemon,
    ) -> None:
        self.home = home
        self.remote = url is not None
        self._env = env
        self._autostart = autostart and url is None
        self._token = token
        self._find = find
        self._start = start
        self._lock = threading.Lock()
        self._ready = False
        self.version: Optional[str] = None
        self.capabilities: List[str] = []
        if url is not None:
            self._http: Any = TcpTransport(url, timeout, env)
            self.socket: Optional[str] = None
        else:
            self.socket = socket_path_for(home, env)
            self._http = UnixTransport(self.socket, timeout)

    def __repr__(self) -> str:
        return f"DaemonClient(socket={self.socket!r})" if self.socket else "DaemonClient(remote)"

    # --- connecting -----------------------------------------------------------------------

    def _raw(self, method: str, path: str, headers: Mapping[str, str], body: Optional[bytes]):
        if self.socket is not None:
            trust = socket_trust(self.socket)
            if trust == "untrusted":
                raise OortUsageError(
                    "The daemon's socket (or its directory) is not this user's alone; refusing to connect. `oort doctor` names the problem.",
                    fix="oort doctor",
                    reason="socket-untrusted",
                )
            if trust == "absent":
                raise Unreachable("no socket")
        h = {"User-Agent": f"oortmem-python/{__version__}", "Accept": "application/json", **headers}
        if self._token is not None:
            h["Authorization"] = f"Bearer {self._token.reveal()}"
        return self._http.request(method, path, h, body)

    def _health(self) -> None:
        try:
            r = self._raw("GET", "/v1/health", {}, None)
        except DaemonOutdated:
            raise outdated() from None
        env = _envelope(r.body)
        if r.status != 200 or not isinstance(env, Mapping) or env.get("ok") is not True:
            if isinstance(env, Mapping) and env.get("ok") is False:
                raise error_from_envelope(env.get("error"))
            raise outdated()
        data = env.get("data") or {}
        if data.get("protocol") != PROTOCOL:
            raise outdated()
        self.version = data.get("version") if isinstance(data.get("version"), str) else None
        self.capabilities = [c for c in data.get("capabilities") or [] if isinstance(c, str)]

    def _connect(self) -> None:
        with self._lock:
            if self._ready:
                return
            try:
                self._health()
            except Unreachable:
                if not self._autostart:
                    raise OortNetworkError(
                        "No oort serve answers here."
                        + (" Start one with `oort serve --detach`." if not self.remote else ""),
                        fix=None if self.remote else "oort serve --detach",
                        reason="unreachable",
                    ) from None
                cmd = self._find(self.home, self._env)
                if cmd is None:
                    raise node_missing() from None
                self._start(cmd, self._env, self.home)
                deadline = time.monotonic() + START_WAIT_S
                while True:
                    try:
                        self._health()
                        break
                    except Unreachable:
                        if time.monotonic() > deadline:
                            raise OortNetworkError(
                                "oort serve did not start; see ~/.oort/logs/serve.log, or run `oort serve --detach` to see why.",
                                fix="oort serve --detach",
                                reason="unreachable",
                            ) from None
                        time.sleep(0.1)
            self._ready = True

    # --- requests -------------------------------------------------------------------------

    def call(
        self,
        method: str,
        path: str,
        headers: Mapping[str, str],
        body: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        self._connect()
        if query:
            q = {k: _q(v) for k, v in query.items() if v is not None}
            if q:
                path = f"{path}?{urllib.parse.urlencode(q)}"
        h = dict(headers)
        payload = None
        if body is not None:
            h["Content-Type"] = "application/json"
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        try:
            r = self._raw(method, path, h, payload)
        except DaemonOutdated:
            raise outdated() from None
        except Unreachable as e:
            # The daemon went away (idle exit, an upgrade): the next call connects afresh.
            self._ready = False
            raise OortNetworkError(
                "oort serve did not answer" + (" in time." if e.timeout else "."),
                reason="timeout" if e.timeout else "unreachable",
            ) from None
        env = _envelope(r.body)
        if not isinstance(env, Mapping) or env.get("schema") != "oort.v1":
            raise OortInternalError("An internal error stopped this call (SyntaxError).")
        if env.get("ok") is True and isinstance(env.get("data"), Mapping):
            return dict(env["data"])
        raise error_from_envelope(env.get("error"))

    def close(self) -> None:
        self._http.close()


def _q(v: Any) -> str:
    if v is True:
        return "1"
    if v is False:
        return "0"
    return str(v)


def _envelope(body: bytes) -> Any:
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def quote_id(i: Any) -> str:
    return urllib.parse.quote(i if isinstance(i, str) else str(i), safe="")
