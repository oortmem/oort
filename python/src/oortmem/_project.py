"""The project a cwd belongs to (cloud mode), ported from core's ``scope.ts``: the id the CLI and
the hooks derive, so Python reads and writes the same project in Oort Cloud. Reads files only;
never runs git. The shared vectors (``contract/sdk/vectors/project-id.json``) pin the port.

- ``<basename>-<sha256(main root)[:8]>``, with a linked worktree resolved to its main checkout
  only when the main repository vouches for it (``commondir`` and the ``gitdir`` back-pointer).
- ``cfg:<id>`` when ``$OORT_HOME/project-links.json`` binds the main root (``oort project link``).
- Paths are canonicalised by ``realpath(3)``, as Node's ``realpathSync.native``: one spelling per
  directory on a case-insensitive disk.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import hashlib
import json
import os
from typing import Dict, Optional

__all__ = ["canonical_path", "project_root_for", "project_id_for", "resolve_project", "stated_privacy"]

CONFIGURED_ID_PREFIX = "cfg:"

_libc_realpath = None
if os.name == "posix":
    try:
        _libc = ctypes.CDLL(ctypes.util.find_library("c") or None, use_errno=True)
        _libc_realpath = _libc.realpath
        _libc_realpath.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        _libc_realpath.restype = ctypes.c_char_p
    except (OSError, AttributeError):  # pragma: no cover - every POSIX libc has realpath
        _libc_realpath = None


def canonical_path(p: str) -> str:
    """``p`` absolute, then realpathed by the OS, or ``p`` absolute when it cannot be."""
    resolved = os.path.abspath(p)
    if _libc_realpath is not None:
        buf = ctypes.create_string_buffer(4096)
        out = _libc_realpath(os.fsencode(resolved), buf)
        if out is None:
            return resolved
        return os.fsdecode(buf.value)
    try:
        return os.path.realpath(resolved, strict=True)
    except (OSError, TypeError):
        return resolved


def _realpath(p: str) -> str:
    """``fs.realpathSync.native``: raises when the path does not exist."""
    if _libc_realpath is not None:
        buf = ctypes.create_string_buffer(4096)
        if _libc_realpath(os.fsencode(p), buf) is None:
            raise FileNotFoundError(p)
        return os.fsdecode(buf.value)
    return os.path.realpath(p, strict=True)


def _find_git_root(start: str) -> Optional[str]:
    d = canonical_path(start)
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def _read(p: str) -> str:
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


def _main_root_of(root: str) -> str:
    import re

    own = canonical_path(root)
    dot_git = os.path.join(root, ".git")
    try:
        if os.path.islink(dot_git):
            return own
        if os.path.isdir(dot_git):
            return own
        m = re.search(r"^gitdir:\s*(.+?)\s*$", _read(dot_git), re.MULTILINE)
        if m is None:
            return own
        # path.resolve: joined and normalised lexically, then realpathed.
        gitdir = _realpath(os.path.normpath(os.path.join(os.path.abspath(root), m.group(1))))
        common = _read(os.path.join(gitdir, "commondir")).strip()
        if common == "":
            return own
        common_dir = _realpath(os.path.normpath(os.path.join(gitdir, common)))
        if not os.path.isdir(common_dir):
            return own
        if os.path.dirname(gitdir) != os.path.join(common_dir, "worktrees"):
            return own
        back = _read(os.path.join(gitdir, "gitdir")).strip()
        if back == "":
            return own
        if _realpath(os.path.normpath(os.path.join(gitdir, back))) != os.path.join(own, ".git"):
            return own
        return os.path.dirname(common_dir) if os.path.basename(common_dir) == ".git" else common_dir
    except (OSError, UnicodeDecodeError):
        return own


def project_root_for(cwd: str) -> Optional[str]:
    root = _find_git_root(cwd)
    return None if root is None else _main_root_of(root)


def project_id_for(cwd: str) -> Optional[str]:
    """The id derived from the main repository root above ``cwd``, or None outside one."""
    root = project_root_for(cwd)
    if root is None:
        return None
    digest = hashlib.sha256(root.encode("utf-8")).hexdigest()[:8]
    return f"{os.path.basename(root).replace(':', '_')}-{digest}"


def _links(home: str) -> Dict[str, str]:
    try:
        raw = json.loads(_read(os.path.join(home, "project-links.json")))
    except (OSError, ValueError):
        return {}
    links = raw.get("links") if isinstance(raw, dict) else None
    if not isinstance(links, dict):
        return {}
    return {k: v for k, v in links.items() if isinstance(v, str) and v != ""}


def resolve_project(cwd: str, home: str) -> Optional[str]:
    """The project id for ``cwd``: a trust binding's ``cfg:<id>``, else the derived id."""
    root = project_root_for(cwd)
    if root is None:
        return None
    bound = _links(home).get(root)
    if bound is not None:
        return CONFIGURED_ID_PREFIX + bound
    return project_id_for(cwd)


def stated_privacy(cwd: str) -> Optional[bool]:
    """``project.private`` from the nearest ``oort.config.json`` above ``cwd``, when it states one
    (sent as ``projectPrivate``; never guessed)."""
    d = os.path.abspath(cwd)
    while True:
        f = os.path.join(d, "oort.config.json")
        if os.path.exists(f):
            try:
                raw = json.loads(_read(f))
            except (OSError, ValueError):
                return None
            project = raw.get("project") if isinstance(raw, dict) else None
            v = project.get("private") if isinstance(project, dict) else None
            return v if isinstance(v, bool) else None
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent
