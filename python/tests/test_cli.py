import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from oortmem import __version__, cli  # noqa: E402


def none(_name):
    return None


class Resolve(unittest.TestCase):
    def test_prefers_an_installed_oort(self):
        cmd = cli.resolve(
            env={"PATH": "/x"},
            candidates=lambda n, p: ["/usr/local/bin/oort"],
            which=none,
        )
        self.assertEqual(cmd, ["/usr/local/bin/oort"])

    def test_falls_back_to_npx_with_the_pinned_release(self):
        which = {"node": "/n/node", "npx": "/n/npx"}.get
        cmd = cli.resolve(env={}, candidates=lambda n, p: [], which=which, version=lambda _: (22, 15))
        self.assertEqual(cmd, ["/n/npx", "--yes", f"oortmem@{__version__}"])

    def test_old_node_is_not_used(self):
        which = {"node": "/n/node", "npx": "/n/npx"}.get
        cmd = cli.resolve(env={}, candidates=lambda n, p: [], which=which, version=lambda _: (22, 14))
        self.assertIsNone(cmd)

    def test_unreadable_node_version_is_not_used(self):
        which = {"node": "/n/node", "npx": "/n/npx"}.get
        cmd = cli.resolve(env={}, candidates=lambda n, p: [], which=which, version=lambda _: None)
        self.assertIsNone(cmd)

    def test_nothing_installed(self):
        self.assertIsNone(cli.resolve(env={}, candidates=lambda n, p: [], which=none))

    def test_guard_skips_path_lookup(self):
        def boom(n, p):
            raise AssertionError("PATH must not be searched under the guard")

        cmd = cli.resolve(env={cli.GUARD: "1"}, candidates=boom, which=none)
        self.assertIsNone(cmd)


class NeverRunsItself(unittest.TestCase):
    """The Python `oort` script must skip itself on PATH and use the real CLI after it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.first, self.second = root / "a", root / "b"
        self.first.mkdir()
        self.second.mkdir()
        self.me = self._exe(self.first / "oort")
        self.real = self._exe(self.second / "oort")
        self.path = os.pathsep.join([str(self.first), str(self.second)])

    def tearDown(self):
        self.tmp.cleanup()

    def _exe(self, p):
        p.write_text("#!/bin/sh\nexit 0\n")
        p.chmod(p.stat().st_mode | stat.S_IXUSR)
        return p

    @unittest.skipIf(os.name == "nt", "POSIX shell scripts")
    def test_skips_itself_and_finds_the_next(self):
        cmd = cli.resolve(env={"PATH": self.path}, self_path=str(self.me), which=none)
        self.assertEqual(cmd, [str(self.real)])

    @unittest.skipIf(os.name == "nt", "POSIX shell scripts")
    def test_only_itself_on_path_falls_through(self):
        cmd = cli.resolve(env={"PATH": str(self.first)}, self_path=str(self.me), which=none)
        self.assertIsNone(cmd)


class Main(unittest.TestCase):
    def test_launcher_version(self):
        out = subprocess.run(
            [sys.executable, "-m", "oortmem", "--launcher-version"],
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONPATH": str(Path(cli.__file__).parents[1])},
        )
        self.assertEqual(out.returncode, 0)
        self.assertIn(f"oortmem@{__version__}", out.stdout)

    def test_no_node_prints_help_and_exits_1(self):
        out = subprocess.run(
            [sys.executable, "-m", "oortmem", "setup"],
            capture_output=True,
            text=True,
            env={"PATH": "", "PYTHONPATH": str(Path(cli.__file__).parents[1])},
        )
        self.assertEqual(out.returncode, 1)
        self.assertIn("npm install -g oortmem", out.stderr)


if __name__ == "__main__":
    unittest.main()
