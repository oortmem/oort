/**
 * No test ever runs the real npm (CON-114). Before each test file, a stand-in `npm` goes first on
 * this process's PATH, so every child a test starts finds it before the real one: the real bin
 * spawned with a copy of `process.env.PATH`, execa (which extends the environment by default),
 * anything else that inherits it. The stand-in installs nothing, writes what it was asked into a
 * marker and exits 1; after the file's tests, a marker fails the file loudly. Tests that exercise
 * a failing npm on purpose put their own stand-in (`npmTrap`) ahead of this one.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oort-no-real-npm-')));
const ran = path.join(dir, 'NPM_RAN');
const script = `#!/bin/sh\necho "$@" >> '${ran}'\necho 'no-real-npm: a test tried to run npm; tests never run the real one' >&2\nexit 1\n`;
for (const name of ['npm', 'npx']) {
  fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
}
process.env['PATH'] = `${dir}${path.delimiter}${process.env['PATH'] ?? ''}`;
/** Where the stand-in lives, for the test that checks it is in place. */
process.env['OORT_TEST_NPM_GUARD'] = dir;

afterAll(() => {
  const asked = fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8').trim() : undefined;
  fs.rmSync(dir, { recursive: true, force: true });
  if (asked !== undefined) {
    throw new Error(
      `A test ran npm (${asked}) without a stand-in of its own first on PATH. Tests never run the real npm: fake it (fakeNpm, ctx.updateDeps) or put npmTrap(root).dir first on the child's PATH.`,
    );
  }
});
