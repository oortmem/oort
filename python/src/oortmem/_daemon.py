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
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import sys
from typing import Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from . import __version__

__all__ = [
    "socket_path_for",
    "home_from",
    "inspect_dir",
    "socket_trust",
    "find_oort",
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


def _version_of(cmd: Sequence[str], env: Mapping[str, str]) -> Optional[Tuple[int, int, int]]:
    try:
        out = subprocess.run(
            [*cmd, "--version"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
            env=dict(env),
            stdin=subprocess.DEVNULL,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = _SEMVER.search(out)
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


def _node_ok(which: Callable[[str], Optional[str]]) -> bool:
    node = which("node")
    if node is None:
        return False
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    m = re.match(r"v?(\d+)\.(\d+)", out.strip())
    return m is not None and (int(m.group(1)), int(m.group(2))) >= MIN_NODE


def find_oort(
    home: str,
    env: Mapping[str, str],
    which: Callable[..., Optional[str]] = shutil.which,
) -> Optional[List[str]]:
    """The command that runs a new enough CLI, or None (no Node, or no CLI and no npx)."""
    minimum = _minimum()
    candidates: List[str] = []
    managed = os.path.join(home, "cli", "bin", "oort")
    if os.path.isfile(managed) and os.access(managed, os.X_OK):
        candidates.append(managed)
    seen = set()
    for d in (env.get("PATH") or "").split(os.pathsep):
        if not d:
            continue
        found = which("oort", path=d)
        if found and found not in seen:
            seen.add(found)
            if not _is_launcher(found):
                candidates.append(found)
    for c in candidates:
        v = _version_of([c], env)
        if v is not None and v >= minimum:
            return [c]
    npx = which("npx", path=env.get("PATH"))
    if npx and _node_ok(lambda n: which(n, path=env.get("PATH"))):
        return [npx, "--yes", f"oortmem@{__version__}"]
    return None


# What an autostarted daemon may see of this process's environment (section 8.1.6).
_ALLOW = ("PATH", "HOME", "LANG", "TMPDIR", "XDG_RUNTIME_DIR", "VOYAGE_API_KEY", "TYPESAFE_API_KEY",
          "ANTHROPIC_API_KEY", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "NO_PROXY")
# OORT_* travels, except the service token and the agent (each request names its own agent).
_DENY = ("OORT_SERVE_TOKEN", "OORT_SERVE_TOKEN_FILE", "OORT_AGENT", "OORT_OUTPUT")


def daemon_env(env: Mapping[str, str], home: str) -> Dict[str, str]:
    out = {k: v for k, v in env.items() if k in _ALLOW or (k.startswith("OORT_") and k not in _DENY)}
    out["OORT_HOME"] = home
    return out


def start_daemon(cmd: Sequence[str], env: Mapping[str, str], home: str) -> None:
    """``<oort> serve --detach``, once; it returns when the daemon answers (or gives up)."""
    subprocess.run(
        [*cmd, "serve", "--detach"],
        env=daemon_env(env, home),
        cwd=home if os.path.isdir(home) else None,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=120,
        check=False,
    )


def unsupported_platform() -> bool:
    return sys.platform == "win32"
