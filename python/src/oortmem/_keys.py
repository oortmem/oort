"""The Oort key (cloud mode): given in code, then ``OORT_API_KEY``, then where ``oort login`` put
it (the macOS Keychain item ``oort.oort``, or ``$OORT_HOME/credentials.json`` elsewhere), as the
CLI's ``credentials.ts`` reads it. A key is never logged, printed or put into an error."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from typing import Callable, Mapping, Optional, Sequence

from ._secret import _Secret

__all__ = ["find_oort_key", "KEY_SOURCES"]

KEY_SOURCES = ("explicit", "env", "keychain")
SECURITY = "/usr/bin/security"

Keychain = Callable[[], Optional[str]]


def _macos_keychain() -> Optional[str]:
    """``security find-generic-password -a <user> -s oort.oort -w``; no key on any failure."""
    import getpass

    try:
        out = subprocess.run(
            [SECURITY, "find-generic-password", "-a", getpass.getuser(), "-s", "oort.oort", "-w"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    key = out.stdout.rstrip("\r\n").strip()
    return key or None


def credentials_file_key(home: str) -> Optional[str]:
    """``credentials.json``'s ``oort`` key. Refused (None) when the file is not a regular file,
    is not this user's, or group or others may read it: then other users could read the key."""
    path = os.path.join(home, "credentials.json")
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            return None
        if os.name == "posix":
            if st.st_uid != os.getuid() or (st.st_mode & 0o077) != 0:
                return None
        with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return None
    finally:
        os.close(fd)
    keys = raw.get("keys") if isinstance(raw, dict) else None
    v = keys.get("oort") if isinstance(keys, dict) else None
    return v if isinstance(v, str) and v != "" else None


def find_oort_key(
    *,
    explicit: Optional[str],
    env: Mapping[str, str],
    home: str,
    sources: Sequence[str],
    keychain: Optional[Keychain] = None,
) -> Optional[_Secret]:
    """The first Oort key found in ``sources`` order (explicit, env, keychain)."""
    if "explicit" in sources and explicit:
        return _Secret(explicit)
    if "env" in sources:
        v = env.get("OORT_API_KEY", "")
        if v:
            return _Secret(v)
    if "keychain" in sources and env.get("OORT_NO_KEYCHAIN") != "1":
        if keychain is not None:
            v = keychain()
        elif sys.platform == "darwin":
            v = _macos_keychain()
        else:
            v = credentials_file_key(home)
        if v:
            return _Secret(v)
    return None
