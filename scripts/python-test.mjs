#!/usr/bin/env node
// Runs the Python package's tests (python/tests: the launcher, the native client, the shared
// golden vectors, and the integration test against the built CLI) on a Python 3.10 or newer:
// OORT_PYTHON, else the repo's .venv, else python3. Part of `pnpm verify`; the build runs first,
// so the integration test meets the real daemon. OORT_SKIP_PYTHON=1 skips it (never in CI).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [process.env.OORT_PYTHON, path.join(ROOT, '.venv/bin/python'), 'python3'].filter(
  (c) => c !== undefined && c !== '' && (!c.includes('/') || existsSync(c)),
);
const python = candidates.find(
  (c) =>
    spawnSync(c, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)']).status ===
    0,
);
if (python === undefined) {
  if (process.env.OORT_SKIP_PYTHON === '1' && process.env.CI === undefined) {
    console.warn('python-test: skipped (OORT_SKIP_PYTHON=1)');
    process.exit(0);
  }
  console.error(
    'python-test: needs Python 3.10 or newer (set OORT_PYTHON, or OORT_SKIP_PYTHON=1 locally)',
  );
  process.exit(1);
}
const r = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'python/tests'], {
  cwd: ROOT,
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
