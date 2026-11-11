"""Unit and security tests for the native client, against a fake daemon (HTTP on a Unix socket)
and a fake Oort Cloud (HTTP on loopback). No network, no keys, no real Oort home."""

import asyncio
import http.server
import json
import os
import pickle
import socket
import socketserver
import stat
import sys
import tempfile
import threading
import unittest
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "python", "src"))

NEEDS_310 = unittest.skipIf(sys.version_info < (3, 10), "the client needs Python 3.10+")
POSIX = unittest.skipIf(os.name != "posix", "Unix sockets")

KEY = "oort_sk_" + "u" * 43
TOKEN = "t" * 43

RECALL = {
    "memories": [
        {
            "id": "11111111-0000-4000-8000-000000000001",
            "text": "We deploy on Fridays.",
            "type": "semantic",
            "tier": "warm",
            "pinned": False,
            "status": "current",
            "validFrom": "2026-11-01T00:00:00.000Z",
            "validTo": None,
            "recordedAt": "2026-11-01T00:00:00.000Z",
            "updatedAt": "2026-11-01T00:00:00.000Z",
            "entities": [],
            "score": 0.8,
            "why": {"coverage": 1, "activation": 0.1, "lexicalRank": 1},
            "someFutureField": {"x": 1},
        }
    ],
    "abstained": False,
    "temporal": {"mode": "current", "inferred": True},
    "read": ["your Planet"],
    "degraded": ["no-embedder"],
    "warnings": [{"code": "lexical-only", "message": "lexical-only recall."}],
    "budgetChars": 6000,
}
HEALTH = {"version": "0.7.0", "protocol": 1, "mode": "local", "capabilities": ["judgments", "consolidate"]}


def envelope(data=None, error=None):
    if error is not None:
        return {"schema": "oort.v1", "ok": False, "error": error}
    return {"schema": "oort.v1", "ok": True, "data": data, "warnings": []}


class Recorder:
    """The requests a fake saw, and what it answers per ``METHOD /path``."""

    def __init__(self) -> None:
        self.seen: List[Dict[str, Any]] = []
        self.answers: Dict[str, Any] = {"GET /v1/health": (200, envelope(HEALTH))}

    def answer(self, method: str, path: str) -> Any:
        key = f"{method} {path.split('?')[0]}"
        for k, v in self.answers.items():
            if k == key or (k.endswith("*") and key.startswith(k[:-1])):
                return v.pop(0) if isinstance(v, list) and len(v) > 1 else v[0] if isinstance(v, list) else v  # a list answers in turn
        return (404, envelope(error={"code": "usage", "message": "No such route.", "reason": "unknown-route"}))


def handler(rec: Recorder):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a: Any) -> None:
            pass

        def _do(self) -> None:
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            rec.seen.append(
                {
                    "method": self.command,
                    "path": self.path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": json.loads(body) if body else None,
                }
            )
            status, payload, *extra = rec.answer(self.command, self.path)
            headers = extra[0] if extra else {}
            data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            self.send_response(status)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_DELETE = _do

        def address_string(self) -> str:
            return "local"

    return H


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Sandbox:
    """A throwaway home (0700) and environment; never the real ~/.oort."""

    def __init__(self) -> None:
        # A short root: the socket path must fit a Unix socket's 103 bytes.
        self.tmp = tempfile.mkdtemp(prefix="oortpy-", dir="/tmp" if os.path.isdir("/tmp") else None)
        os.chmod(self.tmp, 0o700)
        self.home = os.path.join(self.tmp, "h")
        os.mkdir(self.home, 0o700)
        self.env = {"HOME": self.tmp, "OORT_HOME": self.home, "OORT_NO_KEYCHAIN": "1", "PATH": "/nonexistent"}

    def socket(self) -> str:
        from oortmem._daemon import socket_path_for

        return socket_path_for(self.home, self.env)

    def cleanup(self) -> None:
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)


class FakeDaemon:
    def __init__(self, path: str, rec: Recorder) -> None:
        self.server = UnixHTTPServer(path, handler(rec))
        os.chmod(path, 0o600)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class FakeCloud:
    def __init__(self, rec: Recorder) -> None:
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler(rec))
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@NEEDS_310
@POSIX
class LocalMode(unittest.TestCase):
    def setUp(self) -> None:
        self.box = Sandbox()
        self.rec = Recorder()
        self.daemon = FakeDaemon(self.box.socket(), self.rec)

    def tearDown(self) -> None:
        self.daemon.close()
        self.box.cleanup()

    def oort(self, **kw: Any):
        from oortmem import Oort

        env = {**self.box.env, **kw.pop("env", {})}
        return Oort(mode="local", env=env, autostart=False, **kw)

    def test_recall_sends_the_scope_as_headers_and_reads_typed_results(self) -> None:
        from oortmem.types import RecallResult

        self.rec.answers["POST /v1/recall"] = (200, envelope(RECALL))
        cwd = os.path.join(self.box.tmp, "a dir \u00e9")
        os.mkdir(cwd)
        with self.oort(cwd=cwd, env={"OORT_AGENT": "bot"}, project=None) as o:
            r = o.recall("how do we deploy?", limit=5, as_of="2026-04-01")
        self.assertIsInstance(r, RecallResult)
        self.assertEqual(r.memories[0].why.lexical_rank, 1)
        self.assertEqual(r.warnings[0].code, "lexical-only")
        self.assertEqual(r.budget_chars, 6000)
        req = self.rec.seen[-1]
        self.assertEqual(req["headers"]["oort-agent"], "bot")
        self.assertEqual(req["headers"]["oort-project"], "-")
        self.assertEqual(req["headers"]["oort-cwd"], "/".join(__import__("urllib.parse").parse.quote(p) for p in cwd.split("/")))
        self.assertNotIn("authorization", req["headers"])
        self.assertEqual(req["body"]["query"], "how do we deploy?")
        self.assertEqual(req["body"]["limit"], 5)
        self.assertEqual(req["body"]["asOf"], "2026-04-01")

    def test_end_users_judge_roles_and_derived_handles(self) -> None:
        self.rec.answers["GET /v1/whoami"] = (200, envelope({"mode": "local", "account": None, "agent": None, "project": None, "user": "u1", "reads": [], "writesTo": "Planet u1", "version": "0.7.0", "routes": {}}))
        with self.oort(org="acme", judge_role="expert", operator="ada") as root:
            root.scoped(user="u1", agent="support", judge_role="agent").whoami()
            h = self.rec.seen[-1]["headers"]
            self.assertEqual((h["oort-user"], h["oort-org"], h["oort-agent"]), ("u1", "acme", "support"))
            self.assertNotIn("oort-judge-role", h)
            root.whoami()
            h = self.rec.seen[-1]["headers"]
            self.assertEqual((h["oort-judge-role"], h["oort-operator"]), ("expert", "ada"))
            self.assertNotIn("oort-user", h)

    def test_scope_rules_hold_before_any_request(self) -> None:
        from oortmem import OortUsageError

        with self.assertRaises(OortUsageError) as e:
            self.oort(user="u1")
        self.assertEqual(e.exception.reason, "principal-required")
        with self.assertRaises(OortUsageError) as e:
            self.oort(user="u1", org="local")
        self.assertEqual(e.exception.reason, "principal-required")
        with self.assertRaises(OortUsageError) as e:
            self.oort(org="acme", user="")
        self.assertEqual(e.exception.reason, "user-missing")
        root = self.oort(org="acme")
        with self.assertRaises(OortUsageError) as e:
            root.scoped(user="self")
        self.assertEqual(e.exception.reason, "self-not-derivable")
        with self.assertRaises(OortUsageError):
            root.scoped(judge_role="expert")
        with self.assertRaises(OortUsageError):
            self.oort(agent="Not An Agent")
        self.assertEqual([r["path"] for r in self.rec.seen], [])

    def test_errors_keep_their_code_reason_and_retry_fields(self) -> None:
        from oortmem import OortNeedsKeyError, OortRefusedError

        self.rec.answers["POST /v1/observe"] = (
            403,
            envelope(error={"code": "needs-key", "message": "observe needs the write model.", "fix": "oort keys set anthropic", "reason": "missing-key", "retryable": False, "role": "write", "envVar": "ANTHROPIC_API_KEY"}),
        )
        self.rec.answers["POST /v1/remember"] = (
            403,
            envelope(error={"code": "refused", "message": "limit", "fix": None, "reason": "rate-limit", "retryable": True, "retryAfter": 30, "status": 429}),
        )
        o = self.oort()
        with self.assertRaises(OortNeedsKeyError) as e:
            o.observe(user="We deploy on Fridays.", assistant="Noted.")
        self.assertEqual((e.exception.role, e.exception.env_var, e.exception.fix), ("write", "ANTHROPIC_API_KEY", "oort keys set anthropic"))
        self.assertEqual(self.rec.seen[-1]["body"], {"user": "We deploy on Fridays.", "assistant": "Noted."})
        with self.assertRaises(OortRefusedError) as e:
            o.remember("x")
        self.assertTrue(e.exception.retryable)
        self.assertEqual((e.exception.retry_after, e.exception.status), (30, 429))

    def test_turn_fields_are_sent_in_wire_names_and_unknown_ones_are_kept(self) -> None:
        from datetime import datetime, timezone

        from oortmem.types import Turn

        self.rec.answers["POST /v1/observe"] = (200, envelope({"outcome": "added", "memories": [], "counts": {}, "warnings": []}))
        o = self.oort()
        o.observe(Turn(user="u", assistant="a", session_id="s1", turn_ref="r1", at=datetime(2026, 4, 1, tzinfo=timezone.utc)))
        self.assertEqual(self.rec.seen[-1]["body"], {"user": "u", "assistant": "a", "at": "2026-04-01T00:00:00.000Z", "sessionId": "s1", "turnRef": "r1"})
        o.observe({"user": "u", "assistant": "a", "place": {"nodeId": "x"}})
        self.assertIn("place", self.rec.seen[-1]["body"])  # refused by the daemon, never dropped
        from oortmem import OortUsageError

        with self.assertRaises(OortUsageError):
            o.observe({"user": "u", "assistant": "a"}, user="again")

    def test_paths_and_queries_for_every_route(self) -> None:
        ok = {"forgotten": "x", "id": "x", "pinned": True, "changed": True, "memories": [], "warnings": [], "judgments": []}
        for k in ("DELETE /v1/memories/*", "POST /v1/memories/*", "GET /v1/memories*", "GET /v1/judgments*", "POST /v1/judgments*", "POST /v1/consolidate"):
            self.rec.answers[k] = (200, envelope(ok))
        o = self.oort()
        o.forget("abc/def1234")
        o.pin("11111111")
        o.unpin("11111111")
        o.recent(since="2026-01-01", limit=5)
        o.judge.list(domain="content", all=True)
        o.judge.confirm("22222222")
        paths = [(r["method"], r["path"]) for r in self.rec.seen if r["path"] != "/v1/health"]
        self.assertEqual(
            paths,
            [
                ("DELETE", "/v1/memories/abc%2Fdef1234"),
                ("POST", "/v1/memories/11111111/pin"),
                ("POST", "/v1/memories/11111111/unpin"),
                ("GET", "/v1/memories?since=2026-01-01&limit=5"),
                ("GET", "/v1/judgments?domain=content&all=1"),
                ("POST", "/v1/judgments/22222222/confirm"),
            ],
        )

    def test_a_closed_handle_refuses_calls(self) -> None:
        from oortmem import OortUsageError

        o = self.oort()
        child = o.scoped(agent="bot")
        child.close()  # a derived handle's close does nothing
        o.close()
        with self.assertRaises(OortUsageError) as e:
            child.whoami()
        self.assertEqual(e.exception.reason, "closed")

    def test_async_client(self) -> None:
        from oortmem import AsyncOort

        self.rec.answers["POST /v1/recall"] = (200, envelope(RECALL))

        async def main():
            async with AsyncOort(mode="local", env=self.box.env, autostart=False) as o:
                rs = await asyncio.gather(*(o.recall(f"q{i}") for i in range(5)))
                scoped = o.scoped(agent="bot")
                await scoped.recall("x")
                return rs

        rs = asyncio.run(main())
        self.assertEqual(len(rs), 5)
        self.assertEqual(self.rec.seen[-1]["headers"]["oort-agent"], "bot")


