"""Finding, checking and starting ``oort serve`` for local mode (CON-108 section 8.1.6).

- The socket path is the daemon's own (``socketPathFor`` in serve-protocol.ts): ``<home>/oort.sock``,
  or a hashed name in ``$XDG_RUNTIME_DIR/oort`` or ``/tmp/oort-<uid>`` when that is too long.
- Before connecting, the client checks the socket as the hooks do (``socketTrust``): a real
  directory of this user's that nobody else can write, holding a socket of this user's. A symlink
  is never followed.
- Autostart runs ``oort serve --detach`` once: the managed copy (``<home>/cli/bin/oort``), else
  the first ``oort`` on PATH that is not this package's launcher, when its ``--version`` is this
  package's minor or newer; else ``npx --yes oortmem@<this version>``. The child gets an
  allowlisted environment only, so the app's other secrets never reach the daemon.
- Nothing is executed before it is trusted (``trusted_path``, a port of ``trustedPath`` in
  packages/cli/src/trust.ts): only absolute PATH entries are searched (a relative or empty one is
  skipped, never resolved against the working directory), the candidate's realpath must be owned
  by this user or root, with no write for others (and none for the group, except a group that can
  already become root, for a PATH copy) on it and on every directory above it, and not be in a
  temporary directory. The managed copy is strict: no group write at all. The ``--version`` probe
  runs with PATH, HOME, OORT_HOME, LANG and the proxy variables only: no API key or token.
- The ``npx`` fallback downloads ``oortmem`` from the npm registry the first time it runs (it is
  cached after that), so the first autostart on a machine without the CLI needs the network.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from . import __version__
from .errors import OortError, OortUsageError

__all__ = [
    "socket_path_for",
    "home_from",
    "inspect_dir",
    "socket_trust",
    "find_oort",
    "trusted_path",
    "probe_env",
    "daemon_env",
    "start_daemon",
]

SUN_PATH_MAX = 103
MIN_NODE = (22, 15)


def home_from(env: Mapping[str, str]) -> str:
    """Oort's home: ``OORT_HOME`` (absolute), else ``$HOME/.oort``."""
    set_ = env.get("OORT_HOME", "")
    if set_:
        return os.path.abspath(set_)
    home = env.get("HOME") or os.path.expanduser("~")
    return os.path.abspath(os.path.join(home, ".oort"))


def _fnv1a64(text: str) -> str:
    h = 0xCBF29CE484222325
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


def socket_path_for(home: str, env: Mapping[str, str]) -> str:
    preferred = os.path.join(home, "oort.sock")
    if len(preferred.encode("utf-8")) <= SUN_PATH_MAX:
        return preferred
    name = f"{_fnv1a64(home)}.sock"
    runtime = env.get("XDG_RUNTIME_DIR")
    if runtime and os.path.isabs(runtime):
        in_runtime = os.path.join(runtime, "oort", name)
        if len(in_runtime.encode("utf-8")) <= SUN_PATH_MAX:
            return in_runtime
    uid = os.getuid() if hasattr(os, "getuid") else 0
    return os.path.join("/tmp", f"oort-{uid}", name)


def inspect_dir(d: str) -> str:
    """The socket directory as it is (``inspectDir``): ``ok``, ``absent``, ``symlink``,
    ``not-a-directory``, ``foreign``, ``writable-by-others`` or ``readable-by-others``."""
    try:
        st = os.lstat(d)
    except OSError:
        return "absent"
    if stat.S_ISLNK(st.st_mode):
        return "symlink"
    if not stat.S_ISDIR(st.st_mode):
        return "not-a-directory"
    if not hasattr(os, "getuid"):
        return "ok"
    if st.st_uid != os.getuid():
        return "foreign"
    if st.st_mode & 0o022:
        return "writable-by-others"
    if st.st_mode & 0o077:
        return "readable-by-others"
    return "ok"


def socket_trust(sock: str) -> str:
    """``trusted``, ``absent`` or ``untrusted``, exactly as the hooks judge the socket."""
    state = inspect_dir(os.path.dirname(sock))
    if state == "absent":
        return "absent"
    if state not in ("ok", "readable-by-others"):
        return "untrusted"
    try:
        st = os.lstat(sock)
    except OSError:
        return "absent"
    if not stat.S_ISSOCK(st.st_mode):
        return "untrusted"
    if hasattr(os, "getuid") and st.st_uid != os.getuid():
        return "untrusted"
    return "trusted"


_SEMVER = re.compile(r"(\d+)\.(\d+)\.(\d+)")

# What the ``--version`` probe (and ``node --version``) may see: enough to run a Node script, and
# the proxies; never an API key, token or any other secret of the app.
_PROBE_ALLOW = (
    "PATH", "HOME", "OORT_HOME", "LANG",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
)  # fmt: skip


