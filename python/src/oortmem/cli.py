"""Run the Oort CLI from Python.

Oort is written in TypeScript and ships on npm as `oortmem`; it needs Node 22.15 or newer.
This launcher runs an `oort` command that is already installed. Otherwise it runs the
matching npm release through npx. Arguments, stdin, stdout and the exit code pass through
unchanged.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from typing import Callable, Iterable, Optional, Sequence

from . import __version__

MIN_NODE = (22, 15)
NPM_SPEC = f"oortmem@{__version__}"
# Set on the child so a launcher that finds itself (or another copy of itself) on PATH
# skips the PATH lookup instead of starting itself forever.
GUARD = "OORTMEM_PY_LAUNCHER"

HELP = f"""oort needs Node.js {MIN_NODE[0]}.{MIN_NODE[1]} or newer, and none was found.

Install Node from https://nodejs.org, then run this command again. Or install the CLI
directly with npm:

    npm install -g oortmem

Docs: https://oortcloud.dev/docs
"""


def node_version(node: str) -> Optional[tuple[int, int]]:
    """The (major, minor) of `node --version`, or None when it cannot be run or read."""
    try:
        out = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=10, check=False
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r"v?(\d+)\.(\d+)", out.strip())
    return (int(m.group(1)), int(m.group(2))) if m else None


def path_candidates(name: str, path: Optional[str]) -> Iterable[str]:
    """Every executable called `name` on PATH, in PATH order."""
    seen = set()
    for d in (path or "").split(os.pathsep):
        if not d:
            continue
        found = shutil.which(name, path=d)
        if found and found not in seen:
            seen.add(found)
            yield found


def same_file(a: str, b: Optional[str]) -> bool:
    if not b:
        return False
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def resolve(
    env: Optional[dict] = None,
    self_path: Optional[str] = None,
    candidates: Callable[[str, Optional[str]], Iterable[str]] = path_candidates,
    which: Callable[[str], Optional[str]] = shutil.which,
    version: Callable[[str], Optional[tuple[int, int]]] = node_version,
) -> Optional[list[str]]:
    """The command to run: an installed `oort`, else npx with the pinned release, else None."""
    env = os.environ if env is None else env
    if not env.get(GUARD):
        for oort in candidates("oort", env.get("PATH")):
            if not same_file(oort, self_path):
                return [oort]
    node, npx = which("node"), which("npx")
    if node and npx:
        v = version(node)
        if v is not None and v >= MIN_NODE:
            return [npx, "--yes", NPM_SPEC]
    return None


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args == ["--launcher-version"]:
        print(f"oortmem (Python launcher) {__version__}, runs {NPM_SPEC}")
        return 0
    self_path = shutil.which(sys.argv[0]) or sys.argv[0]
    cmd = resolve(self_path=self_path)
    if cmd is None:
        sys.stderr.write(HELP)
        return 1
    try:
        return subprocess.call(cmd + args, env={**os.environ, GUARD: "1"})
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