@NEEDS_310
@POSIX
class DaemonTrustAndAutostart(unittest.TestCase):
    def setUp(self) -> None:
        self.box = Sandbox()

    def tearDown(self) -> None:
        self.box.cleanup()

    def test_an_outdated_daemon_answering_frames_is_named(self) -> None:
        from oortmem import Oort, OortUsageError

        path = self.box.socket()
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(path)
        os.chmod(path, 0o600)
        srv.listen(1)

        def answer() -> None:
            c, _ = srv.accept()
            c.recv(4096)
            body = b'{"v":1,"id":null,"ok":false,"error":{"code":"bad-frame","message":"bad frame"}}'
            c.sendall(len(body).to_bytes(4, "big") + body)
            c.close()

        t = threading.Thread(target=answer, daemon=True)
        t.start()
        try:
            with self.assertRaises(OortUsageError) as e:
                Oort(mode="local", env=self.box.env, autostart=False).whoami()
            self.assertEqual((e.exception.reason, e.exception.fix), ("daemon-outdated", "oort serve stop"))
        finally:
            srv.close()

    def test_a_socket_directory_others_can_write_is_never_used(self) -> None:
        from oortmem import Oort, OortUsageError

        rec = Recorder()
        d = FakeDaemon(self.box.socket(), rec)
        try:
            os.chmod(self.box.home, 0o777)
            with self.assertRaises(OortUsageError) as e:
                Oort(mode="local", env=self.box.env, autostart=False).whoami()
            self.assertEqual(e.exception.reason, "socket-untrusted")
            self.assertEqual(rec.seen, [])
        finally:
            os.chmod(self.box.home, 0o700)
            d.close()

    def test_a_symlinked_socket_directory_is_never_followed(self) -> None:
        from oortmem._daemon import inspect_dir, socket_trust

        real = os.path.join(self.box.tmp, "real")
        os.mkdir(real, 0o700)
        link = os.path.join(self.box.tmp, "link")
        os.symlink(real, link)
        self.assertEqual(inspect_dir(link), "symlink")
        self.assertEqual(socket_trust(os.path.join(link, "oort.sock")), "untrusted")
        f = os.path.join(real, "oort.sock")
        open(f, "w").close()
        self.assertEqual(socket_trust(f), "untrusted")  # a regular file is not a socket

    def test_autostart_runs_the_cli_once_with_an_allowlisted_environment(self) -> None:
        from oortmem import Oort

        rec = Recorder()
        started: List[Any] = []
        holder: List[FakeDaemon] = []

        def find(home: str, env: Dict[str, str]) -> List[str]:
            return ["/fake/oort"]

        def start(cmd: List[str], env: Dict[str, str], home: str) -> None:
            from oortmem._daemon import daemon_env

            started.append((cmd, daemon_env(env, home)))
            holder.append(FakeDaemon(self.box.socket(), rec))

        rec.answers["GET /v1/whoami"] = (200, envelope({"mode": "local", "account": None, "agent": None, "project": None, "user": None, "reads": [], "writesTo": "your Planet", "version": "0.7.0", "routes": {}}))
        env = {**self.box.env, "OORT_SERVE_TOKEN": TOKEN, "MY_DB_PASSWORD": "hunter2", "VOYAGE_API_KEY": "pa-x", "OORT_AGENT": "bot", "OORT_CLOUD_URL": "https://x"}
        try:
            with Oort(mode="local", env=env, _internals={"find": find, "start": start}) as o:
                o.whoami()
                o.whoami()
            self.assertEqual(len(started), 1)
            cmd, child = started[0]
            self.assertEqual(cmd, ["/fake/oort"])
            self.assertNotIn("MY_DB_PASSWORD", child)
            self.assertNotIn("OORT_SERVE_TOKEN", child)
            self.assertNotIn("OORT_AGENT", child)
            self.assertEqual((child["VOYAGE_API_KEY"], child["OORT_CLOUD_URL"], child["OORT_HOME"]), ("pa-x", "https://x", self.box.home))
        finally:
            for d in holder:
                d.close()

    def test_no_node_is_a_usage_error_that_points_at_cloud_mode(self) -> None:
        from oortmem import Oort, OortUsageError

        with self.assertRaises(OortUsageError) as e:
            Oort(mode="local", env=self.box.env, _internals={"find": lambda h, e: None, "start": None}).whoami()
        self.assertEqual(e.exception.reason, "node-missing")
        self.assertIn("mode='cloud'", str(e.exception))

    def test_without_autostart_nothing_running_is_a_network_error(self) -> None:
        from oortmem import Oort, OortNetworkError

        with self.assertRaises(OortNetworkError) as e:
            Oort(mode="local", env=self.box.env, autostart=False).whoami()
        self.assertEqual((e.exception.reason, e.exception.fix), ("unreachable", "oort serve --detach"))

    def test_find_oort_prefers_the_managed_copy_skips_the_launcher_and_old_versions(self) -> None:
        from oortmem import __version__
        from oortmem._daemon import find_oort

        bin_dir = os.path.join(self.box.tmp, "bin")
        os.mkdir(bin_dir)
        launcher = os.path.join(bin_dir, "oort")
        with open(launcher, "w") as f:
            f.write("#!/usr/bin/env python3\nfrom oortmem.cli import main\nmain()\n")
        os.chmod(launcher, 0o755)
        env = {**self.box.env, "PATH": bin_dir}
        sandbox = {"temp": [], "trust_from": self.box.tmp}  # the sandbox sits in /tmp
        find = lambda: find_oort(self.box.home, env, **sandbox)  # noqa: E731
        self.assertIsNone(find())  # only the launcher, and no npx
        managed = os.path.join(self.box.home, "cli", "bin", "oort")
        os.makedirs(os.path.dirname(managed))
        with open(managed, "w") as f:
            f.write(f"#!/bin/sh\necho {__version__}\n")
        os.chmod(managed, 0o755)
        self.assertEqual(find(), [os.path.realpath(managed)])
        with open(managed, "w") as f:
            f.write("#!/bin/sh\necho 0.1.0\n")
        self.assertIsNone(find())

    def _fake_oort(self, directory: str, version: str, mode: int = 0o755) -> str:
        """An `oort` that says its version and records that it ran, and with what environment."""
        os.makedirs(directory, exist_ok=True)
        path = os.path.join(directory, "oort")
        with open(path, "w") as f:
            f.write(f"#!/bin/sh\nenv > {os.path.join(directory, 'ran.txt')}\necho {version}\n")
        os.chmod(path, mode)
        return path

    def _sandboxed(self, **over: Any) -> Dict[str, Any]:
        return {"temp": [], "trust_from": self.box.tmp, **over}  # the sandbox sits in /tmp

    def test_a_relative_path_entry_is_never_executed(self) -> None:
        from oortmem import __version__
        from oortmem._daemon import find_oort

        here = os.path.join(self.box.tmp, "work")
        self._fake_oort(here, __version__)
        self._fake_oort(os.path.join(here, "bin"), __version__)
        ran = [os.path.join(here, "ran.txt"), os.path.join(here, "bin", "ran.txt")]
        old = os.getcwd()
        os.chdir(here)
        try:
            for entry in (".", "bin", "./bin", "", ":", "../work"):
                env = {**self.box.env, "PATH": entry}
                self.assertIsNone(find_oort(self.box.home, env, **self._sandboxed()), entry)
        finally:
            os.chdir(old)
        self.assertEqual([os.path.exists(r) for r in ran], [False, False])  # not even for --version

    def test_a_group_or_other_writable_candidate_is_skipped_unrun(self) -> None:
        from oortmem import __version__
        from oortmem._daemon import find_oort

        cases = {"file-other": (0o757, 0o755), "file-group": (0o775, 0o755), "dir-other": (0o755, 0o757), "dir-group": (0o755, 0o775)}
        for name, (fmode, dmode) in cases.items():
            with self.subTest(name):
                d = os.path.join(self.box.tmp, name)
                self._fake_oort(d, __version__, fmode)
                os.chmod(d, dmode)
                env = {**self.box.env, "PATH": d}
                try:
                    self.assertIsNone(find_oort(self.box.home, env, **self._sandboxed()))
                    self.assertFalse(os.path.exists(os.path.join(d, "ran.txt")))
                finally:
                    os.chmod(d, 0o755)
        d = os.path.join(self.box.tmp, "fine")
        p = self._fake_oort(d, __version__)
        env = {**self.box.env, "PATH": d}
        self.assertEqual(find_oort(self.box.home, env, **self._sandboxed()), [os.path.realpath(p)])

    def test_the_managed_copy_is_strict_and_a_path_copy_may_use_a_root_group(self) -> None:
        from oortmem import __version__
        from oortmem._daemon import find_oort

        managed = self._fake_oort(os.path.join(self.box.home, "cli", "bin"), __version__, 0o775)
        env = {**self.box.env, "PATH": "/nonexistent"}
        self.assertIsNone(find_oort(self.box.home, env, **self._sandboxed(group_ok=lambda gid: True)))  # no group write at all
        os.chmod(managed, 0o755)
        self.assertEqual(find_oort(self.box.home, env, **self._sandboxed()), [os.path.realpath(managed)])
        # A PATH copy outside HOME may be group-writable by a group that can become root.
        outside = os.path.join(self.box.tmp, "elsewhere")
        p = self._fake_oort(outside, __version__, 0o775)
        env = {**self.box.env, "PATH": outside, "HOME": os.path.join(self.box.tmp, "not-home")}
        os.remove(managed)
        self.assertEqual(find_oort(self.box.home, env, **self._sandboxed(group_ok=lambda gid: True)), [os.path.realpath(p)])
        self.assertIsNone(find_oort(self.box.home, env, **self._sandboxed(group_ok=lambda gid: False)))

    def test_a_candidate_in_a_temp_dir_is_skipped(self) -> None:
        from oortmem import __version__
        from oortmem._daemon import find_oort

        d = os.path.join(self.box.tmp, "tmpbin")
        self._fake_oort(d, __version__)
        env = {**self.box.env, "PATH": d}
        self.assertIsNone(find_oort(self.box.home, env, temp=[os.path.realpath(self.box.tmp)], trust_from=self.box.tmp))
        self.assertFalse(os.path.exists(os.path.join(d, "ran.txt")))

    def test_the_version_probe_sees_no_keys(self) -> None:
        from oortmem import __version__
        from oortmem._daemon import find_oort

        d = os.path.join(self.box.tmp, "probe")
        p = self._fake_oort(d, __version__)
        secrets = {"VOYAGE_API_KEY": "pa-x", "ANTHROPIC_API_KEY": "sk-x", "OORT_API_KEY": "k", "OORT_SERVE_TOKEN": "t", "AWS_SECRET_ACCESS_KEY": "a", "MY_DB_PASSWORD": "h"}
        env = {**self.box.env, **secrets, "PATH": f"relative:{d}:/usr/bin:/bin", "LANG": "C", "HTTPS_PROXY": "http://127.0.0.1:9", "TMPDIR": "/x"}
        self.assertEqual(find_oort(self.box.home, env, **self._sandboxed()), [os.path.realpath(p)])
        with open(os.path.join(d, "ran.txt")) as f:
            seen = dict(line.split("=", 1) for line in f.read().splitlines() if "=" in line)
        for k in secrets:
            self.assertNotIn(k, seen)
        self.assertNotIn("TMPDIR", seen)
        self.assertEqual((seen["HOME"], seen["OORT_HOME"], seen["LANG"], seen["HTTPS_PROXY"]), (self.box.tmp, self.box.home, "C", "http://127.0.0.1:9"))
        self.assertEqual(seen["PATH"], f"{d}:/usr/bin:/bin")  # the relative entry is gone

    def test_node_comes_only_from_a_trusted_absolute_path_entry(self) -> None:
        from oortmem import __version__
        from oortmem._daemon import daemon_env, find_oort

        here = os.path.join(self.box.tmp, "work")
        rel = os.path.join(here, "rel")
        os.makedirs(rel)
        with open(os.path.join(rel, "node"), "w") as f:
            f.write(f"#!/bin/sh\necho x > {os.path.join(here, 'node-ran.txt')}\necho v99.0.0\n")
        os.chmod(os.path.join(rel, "node"), 0o755)
        js = os.path.join(self.box.tmp, "jsbin", "oort")
        os.makedirs(os.path.dirname(js))
        with open(js, "w") as f:
            f.write("#!/usr/bin/env node\nconsole.log('x')\n")
        os.chmod(js, 0o755)
        env = {**self.box.env, "PATH": f"rel:{os.path.dirname(js)}"}
        old = os.getcwd()
        os.chdir(here)
        try:
            self.assertIsNone(find_oort(self.box.home, env, **self._sandboxed()))
        finally:
            os.chdir(old)
        self.assertFalse(os.path.exists(os.path.join(here, "node-ran.txt")))
        self.assertEqual(daemon_env(env, self.box.home, **self._sandboxed())["PATH"], os.path.dirname(js))
        # With a trusted absolute node, a JavaScript oort runs as `node <file>`, not by shebang.
        node_dir = os.path.join(self.box.tmp, "nodebin")
        os.makedirs(node_dir)
        with open(os.path.join(node_dir, "node"), "w") as f:
            f.write(f"#!/bin/sh\necho {__version__}\n")
        os.chmod(os.path.join(node_dir, "node"), 0o755)
        env = {**self.box.env, "PATH": f"rel:{node_dir}:{os.path.dirname(js)}"}
        self.assertEqual(find_oort(self.box.home, env, **self._sandboxed()), [os.path.realpath(os.path.join(node_dir, "node")), os.path.realpath(js)])

    def _fake_node(self, directory: str, version: str = "v22.20.0") -> str:
        os.makedirs(directory, exist_ok=True)
        path = os.path.join(directory, "node")
        with open(path, "w") as f:
            f.write(f"#!/bin/sh\necho {version}\n")
        os.chmod(path, 0o755)
        return os.path.realpath(path)

    def test_npx_is_trusted_like_the_cli_and_runs_under_the_trusted_node(self) -> None:
        from oortmem import __version__
        from oortmem._daemon import find_oort

        node = self._fake_node(os.path.join(self.box.tmp, "nodebin"))
        bad = os.path.join(self.box.tmp, "badbin")
        os.makedirs(bad)
        npx_bad = os.path.join(bad, "npx")
        with open(npx_bad, "w") as f:
            f.write("#!/bin/sh\n")
        os.chmod(npx_bad, 0o757)  # others can write it: never used
        env = {**self.box.env, "PATH": f"{os.path.dirname(node)}:{bad}"}
        self.assertIsNone(find_oort(self.box.home, env, **self._sandboxed()))
        good = os.path.join(self.box.tmp, "goodbin")
        os.makedirs(good)
        npx = os.path.join(good, "npx")
        with open(npx, "w") as f:
            f.write("#!/bin/sh\n")
        os.chmod(npx, 0o755)
        env = {**self.box.env, "PATH": f"{bad}:{os.path.dirname(node)}:{good}"}
        self.assertEqual(find_oort(self.box.home, env, **self._sandboxed()), [node, os.path.realpath(npx), "--yes", f"oortmem@{__version__}"])
        # An npx in a temp dir is skipped, however clean it is.
        self.assertIsNone(find_oort(self.box.home, env, temp=[os.path.realpath(good)], trust_from=self.box.tmp))

    def test_the_childs_path_holds_no_relative_or_untrusted_entry(self) -> None:
        from oortmem._daemon import daemon_env, safe_path

        node_dir = os.path.dirname(self._fake_node(os.path.join(self.box.tmp, "nodebin")))
        open_dir = os.path.join(self.box.tmp, "open")
        os.makedirs(open_dir)
        os.chmod(open_dir, 0o777)
        temp_dir = os.path.join(self.box.tmp, "tempish")
        os.makedirs(temp_dir)
        fine = os.path.join(self.box.tmp, "fine")
        os.makedirs(fine)
        env = {**self.box.env, "PATH": os.pathsep.join(["rel", ".", "", open_dir, temp_dir, "/nonexistent", fine])}
        try:
            for got in (
                safe_path(env, node_dir, temp=[os.path.realpath(temp_dir)], trust_from=self.box.tmp),
                daemon_env(env, self.box.home, node_dir, temp=[os.path.realpath(temp_dir)], trust_from=self.box.tmp)["PATH"],
            ):
                self.assertEqual(got.split(os.pathsep), [node_dir, fine])
        finally:
            os.chmod(open_dir, 0o755)

    def test_a_command_that_cannot_run_is_a_typed_error_with_a_fix(self) -> None:
        from oortmem import OortUsageError
        from oortmem._daemon import start_daemon

        for cmd in (["/nonexistent/oort"], [self.box.tmp]):
            with self.assertRaises(OortUsageError) as e:
                start_daemon(cmd, self.box.env, self.box.home)
            self.assertEqual((e.exception.reason, e.exception.fix), ("autostart-failed", "oort serve --detach"))