def _abs_path_entries(path: str) -> List[str]:
    """The absolute entries of a PATH value: empty and relative ones mean 'here' to a shell and
    are skipped, never resolved against the working directory."""
    return [d for d in path.split(os.pathsep) if d and os.path.isabs(d)]


def probe_env(env: Mapping[str, str], home: str, path: Optional[str] = None) -> Dict[str, str]:
    """The environment of a probe: the allowlist above. PATH is ``path`` (the trusted directories
    ``safe_path`` built), else the absolute entries of the caller's."""
    out = {k: v for k, v in env.items() if k in _PROBE_ALLOW}
    out["PATH"] = path if path is not None else os.pathsep.join(_abs_path_entries(env.get("PATH") or ""))
    out["OORT_HOME"] = home
    return out


def _run_probe(argv: Sequence[str], env: Mapping[str, str], timeout: float) -> str:
    try:
        return subprocess.run(
            list(argv),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env=dict(env),
            stdin=subprocess.DEVNULL,
        ).stdout
    except (OSError, subprocess.SubprocessError, ValueError):
        return ""


def _version_of(cmd: Sequence[str], env: Mapping[str, str]) -> Optional[Tuple[int, int, int]]:
    m = _SEMVER.search(_run_probe([*cmd, "--version"], env, 15))
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def _minimum() -> Tuple[int, int, int]:
    """The oldest CLI autostart uses: this package's own minor (versions move in lockstep)."""
    m = _SEMVER.match(__version__)
    return (int(m.group(1)), int(m.group(2)), 0) if m else (0, 0, 0)


def _is_launcher(path: str) -> bool:
    """This package's own ``oort`` console script (it would only run npx or another oort)."""
    try:
        if os.path.getsize(path) > 16_384:
            return False
        with open(path, "rb") as f:
            head = f.read(16_384)
    except OSError:
        return False
    return b"oortmem.cli" in head or b"oortmem import cli" in head


# --- trust: whether a binary may be run (a port of trustedPath in packages/cli/src/trust.ts) ---

#: Directories every system clears or shares.
_SHARED_TEMP = ("/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/dev/shm")
#: Linux groups whose members can already become root: group write from them adds nothing.
_ROOT_GROUPS = ("root", "sudo", "wheel", "admin")


def temp_dirs(env: Mapping[str, str]) -> List[str]:
    """Every temporary directory, as given and as its realpath."""
    out: List[str] = []
    for p in (tempfile.gettempdir(), env.get("TMPDIR"), *_SHARED_TEMP):
        if not p or not os.path.isabs(p):
            continue
        for q in (os.path.normpath(p), os.path.realpath(p)):
            if q not in out:
                out.append(q)
    return out


def _inside(p: str, dirs: Sequence[str]) -> bool:
    return any(p == d or p.startswith(d if d.endswith(os.sep) else d + os.sep) for d in dirs)


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def group_can_become_root(gid: int) -> bool:
    """Whether members of group ``gid`` can already become root (``groupCanBecomeRoot``). macOS:
    ``wheel`` (0) and ``admin`` (80), by number. Elsewhere, from ``/etc/group``: ``root``,
    ``sudo``, ``wheel`` or ``admin``, or this user's private group (named after the user, with no
    other members and no other user's primary group). Never ``staff``."""
    if sys.platform == "darwin":
        return gid in (0, 80)
    if gid == 0:
        return True
    entry = None
    for line in _read("/etc/group").split("\n"):
        f = line.split(":")
        if len(f) >= 3 and f[2].strip().isdigit() and int(f[2]) == gid:
            entry = f
            break
    if entry is None:
        return False
    name = entry[0]
    if name in _ROOT_GROUPS:
        return True
    try:
        import pwd

        user = pwd.getpwuid(os.getuid()).pw_name
    except (ImportError, KeyError, OSError):
        return False
    members = [m.strip() for m in (entry[3] if len(entry) > 3 else "").split(",") if m.strip()]
    if name != user or any(m != user for m in members):
        return False
    for line in _read("/etc/passwd").split("\n"):
        f = line.split(":")
        if len(f) >= 4 and f[3].strip().isdigit() and int(f[3]) == gid and f[0] != user:
            return False
    return True


