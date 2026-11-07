"""HTTP/1.1 for the client, standard library only: over the daemon's Unix socket (local mode),
over TCP (remote mode, a service's token) and over TLS (Oort Cloud). Redirects are never
followed (``http.client`` does not), and bodies are capped."""

from __future__ import annotations

import http.client
import os
import socket
import ssl
import threading
import urllib.parse
from dataclasses import dataclass
from typing import Dict, Mapping, Optional, Tuple

__all__ = ["Response", "UnixTransport", "TcpTransport", "DaemonOutdated", "Unreachable"]

#: The largest response read (a recall of 50 memories is far below this).
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
USER_AGENT_PREFIX = "oortmem-python/"


@dataclass(frozen=True)
class Response:
    status: int
    headers: Dict[str, str]
    body: bytes


class DaemonOutdated(Exception):
    """The socket answered, but not in HTTP: a daemon from before the memory protocol."""


class Unreachable(Exception):
    """No answer: connection refused or reset, DNS, or a timeout (``timeout`` is True)."""

    def __init__(self, what: str, timeout: bool = False) -> None:
        super().__init__(what)
        self.timeout = timeout


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float) -> None:
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.settimeout(self.timeout)
            s.connect(self._path)
        except BaseException:
            s.close()
            raise
        self.sock = s


def _read(conn: http.client.HTTPConnection, method: str, path: str, headers: Mapping[str, str], body: Optional[bytes]) -> Response:
    conn.request(method, path, body=body, headers=dict(headers))
    r = conn.getresponse()
    data = r.read(MAX_RESPONSE_BYTES + 1)
    if len(data) > MAX_RESPONSE_BYTES:
        raise Unreachable("response too large")
    return Response(r.status, {k.lower(): v for k, v in r.getheaders()}, data)


def _send(
    conn: http.client.HTTPConnection,
    method: str,
    path: str,
    headers: Mapping[str, str],
    body: Optional[bytes],
) -> Response:
    try:
        return _read(conn, method, path, headers, body)
    except http.client.BadStatusLine as e:
        line = getattr(e, "line", "") or ""
        if isinstance(e, http.client.RemoteDisconnected) or line == "":
            raise Unreachable("the connection closed without an answer") from None
        raise DaemonOutdated() from None
    except (socket.timeout, TimeoutError):
        raise Unreachable("timed out", timeout=True) from None
    except (OSError, http.client.HTTPException):
        raise Unreachable("connection failed") from None


class UnixTransport:
    """One request per connection on the daemon's socket (connecting costs microseconds)."""

    def __init__(self, path: str, timeout: float) -> None:
        self.path = path
        self.timeout = timeout

    def request(self, method: str, path: str, headers: Mapping[str, str], body: Optional[bytes] = None) -> Response:
        conn = _UnixConnection(self.path, self.timeout)
        try:
            return _send(conn, method, path, {**headers, "Connection": "close"}, body)
        finally:
            conn.close()

    def close(self) -> None:
        pass


def _proxy_for(host: str, env: Mapping[str, str]) -> Optional[Tuple[str, int]]:
    """``HTTPS_PROXY`` for ``host``, unless ``NO_PROXY`` names it (or it is loopback)."""
    proxy = env.get("HTTPS_PROXY") or env.get("https_proxy")
    if not proxy or host in ("localhost", "127.0.0.1", "::1"):
        return None
    no = env.get("NO_PROXY") or env.get("no_proxy") or ""
    for entry in (x.strip().lower() for x in no.split(",")):
        if entry == "*":
            return None
        if entry and (host == entry.lstrip(".") or host.endswith("." + entry.lstrip("."))):
            return None
    u = urllib.parse.urlsplit(proxy if "://" in proxy else f"http://{proxy}")
    if u.hostname is None:
        return None
    return (u.hostname, u.port or 8080)


class TcpTransport:
    """HTTP or HTTPS to one origin, a kept-alive connection per thread (TLS costs ~200 ms)."""

    def __init__(self, url: str, timeout: float, env: Mapping[str, str]) -> None:
        u = urllib.parse.urlsplit(url)
        self.scheme = u.scheme
        self.host = u.hostname or ""
        self.port = u.port
        self.base = u.path.rstrip("/")
        self.timeout = timeout
        self._env = dict(env)
        self._local = threading.local()
        self._ctx: Optional[ssl.SSLContext] = None
        if self.scheme == "https":
            ctx = ssl.create_default_context()
            extra = env.get("NODE_EXTRA_CA_CERTS")
            if extra and os.path.isfile(extra):
                ctx.load_verify_locations(cafile=extra)
            self._ctx = ctx
        self._conns: "list[http.client.HTTPConnection]" = []
        self._lock = threading.Lock()

    def _connection(self) -> http.client.HTTPConnection:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            return conn
        proxy = _proxy_for(self.host, self._env) if self.scheme == "https" else None
        if self.scheme == "https":
            if proxy is not None:
                conn = http.client.HTTPSConnection(proxy[0], proxy[1], timeout=self.timeout, context=self._ctx)
                conn.set_tunnel(self.host, self.port or 443)
            else:
                conn = http.client.HTTPSConnection(self.host, self.port, timeout=self.timeout, context=self._ctx)
        else:
            conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        self._local.conn = conn
        with self._lock:
            self._conns.append(conn)
        return conn

    def _drop(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    def request(self, method: str, path: str, headers: Mapping[str, str], body: Optional[bytes] = None) -> Response:
        full = self.base + path
        for attempt in (0, 1):
            conn = self._connection()
            try:
                return _send(conn, method, full, headers, body)
            except Unreachable as e:
                self._drop()
                # A kept-alive connection the server closed while idle: one fresh try, but only
                # for a request that cannot have done anything twice (no body sent, a read).
                if attempt == 0 and not e.timeout and method == "GET":
                    continue
                raise
            except DaemonOutdated:
                self._drop()
                raise
        raise Unreachable("connection failed")  # pragma: no cover

    def close(self) -> None:
        with self._lock:
            for c in self._conns:
                c.close()
            self._conns.clear()