@NEEDS_310
class RemoteMode(unittest.TestCase):
    def setUp(self) -> None:
        self.rec = Recorder()
        self.svc = FakeCloud(self.rec)
        self.rec.answers["GET /v1/whoami"] = (200, envelope({"mode": "local", "account": None, "agent": None, "project": None, "user": "u1", "reads": [], "writesTo": "Planet u1", "version": "0.7.0", "routes": {}}))

    def tearDown(self) -> None:
        self.svc.close()

    def test_the_token_travels_as_a_bearer_and_no_cwd_is_sent(self) -> None:
        from oortmem import Oort

        o = Oort(mode="remote", url=self.svc.url, env={"OORT_SERVE_TOKEN": TOKEN}, agent_level=True)
        w = o.scoped(agent="bot").whoami()
        self.assertEqual(w.mode, "remote")
        h = self.rec.seen[-1]["headers"]
        self.assertEqual(h["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(h["oort-project"], "-")
        self.assertNotIn("oort-cwd", h)
        self.assertNotIn(TOKEN, repr(o))

    def test_remote_mode_needs_a_user_or_an_explicit_agent_level(self) -> None:
        from oortmem import Oort, OortUsageError

        with self.assertRaises(OortUsageError) as e:
            Oort(mode="remote", url=self.svc.url, token=TOKEN)
        self.assertEqual(e.exception.reason, "user-missing")
        for kw in ({"agent_level": True, "user": "u1"}, {"agent_level": "yes"}):
            with self.assertRaises(OortUsageError):
                Oort(mode="remote", url=self.svc.url, token=TOKEN, **kw)
        # agent_level belongs to remote mode only.
        with self.assertRaises(OortUsageError):
            Oort(mode="local", agent_level=True, env={"PATH": "/nonexistent"})
        with self.assertRaises(OortUsageError):
            Oort(mode="cloud", agent_level=True, api_key="k", key_sources=["explicit"])

    def test_the_user_header_is_always_sent_in_remote_mode(self) -> None:
        from oortmem import Oort

        org = Oort(mode="remote", url=self.svc.url, token=TOKEN, agent_level=True)
        org.whoami()
        self.assertEqual(self.rec.seen[-1]["headers"]["oort-user"], "-")
        org.scoped(user="u1", agent="bot").whoami()
        self.assertEqual(self.rec.seen[-1]["headers"]["oort-user"], "u1")
        Oort(mode="remote", url=self.svc.url, token=TOKEN, user="u2").whoami()
        self.assertEqual(self.rec.seen[-1]["headers"]["oort-user"], "u2")

    def test_a_token_is_never_sent_over_plain_http_to_another_host(self) -> None:
        from oortmem import Oort, OortUsageError

        with self.assertRaises(OortUsageError):
            Oort(mode="remote", agent_level=True, url="http://10.0.0.5:7807", token=TOKEN)
        with self.assertRaises(OortUsageError):
            Oort(mode="remote", agent_level=True, url="https://user:pw@svc.internal", token=TOKEN)
        with self.assertRaises(OortUsageError):
            Oort(mode="remote", agent_level=True, url=self.svc.url, token=TOKEN, judge_role="expert")
        with self.assertRaises(OortUsageError):
            Oort(mode="remote", agent_level=True, url=self.svc.url, token=TOKEN, org="acme")
        Oort(mode="remote", url="https://svc.internal:7807", token=TOKEN, agent_level=True)  # fine: TLS

    def test_no_token_is_needs_login(self) -> None:
        from oortmem import Oort, OortNeedsLoginError

        with self.assertRaises(OortNeedsLoginError):
            Oort(mode="remote", url=self.svc.url, env={}, agent_level=True).whoami()
        self.assertEqual(self.rec.seen, [])


@NEEDS_310
class CloudMode(unittest.TestCase):
    def setUp(self) -> None:
        self.box = Sandbox()
        self.rec = Recorder()
        self.cloud = FakeCloud(self.rec)

    def tearDown(self) -> None:
        self.cloud.close()
        self.box.cleanup()

    def oort(self, **kw: Any):
        from oortmem import Oort

        env = {**self.box.env, "OORT_API_KEY": KEY, **kw.pop("env", {})}
        return Oort(mode="cloud", url=self.cloud.url, env=env, cwd=self.box.tmp, **kw)

    def test_recall_maps_to_the_cloud_contract(self) -> None:
        cloud_memory = {**{k: v for k, v in RECALL["memories"][0].items() if k not in ("status", "score", "why", "recordedAt")}, "createdAt": "2026-11-01T00:00:00.000Z", "expiredAt": None, "endReason": None, "explanation": {"fused": 0.5, "coverage": 1, "activation": 0, "stale": True}, "origin": {"level": "hive", "space": "Constellation", "node": "Constellation checkout", "author": "ada"}}
        self.rec.answers["POST /v1/recall"] = (200, {"memories": [cloud_memory], "timings": {}, "temporal": {"mode": "current", "inferred": False}, "degraded": ["no-reranker"]})
        with self.oort(agent="bot", project="acme") as o:
            r = o.recall("deploy", speed="lexical", limit=7)
        req = self.rec.seen[-1]
        self.assertEqual(req["headers"]["authorization"], f"Bearer {KEY}")
        self.assertEqual(req["body"], {"text": "deploy", "project": "cfg:acme", "agent": "bot", "k": 7, "rerank": False, "embed": False})
        m = r.memories[0]
        self.assertEqual((m.status, m.recorded_at, m.stale, m.score), ("current", "2026-11-01T00:00:00.000Z", True, 0.5))
        self.assertEqual((m.origin.level, m.origin.space, m.origin.author), ("constellation", "Constellation checkout", "ada"))
        self.assertEqual(r.degraded, [])  # chosen by speed, not a degradation

    def test_a_secret_in_a_stored_cloud_memory_never_reaches_the_caller(self) -> None:
        pw = "Tr0ub4dor" + "-and-3"
        aws = "AKIA" + "IOSFODNN7EXAMPLE"
        stored = {**{k: v for k, v in RECALL["memories"][0].items() if k not in ("status", "score", "why", "recordedAt")}, "createdAt": "2026-11-01T00:00:00.000Z", "expiredAt": None, "endReason": None, "explanation": {"fused": 0.5, "coverage": 1, "activation": 0}}
        stored = {**stored, "text": f'password: ["{pw}", "x"]', "entities": [aws], "supersedes": "a1b2c3d5", "source": {"harness": "h", "decisions": [{"stage": "s", "question": f"token={pw}", "answer": f"use {aws}", "probability": 0.5}]}}
        old = {**stored, "id": "a1b2c3d5", "text": f"DB_PASSWORD={pw}", "supersedes": None, "supersededBy": None}
        self.rec.answers["POST /v1/recall"] = (200, {"memories": [stored], "timings": {}, "temporal": {"mode": "current", "inferred": False}, "degraded": []})
        self.rec.answers["GET /v1/memories/a1b2c3d4"] = (200, stored)
        self.rec.answers["GET /v1/memories/a1b2c3d5"] = (200, old)
        from oortmem import format_for_prompt

        with self.oort() as o:
            r = o.recall("deploy")
            x = o.explain("a1b2c3d4")
        for secret in (pw, aws):
            self.assertNotIn(secret, json.dumps([r.memories[0].text, r.memories[0].entities, x.memory.text, x.memory.entities, [(d.question, d.answer) for d in x.decisions], [c.text for c in x.chain]]))
            self.assertNotIn(secret, format_for_prompt(r))
        self.assertIn("[REDACTED:env-secret]", r.memories[0].text)

    def test_limits_and_temporal_rules_hold_before_any_request(self) -> None:
        from oortmem import OortUsageError

        o = self.oort()
        for call in (
            lambda: o.recall("q" * 2049),
            lambda: o.recall("  "),
            lambda: o.recall("q", limit=51),
            lambda: o.recall("q", mode="as-of"),
            lambda: o.recall("q", as_of="2026-01-01", known_at="2026-01-01"),
            lambda: o.remember(["a"] * 6),
            lambda: o.remember("f" * 501),
            lambda: o.observe(user="x" * (128 * 1024), assistant="y"),
            lambda: o.observe(user="u", assistant="a", turn_ref="r" * 129),
            lambda: o.observe({"user": "u", "assistant": "a", "place": {}}),
            lambda: o.explain("1234"),
            lambda: o.recent(limit=101),
        ):
            with self.assertRaises(OortUsageError):
                call()
        self.assertEqual(self.rec.seen, [])

    def test_judgments_and_consolidation_are_local_only(self) -> None:
        from oortmem import OortRefusedError

        o = self.oort()
        for call in (lambda: o.consolidate(), lambda: o.judge.list(), lambda: o.judge.apply("x")):
            with self.assertRaises(OortRefusedError) as e:
                call()
            self.assertEqual(e.exception.reason, "local-only")

    def test_cloud_mode_refuses_local_only_options(self) -> None:
        from oortmem import Oort, OortUsageError

        # user and org are cloud options too (CON-132), under the local rules: user needs an org.
        for kw in ({"user": "u1"}, {"user": "u1", "org": "local"}, {"judge_role": "expert"}, {"home": "/x"}, {"url": "ftp://x"}, {"url": "http://example.com"}):
            with self.assertRaises(OortUsageError, msg=str(kw)):
                Oort(mode="cloud", **kw)

    def test_no_key_is_needs_login_and_nothing_is_sent(self) -> None:
        from oortmem import OortNeedsLoginError

        o = self.oort(env={"OORT_API_KEY": ""}, key_sources=["env"])
        with self.assertRaises(OortNeedsLoginError) as e:
            o.whoami()
        self.assertEqual((e.exception.reason, e.exception.fix), ("no-key", "oort login"))
        self.assertEqual(self.rec.seen, [])

    def test_a_redirect_is_never_followed_and_the_key_never_appears_in_an_error(self) -> None:
        from oortmem import OortError

        other = Recorder()
        elsewhere = FakeCloud(other)
        try:
            self.rec.answers["GET /v1/whoami"] = (302, b"", {"Location": elsewhere.url + "/v1/whoami"})
            o = self.oort()
            with self.assertRaises(OortError) as e:
                o.whoami()
            self.assertEqual(other.seen, [])
            self.assertNotIn(KEY, repr(e.exception) + str(e.exception))
            self.assertNotIn(KEY, repr(o) + str(o))
        finally:
            elsewhere.close()

    def test_rate_limits_carry_retry_after(self) -> None:
        from oortmem import OortRefusedError

        self.rec.answers["POST /v1/recall"] = (429, {"error": {"code": "rate_limit", "message": "monthly cap"}}, {"Retry-After": "30"})
        with self.assertRaises(OortRefusedError) as e:
            self.oort().recall("q")
        self.assertEqual((e.exception.reason, e.exception.retryable, e.exception.retry_after, e.exception.status), ("rate-limit", True, 30, 429))

    def test_a_star_agent_cannot_write(self) -> None:
        from oortmem import OortRefusedError

        with open(os.path.join(self.box.home, "agents.json"), "w") as f:
            json.dump({"version": 1, "agents": {"cursor": {"star": True}}}, f)
        with self.assertRaises(OortRefusedError) as e:
            self.oort(agent="cursor").observe(user="u", assistant="a")
        self.assertEqual(e.exception.reason, "star-in-cloud")
        self.assertEqual(self.rec.seen, [])

    def test_auto_mode_follows_cloud_json(self) -> None:
        from oortmem import Oort

        with open(os.path.join(self.box.home, "cloud.json"), "w") as f:
            json.dump({"store": "cloud"}, f)
        self.rec.answers["GET /v1/whoami"] = (200, {"account": "acct", "plan": "pro", "via": "key"})
        o = Oort(env={**self.box.env, "OORT_API_KEY": KEY, "OORT_CLOUD_URL": self.cloud.url}, cwd=self.box.tmp)
        self.assertEqual(o.whoami().account, "acct")
        self.assertEqual(o.mode, "cloud")


WHOAMI_SERVER_KEY = (200, {"account": "acct", "plan": "pro", "via": "key", "capabilities": ["end-users"]})
OBSERVED = (200, {"outcome": "added", "memories": [{"id": "m1", "action": "added"}], "counts": {"added": 1}})


@NEEDS_310
class CloudEndUsers(unittest.TestCase):
    """Per-user memory in Oort Cloud (CON-132): Oort-User from an end user's handle only, and
    only once whoami lists the key's end-users capability."""

    def setUp(self) -> None:
        self.box = Sandbox()
        self.rec = Recorder()
        self.cloud = FakeCloud(self.rec)

    def tearDown(self) -> None:
        self.cloud.close()
        self.box.cleanup()

    def oort(self, **kw: Any):
        from oortmem import Oort

        env = {**self.box.env, "OORT_API_KEY": KEY}
        o = Oort(mode="cloud", url=self.cloud.url, env=env, cwd=self.box.tmp, org="acme", project=None, **kw)
        self.addCleanup(o.close)
        return o

    def sent(self) -> List[Any]:
        return [(r["method"], r["path"].split("?")[0], r["headers"].get("oort-user")) for r in self.rec.seen]

    def test_the_header_goes_only_with_an_end_users_memory_calls(self) -> None:
        self.rec.answers["GET /v1/whoami"] = WHOAMI_SERVER_KEY
        self.rec.answers["POST /v1/observe"] = OBSERVED
        self.rec.answers["GET /v1/memories"] = (200, {"memories": []})
        with self.oort() as o:
            ada = o.scoped(user="ada", agent="bot")
            ada.remember("Ada likes tea.")
            ada.recent()
            w = ada.whoami()
        self.assertEqual((w.user, w.reads, w.writes_to), ("ada", ["Planet ada"], "Planet ada"))
        self.assertEqual(
            self.sent(),
            [
                ("GET", "/v1/whoami", None),
                ("POST", "/v1/observe", "ada"),
                ("GET", "/v1/memories", "ada"),
                ("GET", "/v1/whoami", None),
            ],
        )

    def test_never_from_an_unscoped_handle(self) -> None:
        self.rec.answers["GET /v1/whoami"] = (200, {"account": "acct", "plan": "pro", "via": "key"})
        self.rec.answers["POST /v1/observe"] = OBSERVED
        self.rec.answers["POST /v1/recall"] = (200, {"memories": [], "timings": {}})
        self.rec.answers["GET /v1/memories"] = (200, {"memories": []})
        with self.oort() as o:
            for h in (o, o.scoped(agent="bot"), o.scoped(project="web")):
                h.remember("x is y")
                h.observe(user="u", assistant="a")
                h.recall("x")
                h.recent()
                h.whoami()
        self.assertGreater(len(self.rec.seen), 10)
        self.assertTrue(all(r["headers"].get("oort-user") is None for r in self.rec.seen))

    def test_an_older_cloud_is_refused_and_nothing_names_the_user(self) -> None:
        from oortmem import OortRefusedError
        from oortmem.errors import END_USERS_UNSUPPORTED

        # Before CON-132: whoami lists no capabilities, and the header would be ignored.
        self.rec.answers["GET /v1/whoami"] = (200, {"account": "acct", "plan": "pro", "via": "key"})
        self.rec.answers["POST /v1/observe"] = OBSERVED
        o = self.oort()
        ada = o.scoped(user="ada")
        for call in (
            lambda: ada.remember("x is y"),
            lambda: ada.observe(user="u", assistant="a"),
            lambda: ada.recall("x"),
            lambda: ada.recent(),
            lambda: ada.forget("11111111"),
            lambda: ada.pin("11111111"),
            lambda: ada.explain("11111111"),
            lambda: o.end_users.count(),
            lambda: o.end_users.erase("ada"),
        ):
            with self.assertRaises(OortRefusedError) as e:
                call()
            self.assertEqual((e.exception.reason, e.exception.retryable, e.exception.fix), ("end-users-unsupported", False, None))
            self.assertEqual(e.exception.message, END_USERS_UNSUPPORTED)
        self.assertEqual({(m, p) for m, p, _ in self.sent()}, {("GET", "/v1/whoami")})
        self.assertTrue(all(u is None for _, _, u in self.sent()))

    def test_the_capability_is_checked_once_per_root_and_again_after_a_refusal(self) -> None:
        from oortmem import OortRefusedError

        self.rec.answers["GET /v1/whoami"] = (200, {"account": "acct", "plan": "pro", "via": "key"})
        self.rec.answers["POST /v1/observe"] = OBSERVED
        o = self.oort()
        with self.assertRaises(OortRefusedError):
            o.scoped(user="ada").remember("x is y")
        self.rec.answers["GET /v1/whoami"] = WHOAMI_SERVER_KEY  # the cloud upgraded: no restart
        o.scoped(user="ada").remember("x is y")
        o.scoped(user="bob").remember("x is y")
        o.scoped(user="ada").remember("x is y")
        self.assertEqual(sum(1 for m, p, _ in self.sent() if p == "/v1/whoami"), 2)

    def test_erase_and_count(self) -> None:
        self.rec.answers["GET /v1/whoami"] = WHOAMI_SERVER_KEY
        self.rec.answers["GET /v1/end-users/count"] = (200, {"endUsers": 3, "limit": 100})
        self.rec.answers["DELETE /v1/end-users/*"] = (200, {"erased": {"memories": 2, "coldCopies": 1, "turnRefs": 4, "cursors": 1}})
        o = self.oort()
        c = o.end_users.count()
        self.assertEqual((c.end_users, c.limit), (3, 100))
        e = o.end_users.erase("ada:1")
        self.assertEqual((e.erased, e.memories, e.cold_copies, e.turn_refs, e.cursors), ("ada:1", 2, 1, 4, 1))
        self.assertEqual(
            self.sent(),
            [("GET", "/v1/whoami", None), ("GET", "/v1/end-users/count", None), ("DELETE", "/v1/end-users/ada%3A1", None)],
        )

    def test_export(self) -> None:
        # CON-137: one end user's memories, as the account (no Oort-User), the body kept as text.
        jsonl = (
            json.dumps({"oort": "export", "version": 1, "memories": 2, "scopes": []}) + "\n"
            + json.dumps({"id": "m1", "text": "Ada likes tea."}) + "\n"
            + json.dumps({"id": "m2", "text": "Ada lives in Lund."}) + "\n"
        )
        empty = json.dumps({"oort": "export", "version": 1, "memories": 0, "scopes": []}) + "\n"
        self.rec.answers["GET /v1/whoami"] = WHOAMI_SERVER_KEY
        self.rec.answers["GET /v1/end-users/ada%3A1/export"] = (200, jsonl.encode())
        self.rec.answers["GET /v1/end-users/*"] = (200, empty.encode())
        o = self.oort()
        e = o.end_users.export("ada:1")
        self.assertEqual((e.exported, e.memories, e.jsonl), ("ada:1", 2, jsonl))
        # Erased or never there: an empty export, not an error.
        none = o.end_users.export("carol")
        self.assertEqual((none.exported, none.memories, none.jsonl), ("carol", 0, empty))
        self.assertEqual(
            self.sent(),
            [
                ("GET", "/v1/whoami", None),
                ("GET", "/v1/end-users/ada%3A1/export", None),
                ("GET", "/v1/end-users/carol/export", None),
            ],
        )

    def test_export_refuses_what_it_cannot_read_and_maps_refusals(self) -> None:
        from oortmem import OortInternalError, OortRefusedError, OortUsageError

        self.rec.answers["GET /v1/whoami"] = WHOAMI_SERVER_KEY
        o = self.oort()
        for body in (b"garbage\n", b'{"oort": "export", "memories": 3}\n{"id": "m1"}\n', b"", b'{"oort": "export", "memories": true}\n{}\n'):
            self.rec.answers["GET /v1/end-users/*"] = (200, body)
            with self.subTest(body=body):
                with self.assertRaises(OortInternalError):
                    o.end_users.export("ada")
        self.rec.answers["GET /v1/end-users/*"] = (403, {"error": {"code": "end_users_not_allowed", "message": "m"}})
        with self.assertRaises(OortRefusedError) as e:
            o.end_users.export("ada")
        self.assertEqual((e.exception.reason, e.exception.status), ("end-users-not-allowed", 403))
        n = len(self.rec.seen)
        for user, reason in (("self", "self-not-derivable"), ("", "user-missing"), (None, "user-missing"), ("alice\n", "bad-user"), ("Root", "bad-user")):
            with self.assertRaises(OortUsageError) as e:
                o.end_users.export(user)  # type: ignore[arg-type]
            self.assertEqual(e.exception.reason, reason)
        with self.assertRaises(OortUsageError) as e:
            o.scoped(user="ada").end_users.export("ada")
        self.assertEqual(e.exception.reason, "user-not-supported")
        self.assertEqual(len(self.rec.seen), n)

    def test_export_needs_a_server_key(self) -> None:
        from oortmem import OortRefusedError

        self.rec.answers["GET /v1/whoami"] = (200, {"account": "acct", "plan": "pro", "via": "key"})
        with self.assertRaises(OortRefusedError) as e:
            self.oort().end_users.export("ada")
        self.assertEqual(e.exception.reason, "end-users-unsupported")
        self.assertEqual(self.sent(), [("GET", "/v1/whoami", None)])

    def test_the_same_client_side_rules_as_local(self) -> None:
        from oortmem import Oort, OortCloudOnlyError, OortRefusedError, OortUsageError

        o = self.oort()
        for user, reason in (("self", "self-not-derivable"), ("", "user-missing"), (None, "user-missing"), ("bad id", "bad-user")):
            with self.assertRaises(OortUsageError) as e:
                o.scoped(user=user)
            self.assertEqual(e.exception.reason, reason)
            with self.assertRaises(OortUsageError) as e:
                o.end_users.erase(user)  # type: ignore[arg-type]
            self.assertEqual(e.exception.reason, reason)
        ada = o.scoped(user="ada")
        with self.assertRaises(OortRefusedError) as e:
            ada.recall("x", include=["star"])
        self.assertEqual(e.exception.reason, "scope-denied")
        with self.assertRaises(OortUsageError) as e:
            ada.forget("11111111", everywhere=True)
        self.assertEqual(e.exception.reason, "user-not-supported")
        with self.assertRaises(OortUsageError) as e:
            ada.end_users.count()
        self.assertEqual(e.exception.reason, "user-not-supported")
        no_org = Oort(mode="cloud", url=self.cloud.url, env={**self.box.env, "OORT_API_KEY": KEY}, cwd=self.box.tmp)
        self.addCleanup(no_org.close)
        with self.assertRaises(OortUsageError) as e:
            no_org.scoped(user="ada")
        self.assertEqual(e.exception.reason, "principal-required")
        with open(os.path.join(self.box.home, "agents.json"), "w") as f:
            json.dump({"version": 1, "agents": {"cursor": {"star": True}}}, f)
        with self.assertRaises(OortRefusedError) as e:
            o.scoped(user="ada", agent="cursor").remember("x is y")
        self.assertEqual(e.exception.reason, "star-with-user")
        self.assertEqual(self.rec.seen, [])
        local = Oort(mode="local", env=self.box.env, cwd=self.box.tmp, org="acme")
        with self.assertRaises(OortCloudOnlyError) as e:
            local.end_users.count()
        self.assertEqual(e.exception.reason, "end-users")
        with self.assertRaises(OortCloudOnlyError) as e:
            local.end_users.export("ada")
        self.assertEqual(e.exception.reason, "end-users")

    def test_a_user_handle_never_switches_users(self) -> None:
        from oortmem import OortUsageError

        o = self.oort()
        ada = o.scoped(user="ada")
        with self.assertRaises(OortUsageError) as e:
            ada.scoped(user="bob")
        self.assertEqual(e.exception.reason, "user-hop")
        ada.scoped(user="ada").scoped(agent="bot", project=None)  # the same user, narrowed: fine
        for_ada = self.oort(user="ada")
        with self.assertRaises(OortUsageError) as e:
            for_ada.scoped(user="bob")
        self.assertEqual(e.exception.reason, "user-hop")
        self.assertEqual(self.rec.seen, [])

    def test_ids_are_never_trimmed_and_reserved_names_are_refused(self) -> None:
        from oortmem import OortUsageError

        o = self.oort()
        for user in ("alice\n", " alice", "COUNT", "Root", "-x", "_x", "a" * 129):
            with self.subTest(user=user):
                with self.assertRaises(OortUsageError) as e:
                    o.scoped(user=user)
                self.assertEqual(e.exception.reason, "bad-user")
                with self.assertRaises(OortUsageError) as e:
                    o.end_users.erase(user)
                self.assertEqual(e.exception.reason, "bad-user")
        self.assertEqual(self.rec.seen, [])

    def test_each_refusal_maps(self) -> None:
        self.rec.answers["GET /v1/whoami"] = WHOAMI_SERVER_KEY
        ada = self.oort().scoped(user="ada")
        for status, code, cls, reason in (
            (400, "user_missing", "OortUsageError", "user-missing"),
            (400, "self_not_derivable", "OortUsageError", "self-not-derivable"),
            (400, "bad_user", "OortUsageError", "bad-user"),
            (400, "star_with_user", "OortRefusedError", "star-with-user"),
            (400, "scope_denied", "OortRefusedError", "scope-denied"),
            (400, "user_not_supported", "OortUsageError", "user-not-supported"),
            (402, "end_user_limit", "OortRefusedError", "end-user-limit"),
            (403, "end_users_not_allowed", "OortRefusedError", "end-users-not-allowed"),
            (409, "end_user_erased", "OortRefusedError", "end-user-erased"),
        ):
            self.rec.answers["POST /v1/observe"] = (status, {"error": {"code": code, "message": "m"}})
            with self.subTest(code=code):
                from oortmem import OortError

                with self.assertRaises(OortError) as e:
                    ada.observe(user="u", assistant="a")
                self.assertEqual((type(e.exception).__name__, e.exception.reason, e.exception.status, e.exception.retryable), (cls, reason, status, False))

    def test_the_documented_example_runs(self) -> None:
        import contextlib
        import io
        import runpy
        from unittest import mock

        self.rec.answers["GET /v1/whoami"] = WHOAMI_SERVER_KEY
        self.rec.answers["POST /v1/observe"] = OBSERVED
        self.rec.answers["POST /v1/recall"] = (200, {"memories": [], "timings": {}})
        self.rec.answers["GET /v1/end-users/count"] = (200, {"endUsers": 1, "limit": 100})
        self.rec.answers["DELETE /v1/end-users/*"] = (200, {"erased": {"memories": 1, "coldCopies": 0, "turnRefs": 0, "cursors": 0}})
        example = os.path.join(os.path.dirname(HERE), "..", "examples", "python", "cloud_multi_user.py")
        env = {**self.box.env, "OORT_API_KEY": KEY, "OORT_CLOUD_URL": self.cloud.url}
        out = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), contextlib.redirect_stdout(out):
            runpy.run_path(example, run_name="__main__")
        self.assertEqual(out.getvalue().splitlines(), ["I found 0 things I know about you.", "1 of 100 end users", "erased 1 memories"])
        self.assertEqual(
            self.sent(),
            [
                ("GET", "/v1/whoami", None),
                ("POST", "/v1/recall", "u-123"),
                ("POST", "/v1/observe", "u-123"),
                ("GET", "/v1/end-users/count", None),
                ("DELETE", "/v1/end-users/u-123", None),
            ],
        )

    def test_the_documented_data_requests_example_runs(self) -> None:
        import contextlib
        import io
        import runpy
        import stat
        import tempfile
        from unittest import mock

        wrong = {**{k: v for k, v in RECALL["memories"][0].items() if k not in ("score", "why", "someFutureField")}, "id": "a1b2c3d4", "text": "I live in Oslo.", "createdAt": "2026-11-01T00:00:00.000Z", "expiredAt": None, "endReason": None}
        one = b'{"oort":"export","version":1,"exportedAt":"2026-11-11T12:00:00.000Z","memories":1,"scopes":[]}\n{"id":"a1b2c3d4","text":"I live in Oslo."}\n'
        none = b'{"oort":"export","version":1,"exportedAt":"2026-11-11T12:00:00.000Z","memories":0,"scopes":[]}\n'
        self.rec.answers["GET /v1/whoami"] = WHOAMI_SERVER_KEY
        self.rec.answers["POST /v1/observe"] = OBSERVED
        self.rec.answers["GET /v1/end-users/user-ada/export"] = [(200, one), (200, none)]
        self.rec.answers["POST /v1/recall"] = (200, {"memories": [wrong], "timings": {}, "temporal": {"mode": "current", "inferred": True}, "degraded": []})
        self.rec.answers["GET /v1/memories/a1b2c3d4"] = (200, wrong)
        self.rec.answers["DELETE /v1/memories/a1b2c3d4"] = (200, {"forgotten": "a1b2c3d4"})
        self.rec.answers["DELETE /v1/end-users/*"] = (200, {"erased": {"memories": 2, "coldCopies": 0, "turnRefs": 0, "cursors": 0}})
        example = os.path.join(os.path.dirname(HERE), "..", "examples", "python", "cloud_data_requests.py")
        tmp = tempfile.mkdtemp(dir=self.box.tmp)
        env = {**self.box.env, "OORT_API_KEY": KEY, "OORT_CLOUD_URL": self.cloud.url, "TMPDIR": tmp}
        out = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(tempfile, "tempdir", tmp), contextlib.redirect_stdout(out):
            runpy.run_path(example, run_name="__main__")
        self.assertEqual(out.getvalue().splitlines(), ["exported 1 memories", "forgot the wrong fact", "erased 2 memories", "left 0"])
        written = os.path.join(tmp, "user-ada-memories.jsonl")
        with open(written, "rb") as f:
            self.assertEqual(f.read(), one)
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(os.stat(written).st_mode), 0o600)
        self.assertEqual(
            self.sent(),
            [
                ("GET", "/v1/whoami", None),
                ("POST", "/v1/observe", "user-ada"),
                ("GET", "/v1/end-users/user-ada/export", None),
                ("POST", "/v1/recall", "user-ada"),
                ("POST", "/v1/observe", "user-ada"),
                ("GET", "/v1/memories/a1b2c3d4", "user-ada"),
                ("GET", "/v1/memories/a1b2c3d4", "user-ada"),
                ("DELETE", "/v1/memories/a1b2c3d4", "user-ada"),
                ("DELETE", "/v1/end-users/user-ada", None),
                ("GET", "/v1/end-users/user-ada/export", None),
            ],
        )

    def test_asyncio(self) -> None:
        import asyncio

        from oortmem import AsyncOort

        self.rec.answers["GET /v1/whoami"] = WHOAMI_SERVER_KEY
        self.rec.answers["POST /v1/observe"] = OBSERVED
        self.rec.answers["GET /v1/end-users/count"] = (200, {"endUsers": 1, "limit": 100})
        self.rec.answers["DELETE /v1/end-users/*"] = (200, {"erased": {"memories": 1, "coldCopies": 0, "turnRefs": 0, "cursors": 0}})
        self.rec.answers["GET /v1/end-users/ada/export"] = (200, b'{"oort": "export", "version": 1, "memories": 0, "scopes": []}\n')

        async def run() -> Any:
            async with AsyncOort(mode="cloud", url=self.cloud.url, env={**self.box.env, "OORT_API_KEY": KEY}, cwd=self.box.tmp, org="acme") as o:
                await o.scoped(user="ada").remember("Ada likes tea.")
                exported = await o.end_users.export("ada")
                return await o.end_users.count(), await o.end_users.erase("ada"), exported

        count, erased, exported = asyncio.run(run())
        self.assertEqual((count.end_users, erased.erased, erased.memories), (1, "ada", 1))
        self.assertEqual((exported.exported, exported.memories), ("ada", 0))
        self.assertEqual([u for _, _, u in self.sent()], [None, "ada", None, None, None])


@NEEDS_310
class Secrets(unittest.TestCase):
    def test_secrets_never_print_or_pickle(self) -> None:
        from oortmem import Oort
        from oortmem._secret import _Secret

        s = _Secret(KEY)
        self.assertEqual((repr(s), str(s), f"{s}"), ("'***'", "'***'", "***"))
        with self.assertRaises(TypeError):
            pickle.dumps(s)
        # env={}: an assertion message must never dump the real environment.
        o = Oort(mode="cloud", api_key=KEY, token=None, env={})
        self.assertNotIn(KEY, repr(o) + str(o))
        self.assertNotIn(KEY, repr(vars(o)))  # held only in a _Secret, never as a plain string
        envd = Oort(mode="cloud", env={"OORT_API_KEY": KEY})
        self.assertNotIn(KEY, repr(vars(envd)))
        with self.assertRaises(TypeError):
            pickle.dumps(o)

    @POSIX
    def test_credentials_json_is_refused_when_others_can_read_it(self) -> None:
        from oortmem._keys import credentials_file_key, find_oort_key

        box = Sandbox()
        try:
            p = os.path.join(box.home, "credentials.json")
            with open(p, "w") as f:
                json.dump({"version": 1, "keys": {"oort": KEY}}, f)
            os.chmod(p, 0o644)
            self.assertIsNone(credentials_file_key(box.home))
            os.chmod(p, 0o600)
            self.assertEqual(credentials_file_key(box.home), KEY)
            # The keychain source is a seam: tests never touch the real Keychain.
            k = find_oort_key(explicit=None, env={}, home=box.home, sources=["keychain"], keychain=lambda: "from-chain")
            self.assertEqual(k.reveal(), "from-chain")
            self.assertIsNone(find_oort_key(explicit=None, env={"OORT_NO_KEYCHAIN": "1"}, home=box.home, sources=["keychain"], keychain=lambda: "x"))
        finally:
            box.cleanup()

    def test_display_unsafe_characters_are_escaped_in_api_messages(self) -> None:
        from oortmem.errors import shown

        unsafe = [0x00, 0x1B, 0x1F, 0x7F, 0x9B, 0x9F, 0x61C, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x202A, 0x202E, 0x2060, 0x2064, 0x2066, 0x2069, 0xFEFF]
        for cp in unsafe:
            self.assertEqual(shown(f"a{chr(cp)}b"), "a\\u{%x}b" % cp)
        self.assertEqual(shown("plain \u00e9 text"), "plain \u00e9 text")

    def test_no_source_file_holds_a_literal_bidi_or_invisible_character(self) -> None:
        bad = set(range(0x202A, 0x202F)) | set(range(0x2066, 0x206A)) | {0x061C, 0x200B, 0x200C, 0x200E, 0x200F, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF}
        for d, _, files in os.walk(os.path.join(ROOT, "python")):
            if "__pycache__" in d:
                continue
            for name in files:
                if not name.endswith((".py", ".toml", ".md")):
                    continue
                with open(os.path.join(d, name), encoding="utf-8") as f:
                    text = f.read()
                hits = sorted({hex(ord(c)) for c in text if ord(c) in bad})
                self.assertEqual(hits, [], name)


class Launcher(unittest.TestCase):
    def test_importing_the_package_never_loads_the_client(self) -> None:
        import subprocess

        code = "import sys; sys.path.insert(0, sys.argv[1]); import oortmem, oortmem.cli; print(sorted(m for m in sys.modules if m.startswith('oortmem')))"
        out = subprocess.run([sys.executable, "-I", "-c", code, os.path.join(ROOT, "python", "src")], capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(out.replace("'", '"')), ["oortmem", "oortmem.cli"])


if __name__ == "__main__":
    unittest.main()