def trusted_path(
    file: str,
    home: str,
    strict: bool,
    group_ok: Optional[Callable[[int], bool]] = None,
    start: Optional[str] = None,
) -> Optional[str]:
    """Why ``file`` is not safe to run, or None when it is (``trustedPath``): its realpath is
    walked from ``/`` down to the file; each step must be one nobody else can change.

    Owner: this user's inside ``home`` (the user's HOME), this user's or root's elsewhere. Writable:
    ``strict`` (the managed copy): no group or other write anywhere; otherwise no other write
    (sticky or not, so ``/tmp`` fails), no group write inside ``home``, and outside it group write
    only from a group that can already become root. A path that does not resolve fails. ``start``
    skips the steps above it (tests, whose sandbox sits in a shared temp directory)."""
    if not hasattr(os, "getuid"):
        return None  # Windows has no such modes (and no autostart here)
    try:
        real = os.path.realpath(file, strict=True)
    except OSError:
        return f"{file} does not exist, or is a link that leads nowhere"
    me = os.getuid()
    try:
        home_real = os.path.realpath(home)
    except OSError:
        home_real = os.path.abspath(home)
    group_ok = group_ok or group_can_become_root
    steps: List[str] = []
    p = real
    while True:
        steps.insert(0, p)
        up = os.path.dirname(p)
        if up == p:
            break
        p = up
    if start is not None:
        s = os.path.realpath(start)
        steps = [x for x in steps if x == s or x.startswith(s + os.sep)]
    for p in steps:
        try:
            st = os.stat(p)
        except OSError:
            return f"{p} cannot be read"
        mine = p == home_real or p.startswith(home_real + os.sep)
        owned = st.st_uid == me
        if not owned and (mine or st.st_uid != 0):
            return f"{p} belongs to another user"
        others = st.st_mode & 0o002 != 0
        group = st.st_mode & 0o020 != 0 and (strict or mine or not group_ok(st.st_gid))
        if others or group:
            who = "group or others" if others and group else "others" if others else "its group"
            return f"{p} can be written by {who}"
    return None


def safe_path(
    env: Mapping[str, str],
    lead: Optional[str] = None,
    *,
    temp: Optional[Sequence[str]] = None,
    trust_from: Optional[str] = None,
    group_ok: Optional[Callable[[int], bool]] = None,
) -> str:
    """The PATH a child may see: ``lead`` (the trusted node's directory) first, then each absolute
    entry that is a trusted directory (``trusted_path``, lenient) and not a temp dir. Whatever
    the CLI or npx spawns next resolves through these only."""
    temps = temp_dirs(env) if temp is None else list(temp)
    user_home = env.get("HOME") or os.path.expanduser("~")
    out: List[str] = []
    for d in ([lead] if lead else []) + _abs_path_entries(env.get("PATH") or ""):
        try:
            real = os.path.realpath(d, strict=True)
        except OSError:
            continue
        if _inside(real, temps) or trusted_path(real, user_home, False, group_ok, trust_from) is not None:
            continue
        if d not in out:
            out.append(d)
    return os.pathsep.join(out)


def _absolute_which(name: str, path: str) -> Optional[str]:
    """The first executable ``name`` in an absolute PATH entry, as a realpath."""
    for d in _abs_path_entries(path):
        c = os.path.join(d, name)
        try:
            if os.path.isfile(c) and os.access(c, os.X_OK):
                return os.path.realpath(c)
        except OSError:
            continue
    return None


def _is_node_script(path: str) -> bool:
    """A JavaScript entry point (run as ``node <file>``, never through its shebang, which would
    resolve ``node`` from PATH)."""
    if path.endswith((".js", ".mjs", ".cjs")):
        return True
    try:
        with open(path, "rb") as f:
            head = f.read(256).split(b"\n", 1)[0]
    except OSError:
        return False
    return head.startswith(b"#!") and b"node" in head


def _node_ok(node: Optional[str], probe: Mapping[str, str]) -> bool:
    if node is None:
        return False
    m = re.match(r"v?(\d+)\.(\d+)", _run_probe([node, "--version"], probe, 10).strip())
    return m is not None and (int(m.group(1)), int(m.group(2))) >= MIN_NODE


