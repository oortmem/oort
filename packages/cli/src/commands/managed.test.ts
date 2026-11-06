/**
 * The managed copy (CON-114): `oort install` and `oort connect` point agents at `$OORT_HOME/cli`
 * when it checks out, and from a temporary copy install it first or refuse. Every npm is a fake
 * (`fakeNpm`) behind a stand-in on PATH: nothing is installed, nothing reaches the network.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION } from '@oortmem/core';
import {
  data,
  fakeNpm,
  harness,
  npmPrefixCopy,
  npmTrap,
  tmpdir,
  trustedTmpdir,
  type Harness,
} from '../../test/helpers.js';
import { tempDirs } from '../trust.js';
import { Refusal } from '../util.js';
import { unstableCopy } from './install.js';
import {
  checkAgentPath,
  inspectManaged,
  installCommandFor,
  installManaged,
  managedCopy,
  manualInstall,
  plannedMain,
  shellPath,
  shownPrefix,
} from './managed.js';
import { classifyCopy, defaultUpdateDeps } from './update.js';

/** A copy in npx's cache, as `npx oortmem` runs it: the entry of a transient run. */
function npxEntry(h: Harness): string {
  const dist = path.join(h.root, '.npm', '_npx', '6a1f2b', 'node_modules', 'oortmem', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const main = path.join(dist, 'main.js');
  fs.writeFileSync(main, '#!/bin/sh\n', { mode: 0o755 });
  return main;
}

const settings = (h: Harness): string => path.join(h.root, '.claude', 'settings.json');

describe('the managed copy', () => {
  it('managed.checks-out-only-when-the-bin-resolves-into-its-prefix', () => {
    const h = harness({ trusted: true });
    const env = { HOME: h.root, OORT_HOME: h.home };
    expect(managedCopy(env)).toBeUndefined();
    const prefix = path.join(h.home, 'cli');
    const m = npmPrefixCopy(prefix, VERSION);
    expect(managedCopy(env)).toEqual({
      prefix,
      bin: m.bin,
      main: m.main,
      version: VERSION,
    });
    expect(plannedMain(env)).toBe(m.main);
    // A bin that points out of the prefix is not the managed copy.
    const elsewhere = npmPrefixCopy(path.join(h.root, 'elsewhere'), VERSION);
    fs.rmSync(m.bin);
    fs.symlinkSync(elsewhere.main, m.bin);
    expect(managedCopy(env)).toBeUndefined();
    // Nor is a package that is not oortmem.
    fs.rmSync(m.bin);
    fs.symlinkSync(m.main, m.bin);
    fs.writeFileSync(
      path.join(prefix, 'lib', 'node_modules', 'oortmem', 'package.json'),
      JSON.stringify({ name: 'not-oort', version: VERSION }),
    );
    expect(managedCopy(env)).toBeUndefined();
  });

  it('install.points-the-hooks-at-a-managed-copy-that-checks-out', async () => {
    const h = harness({ trusted: true });
    const m = npmPrefixCopy(path.join(h.home, 'cli'), VERSION);
    const npm = fakeNpm();
    const r = await h.run(
      ['install', 'claude-code', '--json'],
      { env: { HOME: h.root, OORT_HOME: h.home, PATH: npmTrap(h.root).dir } },
      undefined,
      { updateDeps: npm.deps },
    );
    expect(r.code, r.io.stderr).toBe(0);
    expect(npm.calls).toEqual([]);
    expect(data(r.io.stdout, 'install')).toMatchObject({
      command: m.main,
      binary: 'managed',
      installedManaged: false,
      version: VERSION,
    });
    expect(fs.readFileSync(settings(h), 'utf8')).toContain(`${m.main} hook SessionStart`);
    expect(r.io.stderr).toContain('the managed copy: oort update keeps it current');
  });

  it('install.from-a-transient-copy-installs-the-managed-copy-first', async () => {
    const h = harness({ trusted: true });
    const npm = fakeNpm();
    const r = await h.run(
      ['install', 'claude-code'],
      { env: { HOME: h.root, OORT_HOME: h.home, PATH: npmTrap(h.root).dir }, entry: npxEntry(h) },
      undefined,
      { updateDeps: npm.deps },
    );
    expect(r.code, r.io.stderr).toBe(0);
    expect(npm.calls.map((c) => c.args)).toEqual([
      ['i', '-g', '--prefix', path.join(h.home, 'cli'), `oortmem@${VERSION}`, '--prefer-online'],
    ]);
    expect(r.io.stdout).toContain(
      `This oort is in a package cache, which agents would lose later: installing oort ${VERSION} in ~/oort-home/cli first`,
    );
    const text = fs.readFileSync(settings(h), 'utf8');
    expect(text).toContain(path.join(h.home, 'cli', 'lib', 'node_modules', 'oortmem'));
    expect(text).not.toContain('_npx');
  });

  it('install.from-a-transient-copy-without-npm-refuses-with-the-commands', async () => {
    const h = harness({ trusted: true });
    for (const [env, deps] of [
      [{ PATH: '' }, {}],
      [{ PATH: npmTrap(h.root).dir }, { updateDeps: fakeNpm({ fail: 'npm ERR! E500\n' }).deps }],
    ] as const) {
      const r = await h.run(
        ['install', 'claude-code'],
        { env: { HOME: h.root, OORT_HOME: h.home, ...env }, entry: npxEntry(h) },
        undefined,
        deps,
      );
      expect(r.code).toBe(2);
      expect(r.io.stderr).toContain('This oort is in a package cache');
      expect(r.io.stderr).toContain(
        'Run `npm i -g --prefix ~/oort-home/cli oortmem`, then `~/oort-home/cli/bin/oort install claude-code`.',
      );
      expect(fs.existsSync(settings(h))).toBe(false);
    }
  });

  it('connect.from-a-transient-copy-writes-the-managed-copy-and-dry-run-installs-nothing', async () => {
    const h = harness({ trusted: true });
    fs.mkdirSync(path.join(h.root, '.cursor'));
    const cursor = path.join(h.root, '.cursor', 'mcp.json');
    const npm = fakeNpm();
    const io = {
      env: { HOME: h.root, OORT_HOME: h.home, PATH: npmTrap(h.root).dir },
      entry: npxEntry(h),
    };
    const dry = await h.run(['connect', 'cursor', '--dry-run', '--json'], io, undefined, {
      updateDeps: npm.deps,
    });
    expect(dry.code, dry.io.stderr).toBe(0);
    expect(npm.calls).toEqual([]);
    expect(dry.io.stderr).toContain('`oort connect cursor` installs oort');
    expect((data(dry.io.stdout, 'connect') as { command: string }).command).toBe(
      path.join(h.home, 'cli', 'lib', 'node_modules', 'oortmem', 'dist', 'main.js'),
    );
    expect(fs.existsSync(cursor)).toBe(false);

    const r = await h.run(['connect', 'cursor', '--json'], io, undefined, { updateDeps: npm.deps });
    expect(r.code, r.io.stderr).toBe(0);
    expect(npm.calls).toHaveLength(1);
    const d = data(r.io.stdout, 'connect') as { command: string; binary: string };
    expect(d.binary).toBe('managed');
    expect(fs.readFileSync(cursor, 'utf8')).toContain(d.command);
    expect(fs.readFileSync(cursor, 'utf8')).not.toContain('_npx');
    // `oort install cursor` is `oort connect cursor`: the managed copy, now there, is reused.
    const again = await h.run(['install', 'cursor'], io, undefined, { updateDeps: npm.deps });
    expect(again.code, again.io.stderr).toBe(0);
    expect(npm.calls).toHaveLength(1);
  });

  it('uninstall.needs-no-bin-and-never-installs', async () => {
    const h = harness({ trusted: true });
    const m = npmPrefixCopy(path.join(h.home, 'cli'), VERSION);
    const env = { HOME: h.root, OORT_HOME: h.home, PATH: npmTrap(h.root).dir };
    expect((await h.run(['install', 'claude-code'], { env })).code).toBe(0);
    fs.rmSync(path.join(h.home, 'cli'), { recursive: true });
    const npm = fakeNpm();
    const r = await h.run(['uninstall', 'claude-code'], { env, entry: npxEntry(h) }, undefined, {
      updateDeps: npm.deps,
    });
    expect(r.code, r.io.stderr).toBe(0);
    expect(npm.calls).toEqual([]);
    expect(fs.readFileSync(settings(h), 'utf8')).not.toContain(m.main);
  });

  it('this-copy.from-a-transient-copy-still-refuses-and-installs-nothing', async () => {
    const h = harness({ trusted: true });
    fs.mkdirSync(path.join(h.root, '.cursor'));
    // A managed copy is there, and npm too: --this-copy uses neither.
    npmPrefixCopy(path.join(h.home, 'cli'), VERSION);
    const npm = fakeNpm();
    const io = {
      env: { HOME: h.root, OORT_HOME: h.home, PATH: npmTrap(h.root).dir },
      entry: npxEntry(h),
    };
    for (const args of [
      ['install', 'claude-code', '--this-copy'],
      ['connect', 'cursor', '--this-copy'],
      ['install', 'cursor', '--this-copy', '--json'],
    ]) {
      const r = await h.run(args, io, undefined, { updateDeps: npm.deps });
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.io.stderr + r.io.stdout).toContain(
        'This oort is in a package cache, which agents would lose later, so --this-copy will not write it.',
      );
    }
    expect(npm.calls).toEqual([]);
    expect(fs.existsSync(settings(h))).toBe(false);
    expect(fs.existsSync(path.join(h.root, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('tests.never-reach-the-real-npm (test/no-real-npm.ts)', async () => {
    // The guard's stand-in comes first on this process's PATH, so on any child's that copies it.
    const guard = process.env['OORT_TEST_NPM_GUARD'];
    expect(guard).toBeDefined();
    const { onPath } = await import('./update.js');
    expect(onPath('npm', process.env)[0]).toBe(path.join(guard!, 'npm'));
    expect(onPath('npx', process.env)[0]).toBe(path.join(guard!, 'npx'));
  });
});

/**
 * PR #78's security review: where a binary lives decides whether agents may run it. The probes'
 * HOMEs (scratchpad/probes/h*) are rebuilt here as throwaway roots.
 */
describe('PR #78 review: trusting where a binary lives', () => {
  /** A copy of the fake package at `dir`, with `<dir>/dist/main.js`; the script's realpath. */
  function looseCopy(dir: string, version = VERSION): string {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'oortmem', version }));
    fs.writeFileSync(path.join(dir, 'dist', 'main.js'), '#!/bin/sh\n', { mode: 0o755 });
    return fs.realpathSync(path.join(dir, 'dist', 'main.js'));
  }

  it('I1.a-world-writable-oort-home-with-a-planted-copy-is-refused-everywhere (probe p1/h5)', async () => {
    const h = harness({ trusted: true });
    fs.mkdirSync(path.join(h.root, '.cursor'));
    const planted = npmPrefixCopy(path.join(h.home, 'cli'), '99.0.0');
    fs.chmodSync(h.home, 0o777);
    const env = { HOME: h.root, OORT_HOME: h.home, PATH: npmTrap(h.root).dir };
    const state = inspectManaged(env);
    expect(state).toMatchObject({
      state: 'untrusted',
      problem: {
        dir: h.home,
        why: 'can be written by group or others',
        fix: `chmod go-w ${h.home}`,
      },
    });
    expect(managedCopy(env)).toBeUndefined();
    const npm = fakeNpm();
    for (const args of [
      ['install', 'claude-code'],
      ['connect', 'cursor'],
    ]) {
      const r = await h.run(args, { env }, undefined, { updateDeps: npm.deps });
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.io.stderr).toContain(
        `The managed copy in ~/oort-home/cli is not safe for agents to run: ${h.home} can be written by group or others (fix: chmod go-w ${h.home})`,
      );
    }
    expect(npm.calls).toEqual([]); // never installed over, either
    expect(fs.existsSync(settings(h))).toBe(false);
    expect(fs.existsSync(path.join(h.root, '.cursor', 'mcp.json'))).toBe(false);
    // A group-writable file deep inside is caught the same way.
    fs.chmodSync(h.home, 0o700);
    expect(inspectManaged(env).state).toBe('ok');
    fs.chmodSync(planted.main, 0o775);
    expect(inspectManaged(env)).toMatchObject({
      state: 'untrusted',
      problem: { dir: planted.main },
    });
  });

  it('I1.a-managed-copy-linked-into-a-temp-dir-is-refused', async () => {
    const h = harness({ trusted: true });
    fs.mkdirSync(h.home, { recursive: true, mode: 0o700 });
    const elsewhere = tmpdir('oort-linked-cli-');
    npmPrefixCopy(elsewhere, VERSION);
    fs.symlinkSync(elsewhere, path.join(h.home, 'cli'));
    const env = { HOME: h.root, OORT_HOME: h.home, PATH: '' };
    expect(inspectManaged(env)).toMatchObject({
      state: 'untrusted',
      problem: { why: 'is in a temporary directory, which the system clears' },
    });
    const r = await h.run(['install', 'claude-code'], { env });
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('is not safe for agents to run');
    // With world-writable steps on the way, the walk names the first one.
    const shared = path.join(trustedTmpdir('oort-shared-'), 'shared');
    fs.mkdirSync(shared, { mode: 0o777 });
    fs.chmodSync(shared, 0o1777);
    npmPrefixCopy(path.join(shared, 'cli'), VERSION);
    fs.rmSync(path.join(h.home, 'cli'));
    fs.symlinkSync(path.join(shared, 'cli'), path.join(h.home, 'cli'));
    expect(inspectManaged(env)).toMatchObject({
      state: 'untrusted',
      problem: { dir: shared, why: 'can be written by group or others' },
    });
  });

  it('I1.setup-never-reuses-or-installs-over-an-untrusted-copy', async () => {
    const h = harness({ trusted: true });
    fs.mkdirSync(path.join(h.root, '.claude'));
    npmPrefixCopy(path.join(h.home, 'cli'), '99.0.0');
    fs.chmodSync(path.join(h.home, 'cli'), 0o777);
    const npm = fakeNpm();
    const r = await h.run(
      ['setup', '--yes', '--agents', 'claude-code', '--keys', 'skip', '--no-demo', '--json'],
      { env: { HOME: h.root, OORT_HOME: h.home, PATH: npmTrap(h.root).dir } },
      undefined,
      { updateDeps: npm.deps },
    );
    expect(r.code, r.io.stderr).toBe(0);
    expect(npm.calls).toEqual([]);
    expect(fs.existsSync(settings(h))).toBe(false);
    expect(data(r.io.stdout, 'setup')).toMatchObject({
      command: null,
      managed: { status: 'untrusted' },
    });
    expect(r.io.stderr).toContain(`chmod go-w ${path.join(h.home, 'cli')}`);
  });

  it('I1.the-last-check-before-a-write-refuses-an-unsafe-running-copy', () => {
    const h = harness({ trusted: true });
    const env = { HOME: h.root, OORT_HOME: h.home, PATH: '' };
    const ctx = { io: { env } } as never;
    const ok = looseCopy(path.join(h.root, 'checkout', 'oortmem'));
    expect(() => checkAgentPath(ok, ctx)).not.toThrow();
    fs.chmodSync(path.join(h.root, 'checkout'), 0o777);
    expect(() => checkAgentPath(ok, ctx)).toThrow(/can be written by others/);
    const temp = looseCopy(path.join(tmpdir('oort-gate-'), 'oortmem'));
    expect(() => checkAgentPath(temp, ctx)).toThrow(/a temporary directory/);
    expect(() => checkAgentPath(path.join(h.root, 'gone', 'main.js'), ctx)).toThrow(
      /it does not exist/,
    );
  });

  it('I2.every-temp-dir-counts-and-tmpdir-too', () => {
    const real = (p: string): string => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    };
    for (const dir of ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/dev/shm']) {
      expect(unstableCopy(undefined, `${dir}/x/oortmem/dist/main.js`), dir).toBe(
        'a temporary directory',
      );
    }
    expect(tempDirs({ TMPDIR: '/srv/scratch' })).toContain('/srv/scratch');
    expect(
      unstableCopy(
        undefined,
        '/srv/scratch/oortmem/dist/main.js',
        tempDirs({ TMPDIR: '/srv/scratch' }),
      ),
    ).toBe('a temporary directory');
    expect(unstableCopy(undefined, `${real(os.tmpdir())}/x/main.js`)).toBe('a temporary directory');
    expect(
      unstableCopy(undefined, '/usr/local/lib/node_modules/oortmem/dist/main.js'),
    ).toBeUndefined();
  });

  it('I2.a-running-copy-under-a-world-writable-directory-is-never-written', async () => {
    for (const mode of [0o777, 0o1777]) {
      const h = harness({ trusted: true });
      const shared = path.join(h.root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, mode);
      const entry = looseCopy(path.join(shared, 'oortmem'));
      const env = { HOME: h.root, OORT_HOME: h.home, PATH: '' };
      for (const args of [
        ['install', 'claude-code'],
        ['install', 'claude-code', '--this-copy'],
      ]) {
        const r = await h.run(args, { env, entry }, undefined, { binPath: entry });
        expect(r.code, `${mode.toString(8)} ${args.join(' ')}`).toBe(2);
        expect(r.io.stderr).toContain(
          `This oort is in a directory someone else can change (${shared} can be written by others (fix: chmod o-w ${shared})), which agents should not run`,
        );
      }
      expect(fs.existsSync(settings(h))).toBe(false);
    }
  });

  it('M1.printed-commands-never-quote-a-tilde', () => {
    expect(installCommandFor({ HOME: '/Users/ab', PATH: '' })).toBe(
      `npm i -g --prefix ~/.oort/cli oortmem@${VERSION} --prefer-online`,
    );
    // A space in HOME alone: `~/.oort/cli` needs no quotes, and the shell expands it.
    expect(shownPrefix({ HOME: '/Users/a b', PATH: '' })).toBe('~/.oort/cli');
    // A space after the `~`: the absolute path, quoted ('~/my oort' in quotes would not expand).
    const spaced = { HOME: '/Users/ab', OORT_HOME: '/Users/ab/my oort', PATH: '' };
    expect(shownPrefix(spaced)).toBe("'/Users/ab/my oort/cli'");
    expect(manualInstall(spaced)).toBe("npm i -g --prefix '/Users/ab/my oort/cli' oortmem");
    expect(installCommandFor({ HOME: '/Users/ab', OORT_HOME: '/Users/ab/my oort', PATH: '' })).toBe(
      `npm i -g --prefix '/Users/ab/my oort/cli' oortmem@${VERSION} --prefer-online`,
    );
    expect(shellPath('/Users/ab/x', '/Users/ab')).toBe('~/x');
    expect(shellPath("/Users/ab/it's", '/Users/ab')).toBe(`'/Users/ab/it'\\''s'`);
  });

  it('M2.a-dangling-or-unwritable-oort-home-is-a-refusal-not-a-crash (probe p11/h11)', async () => {
    const h = harness({ trusted: true });
    const npm = fakeNpm();
    const ctxFor = (oortHome: string) =>
      ({
        io: {
          env: { HOME: h.root, OORT_HOME: oortHome, PATH: npmTrap(h.root).dir },
          err() {},
          out() {},
        },
        updateDeps: npm.deps,
      }) as never;
    const link = path.join(h.root, '.oort');
    fs.symlinkSync(path.join(h.root, 'nowhere'), link);
    await expect(installManaged(ctxFor(link))).rejects.toThrow(
      /will not install its managed copy there: .*is a symlink that leads nowhere/,
    );
    expect(fs.existsSync(path.join(h.root, 'nowhere'))).toBe(false);
    const ro = path.join(h.root, 'read-only');
    fs.mkdirSync(ro, { mode: 0o500 });
    const err = await installManaged(ctxFor(path.join(ro, '.oort'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Refusal);
    expect((err as Error).message).toMatch(
      /Could not create .*\.oort for the managed copy \(EACCES\)/,
    );
    fs.chmodSync(ro, 0o700);
    expect(npm.calls).toEqual([]);
  });

  it('M3.mise-nodenv-and-nvs-are-version-managers', () => {
    for (const p of [
      '/Users/u/.local/share/mise/installs/node/22.1.0/lib/node_modules/oortmem/dist/main.js',
      '/Users/u/.nodenv/versions/22.1.0/lib/node_modules/oortmem/dist/main.js',
      '/Users/u/.nvs/node/22.1.0/arm64/lib/node_modules/oortmem/dist/main.js',
    ]) {
      expect(unstableCopy(p, p, []), p).toBe('a Node version manager');
    }
    expect(
      classifyCopy(
        '/Users/u/.nodenv/versions/22.1.0/bin/oort',
        '/Users/u/.nodenv/versions/22.1.0/lib/node_modules/oortmem/dist/main.js',
        { managedPrefix: '/Users/u/.oort/cli', tmp: '/nonexistent' },
      ),
    ).toMatchObject({ kind: 'npm-global', versionManager: 'nodenv' });
  });

  it('M4.the-real-installer-refuses-to-run-under-the-test-runner', () => {
    const run = defaultUpdateDeps({ io: { env: {} } } as never).run;
    expect(() => run('/usr/bin/true', [], {}, '/')).toThrow(/under the test runner/);
  });
});