def find_oort(
    home: str,
    env: Mapping[str, str],
    which: Optional[Callable[..., Optional[str]]] = None,
    *,
    temp: Optional[Sequence[str]] = None,
    trust_from: Optional[str] = None,
    group_ok: Optional[Callable[[int], bool]] = None,
) -> Optional[List[str]]:
    """The command that runs a new enough, trusted CLI, or None (no Node, or no usable CLI and
    no npx). Nothing untrusted is executed, not even to ask its version.

    ``which(name, path)`` finds ``npx`` and ``node`` (default: the first absolute PATH hit);
    ``temp``, ``trust_from`` and ``group_ok`` let tests stand in for the machine."""
    minimum = _minimum()
    path = env.get("PATH") or ""
    user_home = env.get("HOME") or os.path.expanduser("~")
    temps = temp_dirs(env) if temp is None else list(temp)
    find_ = which or (lambda n, p=None: _absolute_which(n, p if p is not None else path))
    # `node` is resolved once, from absolute PATH entries, and trusted by the same rules as the
    # CLI: a JavaScript `oort` is run as `node <file>`, never through `#!/usr/bin/env node`.
    node = find_("node", path)
    node = os.path.realpath(node) if node and os.path.isabs(node) else None
    if node is not None and (
        _inside(node, temps) or trusted_path(node, user_home, False, group_ok, trust_from) is not None
    ):
        node = None
    # Everything the probes (and, later, the daemon) spawn resolves through trusted directories.
    sp = safe_path(
        env, os.path.dirname(node) if node else None, temp=temps, trust_from=trust_from, group_ok=group_ok
    )
    probe = probe_env(env, home, sp)
    candidates: List[Tuple[str, bool]] = []
    managed = os.path.join(home, "cli", "bin", "oort")
    if os.path.isfile(managed) and os.access(managed, os.X_OK):
        candidates.append((managed, True))
    for d in _abs_path_entries(path):
        c = os.path.join(d, "oort")
        if os.path.isfile(c) and os.access(c, os.X_OK):
            candidates.append((c, False))
    seen = set()
    for c, strict in candidates:
        try:
            real = os.path.realpath(c, strict=True)
        except OSError:
            continue
        if real in seen or not os.path.isabs(real):
            continue
        seen.add(real)
        if not strict and _is_launcher(real):
            continue
        # A copy under the home you chose is yours; one that resolves into a temp dir from
        # elsewhere (or any PATH copy there) is cleaned or shared: never run.
        if _inside(real, temps) and not (strict and _inside(real, [os.path.realpath(home)])):
            continue
        if trusted_path(real, user_home if not strict else home, strict, group_ok, trust_from) is not None:
            continue
        cmd = [real]
        if _is_node_script(real):
            if node is None:
                continue
            cmd = [node, real]
        v = _version_of(cmd, probe)
        if v is not None and v >= minimum:
            return cmd
    # npx is judged like the CLI (it is a program we run): real path, not in a temp dir, trusted
    # (the first PATH hit that is, not only the first hit); and it runs as `node <npx>`, never
    # through its shebang.
    if node is not None and _node_ok(node, probe):
        hits = [which("npx", path)] if which else [
            os.path.join(d, "npx") for d in _abs_path_entries(path)
        ]
        for npx in hits:
            try:
                if not npx or not os.path.isabs(npx) or not os.access(npx, os.X_OK) or os.path.isdir(npx):
                    continue
                npx_real = os.path.realpath(npx, strict=True)
            except OSError:
                continue
            if _inside(npx_real, temps) or trusted_path(npx_real, user_home, False, group_ok, trust_from) is not None:
                continue
            return [node, npx_real, "--yes", f"oortmem@{__version__}"]
    return None


# What an autostarted daemon may see of this process's environment (section 8.1.6).
_ALLOW = ("PATH", "HOME", "LANG", "TMPDIR", "XDG_RUNTIME_DIR", "VOYAGE_API_KEY", "TYPESAFE_API_KEY",
          "ANTHROPIC_API_KEY", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "NO_PROXY")
# OORT_* travels, except the service token and the agent (each request names its own agent).
_DENY = ("OORT_SERVE_TOKEN", "OORT_SERVE_TOKEN_FILE", "OORT_AGENT", "OORT_OUTPUT")


def daemon_env(
    env: Mapping[str, str],
    home: str,
    lead: Optional[str] = None,
    *,
    temp: Optional[Sequence[str]] = None,
    trust_from: Optional[str] = None,
    group_ok: Optional[Callable[[int], bool]] = None,
) -> Dict[str, str]:
    out = {k: v for k, v in env.items() if k in _ALLOW or (k.startswith("OORT_") and k not in _DENY)}
    # Only trusted absolute directories, the trusted node's first (``safe_path``): a relative or
    # untrusted entry must never resolve `node` or anything else the daemon spawns.
    out["PATH"] = safe_path(env, lead, temp=temp, trust_from=trust_from, group_ok=group_ok)
    out["OORT_HOME"] = home
    return out


def autostart_failed(why: str) -> OortError:
    return OortUsageError(
        f"oort serve could not be started ({why}). Run `oort serve --detach` yourself to see why, or set mode='cloud' or mode='remote'.",
        fix="oort serve --detach",
        reason="autostart-failed",
    )


def start_daemon(cmd: Sequence[str], env: Mapping[str, str], home: str) -> None:
    """``<oort> serve --detach``, once; it returns when the daemon answers (or gives up). A
    command that cannot be run (gone, not executable, a timeout) is an ``OortUsageError`` with the
    fix, not an ``OSError``."""
    try:
        subprocess.run(
            [*cmd, "serve", "--detach"],
            env=daemon_env(env, home, os.path.dirname(cmd[0]) if os.path.isabs(cmd[0]) else None),
            cwd=home if os.path.isdir(home) else None,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=120,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise autostart_failed("it did not finish in 120 seconds") from None
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        raise autostart_failed(type(e).__name__) from None


def unsupported_platform() -> bool:
    return sys.platform == "win32"
