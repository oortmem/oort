/**
 * The managed copy (CON-114): `oort install` and `oort connect` point agents at `$OORT_HOME/cli`
 * when it checks out, and from a temporary copy install it first or refuse. Every npm is a fake
 * (`fakeNpm`) behind a stand-in on PATH: nothing is installed, nothing reaches the network.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installHooks } from '@oortmem/claude-code';
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
import {
  clearTreeCache,
  forgetSearched,
  globalFolders,
  groupCanBecomeRoot,
  searchedFolders,
  tempDirs,
  trustedPath,
  trustedTree,
} from '../trust.js';
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
 * Where a binary lives decides whether agents may run it. Each layout is built here as a
 * throwaway root.
 */
describe('trusting where a binary lives', () => {
  /** A copy of the fake package at `dir`, with `<dir>/dist/main.js`; the script's realpath. */
  function looseCopy(dir: string, version = VERSION): string {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'oortmem', version }));
    fs.writeFileSync(path.join(dir, 'dist', 'main.js'), '#!/bin/sh\n', { mode: 0o755 });
    return fs.realpathSync(path.join(dir, 'dist', 'main.js'));
  }

  it('I1.a-world-writable-oort-home-with-a-planted-copy-is-refused-everywhere', async () => {
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
        // The copy goes first, then the home is tightened: never chmod over a planted copy.
        fix: `rm -r ${path.join(h.home, 'cli')} && chmod go-w ${h.home} && oort setup`,
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
        `The managed copy in ~/oort-home/cli is not safe for agents to run: ${h.home} can be written by group or others (fix: rm -r ${path.join(h.home, 'cli')} && chmod go-w ${h.home} && oort setup). Oort never repairs a copy like this in place`,
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
    expect(r.io.stderr).toContain(`rm -r ${path.join(h.home, 'cli')} && oort setup`);
    expect(r.io.stderr).not.toContain('chmod');
  });

  it('I1.the-last-check-before-a-write-refuses-an-unsafe-running-copy', () => {
    const h = harness({ trusted: true });
    const env = { HOME: h.root, OORT_HOME: h.home, PATH: '' };
    const ctx = { io: { env } } as never;
    const ok = looseCopy(path.join(h.root, 'checkout', 'oortmem'));
    expect(() => checkAgentPath(ok, ctx)).not.toThrow();
    fs.chmodSync(path.join(h.root, 'checkout'), 0o777);
    expect(() => checkAgentPath(ok, ctx)).toThrow(/can be written by group or others/);
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
          `This oort is in a directory someone else can change (${shared} can be written by group or others (fix: chmod go-w ${shared}, then rebuild or reinstall oort (what is below it may have been changed), or use the managed copy (oort setup))), which agents should not run`,
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

  it('M2.a-dangling-or-unwritable-oort-home-is-a-refusal-not-a-crash', async () => {
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

/**
 * The managed copy's whole installed tree (PR #78): main.js loads the rest of
 * dist/ and every dependency, so a writable file anywhere in it is as bad as a writable main.js.
 */
describe('PR #78 follow-up: the whole managed tree', () => {
  /** A managed copy with a nested file in dist/ and a dependency, as npm lays them out. */
  function fullCopy(h: Harness): { prefix: string; deep: string; dep: string } {
    const prefix = path.join(h.home, 'cli');
    npmPrefixCopy(prefix, VERSION);
    const pkg = path.join(prefix, 'lib', 'node_modules', 'oortmem');
    const deep = path.join(pkg, 'dist', 'commands', 'deep.js');
    fs.mkdirSync(path.dirname(deep), { mode: 0o755 });
    fs.chmodSync(path.dirname(deep), 0o755);
    fs.writeFileSync(deep, 'export {};\n', { mode: 0o644 });
    fs.chmodSync(deep, 0o644);
    const depDir = path.join(pkg, 'node_modules', 'commander');
    fs.mkdirSync(depDir, { recursive: true, mode: 0o755 });
    for (const d of [path.join(pkg, 'node_modules'), depDir]) fs.chmodSync(d, 0o755);
    const dep = path.join(depDir, 'index.js');
    fs.writeFileSync(dep, 'module.exports = {};\n', { mode: 0o644 });
    fs.chmodSync(dep, 0o644);
    clearTreeCache();
    return { prefix, deep, dep };
  }
  const envOf = (h: Harness) => ({ HOME: h.root, OORT_HOME: h.home, PATH: npmTrap(h.root).dir });

  it('tree.a-clean-tree-is-ok-and-the-walk-is-cached', () => {
    const h = harness({ trusted: true });
    const { prefix, deep } = fullCopy(h);
    expect(inspectManaged(envOf(h)).state).toBe('ok');
    expect(trustedTree(prefix)).toBeUndefined();
    // Walked once per process: a change after the walk is seen only once the cache is cleared.
    fs.chmodSync(deep, 0o666);
    expect(trustedTree(prefix)).toBeUndefined();
    clearTreeCache();
    expect(trustedTree(prefix)).toMatchObject({ dir: deep });
  });

  it('tree.a-group-writable-file-deep-in-dist-or-a-dependency-is-refused-everywhere', async () => {
    for (const which of ['deep', 'dep'] as const) {
      const h = harness({ trusted: true });
      fs.mkdirSync(path.join(h.root, '.cursor'));
      fs.mkdirSync(path.join(h.root, '.claude'));
      const copy = fullCopy(h);
      fs.chmodSync(copy[which], 0o664);
      clearTreeCache();
      const env = envOf(h);
      expect(inspectManaged(env)).toMatchObject({
        state: 'untrusted',
        problem: {
          dir: copy[which],
          why: 'can be written by group or others',
          command: `rm -r ${copy.prefix} && oort setup`,
        },
      });
      const npm = fakeNpm();
      for (const args of [
        ['install', 'claude-code'],
        ['connect', 'cursor'],
      ]) {
        const r = await h.run(args, { env }, undefined, { updateDeps: npm.deps });
        expect(r.code, `${which} ${args.join(' ')}`).toBe(2);
        expect(r.io.stderr).toContain(`${copy[which]} can be written by group or others`);
        expect(r.io.stderr).toContain(`(fix: rm -r ${copy.prefix} && oort setup)`);
        expect(r.io.stderr).not.toMatch(/chmod|chown/);
      }
      const s = await h.run(
        ['setup', '--yes', '--agents', 'claude-code', '--keys', 'skip', '--no-demo', '--json'],
        { env },
        undefined,
        { updateDeps: npm.deps },
      );
      expect(data(s.io.stdout, 'setup')).toMatchObject({
        command: null,
        managed: { status: 'untrusted' },
      });
      expect(npm.calls).toEqual([]);
      expect(fs.existsSync(settings(h))).toBe(false);
      const d = await h.run(['doctor', '--json'], { env });
      const row = (
        data(d.io.stdout, 'doctor') as {
          checks: { name: string; status: string; fixCommand?: string }[];
        }
      ).checks.find((c) => c.name === 'managed copy');
      expect(row).toMatchObject({
        status: 'fail',
        fixCommand: `rm -r ${copy.prefix} && oort setup`,
      });
      expect(d.code).toBe(1);
    }
  });

  it('tree.a-link-out-of-the-prefix-is-refused-and-links-inside-are-fine', () => {
    const h = harness({ trusted: true });
    const { prefix } = fullCopy(h);
    const bin = path.join(prefix, 'lib', 'node_modules', '.bin');
    fs.mkdirSync(bin, { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
    fs.symlinkSync('../oortmem/package.json', path.join(bin, 'inside'));
    clearTreeCache();
    expect(trustedTree(prefix)).toBeUndefined();
    const outside = path.join(trustedTmpdir('oort-outside-'), 'evil.js');
    fs.writeFileSync(outside, 'module.exports = {};\n');
    const link = path.join(prefix, 'lib', 'node_modules', 'oortmem', 'node_modules', 'evil');
    fs.symlinkSync(outside, link);
    clearTreeCache();
    expect(inspectManaged(envOf(h))).toMatchObject({
      state: 'untrusted',
      problem: {
        dir: link,
        why: `is a link whose text points out of the managed copy (${outside})`,
      },
    });
  });

  it('tree.past-the-cap-is-not-vouched-for', () => {
    const h = harness({ trusted: true });
    const { prefix } = fullCopy(h);
    clearTreeCache();
    expect(trustedTree(prefix, { cap: 5 })).toMatchObject({
      dir: prefix,
      why: 'holds more than 5 files, more than oort ever installs',
    });
    expect(trustedTree(prefix, { cap: 1000 })).toBeUndefined();
  });

  it('umask.is-tightened-for-the-install-spawn-and-put-back-even-when-it-throws', async () => {
    const umask = (): number => {
      const m = process.umask(0o077);
      process.umask(m);
      return m;
    };
    const before = process.umask(0o002); // a permissive umask, as on some systems
    try {
      const h = harness({ trusted: true });
      const seen: number[] = [];
      const npm = fakeNpm();
      const run = npm.deps.run!;
      const ctx = {
        io: { env: envOf(h), err() {}, out() {} },
        updateDeps: {
          ...npm.deps,
          run: async (...a: Parameters<typeof run>) => {
            seen.push(umask());
            return run(...a);
          },
        },
      } as never;
      const ok = await installManaged(ctx);
      expect(ok.ok).toBe(true);
      expect(seen).toEqual([0o022]);
      expect(umask()).toBe(0o002);
      // A 077 stays 077 (only ever tightened).
      process.umask(0o077);
      const h2 = harness({ trusted: true });
      const strict: number[] = [];
      await installManaged({
        io: { env: envOf(h2), err() {}, out() {} },
        updateDeps: {
          ...npm.deps,
          run: async (...a: Parameters<typeof run>) => {
            strict.push(umask());
            return run(...a);
          },
        },
      } as never);
      expect(strict).toEqual([0o077]);
      expect(umask()).toBe(0o077);
      // The spawn throws: the umask is put back all the same.
      process.umask(0o002);
      const h3 = harness({ trusted: true });
      await expect(
        installManaged({
          io: { env: envOf(h3), err() {}, out() {} },
          updateDeps: {
            ...npm.deps,
            run: async () => {
              throw new Error('spawn failed');
            },
          },
        } as never),
      ).rejects.toThrow('spawn failed');
      expect(umask()).toBe(0o002);
    } finally {
      process.umask(before);
    }
  });
});

/**
 * Group write (PR #78): every macOS account's own group is `staff`, so group write
 * counts only from a group that can already become root, and never inside HOME.
 */
describe('PR #78: group write', () => {
  const linux = (group: string, passwd = '', user = 'ann') =>
    ({ platform: 'linux', group, passwd, user }) as const;

  it('n2.only-groups-that-can-become-root-count', () => {
    const mac = { platform: 'darwin', group: '', passwd: '', user: 'ann' } as const;
    expect(groupCanBecomeRoot(0, mac)).toBe(true); // wheel
    expect(groupCanBecomeRoot(80, mac)).toBe(true); // admin
    expect(groupCanBecomeRoot(20, mac)).toBe(false); // staff: every account's group
    const groups = 'root:x:0:\nsudo:x:27:ann\nusers:x:100:\nann:x:1000:\nbob:x:1001:bob,ann\n';
    const passwd = 'ann:x:1000:1000::/home/ann:/bin/sh\nbob:x:1001:1001::/home/bob:/bin/sh\n';
    expect(groupCanBecomeRoot(27, linux(groups, passwd))).toBe(true);
    expect(groupCanBecomeRoot(100, linux(groups, passwd))).toBe(false);
    // Ann's private group: named after her, no other members, no one else's primary group.
    expect(groupCanBecomeRoot(1000, linux(groups, passwd))).toBe(true);
    expect(groupCanBecomeRoot(1001, linux(groups, passwd))).toBe(false);
    const shared = `${passwd}carl:x:1002:1000::/home/carl:/bin/sh\n`;
    expect(groupCanBecomeRoot(1000, linux(groups, shared))).toBe(false);
    expect(groupCanBecomeRoot(4242, linux(groups, passwd))).toBe(false);
  });

  it('n2.group-write-outside-home-counts-only-from-a-root-group-and-never-inside-home', () => {
    const h = harness({ trusted: true });
    // Outside HOME (h.root is HOME; this root is not under it), as Homebrew's admin-group dirs.
    const brew = path.join(trustedTmpdir('oort-brew-'), 'lib');
    fs.mkdirSync(brew);
    fs.chmodSync(brew, 0o775);
    const main = path.join(brew, 'node_modules', 'oortmem', 'dist', 'main.js');
    fs.mkdirSync(path.dirname(main), { recursive: true });
    fs.writeFileSync(main, '#!/bin/sh\n', { mode: 0o755 });
    const admin = (gid: number) => gid === fs.statSync(brew).gid;
    expect(trustedPath(main, { home: h.root, strict: false, groupOk: admin })).toBeUndefined();
    expect(trustedPath(main, { home: h.root, strict: false, groupOk: () => false })).toMatchObject({
      dir: brew,
      why: 'can be written by its group',
      // Never a bare chmod to run: what is below may have been changed already.
      fix: expect.stringContaining(`chmod g-w ${brew}, then rebuild or reinstall oort`),
    });
    expect(
      trustedPath(main, { home: h.root, strict: false, groupOk: () => false }),
    ).not.toHaveProperty('command');
    // Strict (the managed copy): never.
    expect(trustedPath(main, { home: h.root, strict: true, groupOk: admin })?.dir).toBe(brew);
    // Inside HOME: never, whatever the group.
    const mine = path.join(h.root, 'build');
    fs.mkdirSync(mine);
    fs.chmodSync(mine, 0o775);
    expect(trustedPath(mine, { home: h.root, strict: false, groupOk: () => true })).toMatchObject({
      dir: mine,
      why: 'can be written by its group',
    });
  });

  it('n2.a-group-writable-build-in-home-is-never-written-and-doctor-fails-it', async () => {
    const h = harness({ trusted: true });
    const pkg = path.join(h.root, 'build', 'oortmem');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'oortmem', version: VERSION }),
    );
    const main = path.join(pkg, 'dist', 'main.js');
    fs.writeFileSync(main, '#!/bin/sh\n', { mode: 0o755 });
    fs.chmodSync(path.join(pkg, 'dist'), 0o775); // group staff on a Mac
    const env = { HOME: h.root, OORT_HOME: h.home, PATH: '' };
    for (const args of [
      ['install', 'claude-code', '--this-copy'],
      ['install', 'claude-code'],
    ]) {
      const r = await h.run(args, { env, entry: main }, undefined, { binPath: main });
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.io.stderr).toContain(`${path.join(pkg, 'dist')} can be written by its group`);
    }
    expect(fs.existsSync(settings(h))).toBe(false);
    // Hooks someone pointed at it anyway: doctor fails them.
    installHooks(settings(h), main);
    const d = await h.run(['doctor', '--json'], { env });
    const bin = (
      data(d.io.stdout, 'doctor') as { checks: { name: string; status: string; detail: string }[] }
    ).checks.find((c) => c.name === 'claude-code bin');
    expect(bin?.status).toBe('fail');
    expect(bin?.detail).toContain('can be written by its group');
  });
});

/** Links in the managed copy are judged by where they really lead (PR #78). */
describe('links in the managed copy', () => {
  function copyIn(h: Harness): { prefix: string; nm: string } {
    const prefix = path.join(h.home, 'cli');
    npmPrefixCopy(prefix, VERSION);
    const nm = path.join(prefix, 'lib', 'node_modules', 'oortmem', 'node_modules');
    fs.mkdirSync(path.join(nm, 'a'), { recursive: true, mode: 0o755 });
    for (const d of [nm, path.join(nm, 'a')]) fs.chmodSync(d, 0o755);
    clearTreeCache();
    return { prefix, nm };
  }
  const envOf = (h: Harness) => ({ HOME: h.root, OORT_HOME: h.home, PATH: '' });

  it('links.an-x-dot-dot-chain-that-reads-inside-but-leads-outside-is-refused', () => {
    const h = harness({ trusted: true });
    const { prefix, nm } = copyIn(h);
    // `x` leads to the prefix itself (inside); `x/../../outside` reads as inside the tree, but
    // the kernel follows `x` first: prefix/.. /.. is two levels above the managed copy.
    fs.writeFileSync(path.join(h.root, 'outside'), 'module.exports = 1;\n', { mode: 0o644 });
    fs.symlinkSync(prefix, path.join(nm, 'a', 'x'));
    const link = path.join(nm, 'a', 'escape');
    fs.symlinkSync('x/../../outside', link);
    expect(path.resolve(path.dirname(link), 'x/../../outside').startsWith(prefix)).toBe(true);
    clearTreeCache();
    expect(inspectManaged(envOf(h))).toMatchObject({
      state: 'untrusted',
      problem: {
        dir: link,
        why: "is a link with .. in it (x/../../outside) that is not one of npm's",
      },
    });
  });

  it('links.a-dangling-link-is-refused', () => {
    const h = harness({ trusted: true });
    const { nm } = copyIn(h);
    const link = path.join(nm, 'a', 'gone.js');
    fs.symlinkSync('nowhere.js', link);
    clearTreeCache();
    expect(inspectManaged(envOf(h))).toMatchObject({
      state: 'untrusted',
      problem: { dir: link, why: 'is a link that leads nowhere' },
    });
  });

  it('links.npm-bin-links-are-fine-and-only-while-their-realpath-stays-inside', () => {
    const h = harness({ trusted: true });
    const { prefix } = copyIn(h);
    const nm = path.join(prefix, 'lib', 'node_modules');
    const dep = path.join(nm, 'commander');
    const scoped = path.join(nm, '@scope', 'tool');
    for (const d of [dep, scoped, path.join(nm, '.bin')]) fs.mkdirSync(d, { recursive: true });
    for (const d of [dep, path.join(nm, '@scope'), scoped, path.join(nm, '.bin')]) {
      fs.chmodSync(d, 0o755);
    }
    fs.writeFileSync(path.join(dep, 'index.js'), '\n', { mode: 0o644 });
    fs.writeFileSync(path.join(scoped, 'cli.js'), '\n', { mode: 0o644 });
    fs.symlinkSync('../commander/index.js', path.join(nm, '.bin', 'commander'));
    fs.symlinkSync('../@scope/tool/cli.js', path.join(nm, '.bin', 'tool'));
    // And the global bin link npm writes: bin/oort -> ../lib/node_modules/oortmem/dist/main.js.
    clearTreeCache();
    expect(inspectManaged(envOf(h)).state).toBe('ok');
    // The same shape, but the package it names is a link out of the copy: refused.
    const elsewhere = path.join(trustedTmpdir('oort-elsewhere-'), 'evil');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'index.js'), '\n', { mode: 0o644 });
    fs.symlinkSync(elsewhere, path.join(nm, 'evil'));
    fs.symlinkSync('../evil/index.js', path.join(nm, '.bin', 'evil'));
    clearTreeCache();
    expect(inspectManaged(envOf(h))).toMatchObject({
      state: 'untrusted',
      problem: {
        why: expect.stringMatching(/^is a link (whose text points )?out of the managed copy/),
      },
    });
  });

  it('links.dot-dot-outside-npm-shapes-is-refused-even-when-it-stays-inside', () => {
    const h = harness({ trusted: true });
    const { nm } = copyIn(h);
    fs.writeFileSync(path.join(nm, 'inside.js'), '\n', { mode: 0o644 });
    const link = path.join(nm, 'a', 'up.js');
    fs.symlinkSync('../inside.js', link);
    clearTreeCache();
    expect(inspectManaged(envOf(h))).toMatchObject({
      state: 'untrusted',
      problem: {
        dir: link,
        why: "is a link with .. in it (../inside.js) that is not one of npm's",
      },
    });
    // Without `..`, a link to a file inside is fine.
    fs.rmSync(link);
    fs.symlinkSync(path.join(nm, 'inside.js'), link);
    clearTreeCache();
    expect(inspectManaged(envOf(h)).state).toBe('ok');
  });
});

/** The final check of 7b18e5c: kernel paths, a stale walk after npm, and your own builds. */
describe('kernel paths, the walk after an install, own builds', () => {
  /** An escape, built under `root`: a link whose text stays inside. */
  function escape(root: string, deep: string): { link: string; payload: string } {
    const depth = root.split('/').length - 1;
    const ups = Array(depth).fill('..').join('/');
    const t = tmpdir('oort-esc-');
    fs.writeFileSync(path.join(t, 'payload.js'), 'export const pwned = 1;\n');
    fs.chmodSync(t, 0o777);
    let nest = deep;
    for (let i = 0; i < depth + 2; i++) nest = path.join(nest, `n${i}`);
    fs.mkdirSync(nest, { recursive: true });
    let d = nest;
    while (d !== deep) {
      fs.chmodSync(d, 0o755);
      d = path.dirname(d);
    }
    fs.symlinkSync(root, path.join(nest, 'L2'));
    const link = path.join(deep, 'esc.js');
    fs.symlinkSync(`${nest}/L2/${ups}${t}/payload.js`, link);
    // Read as text, it stays inside; the kernel follows L2 first and lands in the temp dir.
    expect(path.resolve(`${nest}/L2/${ups}${t}/payload.js`).startsWith(root + path.sep)).toBe(true);
    expect(fs.realpathSync.native(link)).toBe(path.join(t, 'payload.js'));
    return { link, payload: path.join(t, 'payload.js') };
  }

  it('kernel.the-run5-escape-is-refused-in-the-managed-copy', () => {
    const h = harness({ trusted: true });
    const prefix = path.join(h.home, 'cli');
    npmPrefixCopy(prefix, VERSION);
    const root = fs.realpathSync(prefix);
    const deep = path.join(root, 'lib', 'node_modules', 'oortmem', 'dist');
    const { link } = escape(root, deep);
    clearTreeCache();
    const s = inspectManaged({ HOME: h.root, OORT_HOME: h.home, PATH: '' });
    expect(s).toMatchObject({ state: 'untrusted', problem: { dir: link } });
    expect(s.state === 'untrusted' && s.problem.why).toMatch(/is a link with \.\. in it/);
  });

  it('kernel.the-run5-escape-is-refused-in-a-copy-of-your-own-by-where-it-really-leads', () => {
    const h = harness({ trusted: true });
    const pkg = path.join(h.root, 'build', 'oortmem');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'oortmem', version: VERSION }),
    );
    const main = path.join(pkg, 'dist', 'main.js');
    fs.writeFileSync(main, '#!/bin/sh\n', { mode: 0o755 });
    const ctx = { io: { env: { HOME: h.root, OORT_HOME: h.home, PATH: '' } } } as never;
    expect(() => checkAgentPath(main, ctx)).not.toThrow();
    const { payload } = escape(fs.realpathSync(pkg), fs.realpathSync(path.join(pkg, 'dist')));
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).toThrow(
      new RegExp(
        `is a link to ${payload.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, where .* can be written by (group or )?others`,
      ),
    );
  });

  it('cache.the-walk-after-npm-is-fresh', async () => {
    const h = harness({ trusted: true });
    const prefix = path.join(h.home, 'cli');
    npmPrefixCopy(prefix, '0.0.1');
    const env = { HOME: h.root, OORT_HOME: h.home, PATH: npmTrap(h.root).dir };
    clearTreeCache();
    expect(inspectManaged(env).state).toBe('ok'); // walked and cached before npm runs
    const npm = fakeNpm();
    const run = npm.deps.run!;
    const r = await installManaged({
      io: { env, err() {}, out() {} },
      updateDeps: {
        ...npm.deps,
        run: async (...a: Parameters<typeof run>) => {
          const out = await run(...a);
          // What an npm with `umask=0` in .npmrc might leave.
          const commands = path.join(prefix, 'lib', 'node_modules', 'oortmem', 'dist', 'commands');
          fs.mkdirSync(commands);
          fs.chmodSync(commands, 0o777);
          return out;
        },
      },
    } as never);
    expect(r).toMatchObject({ ok: false, reason: 'unverified' });
    expect(!r.ok && r.detail).toContain('the copy it left is not safe for agents to run');
    expect(inspectManaged(env).state).toBe('untrusted');
  });

  it('own.a-build-of-yours-is-walked-whole-with-the-lenient-rules', () => {
    const h = harness({ trusted: true });
    const pkg = path.join(h.root, 'build', 'oortmem');
    const deep = path.join(pkg, 'dist', 'commands', 'x.js');
    fs.mkdirSync(path.dirname(deep), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'oortmem', version: VERSION }),
    );
    const main = path.join(pkg, 'dist', 'main.js');
    fs.writeFileSync(main, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(deep, '\n', { mode: 0o644 });
    // A pnpm-like link out of the package, to a directory of yours: fine, not walked into.
    const store = path.join(trustedTmpdir('oort-store-'), 'commander');
    fs.mkdirSync(store);
    fs.mkdirSync(path.join(pkg, 'node_modules'));
    fs.symlinkSync(store, path.join(pkg, 'node_modules', 'commander'));
    const ctx = { io: { env: { HOME: h.root, OORT_HOME: h.home, PATH: '' } } } as never;
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).not.toThrow();
    // A group-writable file deep in it, inside HOME: refused, by its path.
    fs.chmodSync(deep, 0o664);
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).toThrow(`${deep} can be written by its group`);
    fs.chmodSync(deep, 0o644);
    // A link out to somewhere others can write: refused.
    fs.chmodSync(store, 0o777);
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).toThrow(
      /is a link to .*commander, where .* can be written by (group or )?others/,
    );
  });
});

/** Link text in the managed copy, and code loaded from outside the walk. */
describe('link text, closures, ancestor node_modules', () => {
  const pkgAt = (dir: string, json: Record<string, unknown> = {}): string => {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'oortmem', version: VERSION, ...json }),
    );
    const main = path.join(dir, 'dist', 'main.js');
    fs.writeFileSync(main, '#!/bin/sh\n', { mode: 0o755 });
    return main;
  };
  const dep = (dir: string, file = 'index.js', mode = 0o644): string => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir) }));
    const f = path.join(dir, file);
    fs.writeFileSync(f, '\n', { mode });
    fs.chmodSync(f, mode);
    return f;
  };

  it('text.a-link-whose-text-points-out-but-whose-realpath-is-inside-is-refused', () => {
    const h = harness({ trusted: true });
    const prefix = path.join(h.home, 'cli');
    npmPrefixCopy(prefix, VERSION);
    // `ext` (outside the copy) leads back into it, so the link's realpath is inside.
    const ext = path.join(h.root, 'ext');
    fs.symlinkSync(path.join(prefix, 'lib'), ext);
    const text = path.join(ext, 'node_modules', 'oortmem', 'package.json');
    const link = path.join(prefix, 'lib', 'node_modules', 'oortmem', 'dist', 'pkg.json');
    fs.symlinkSync(text, link);
    expect(fs.realpathSync.native(link).startsWith(fs.realpathSync(prefix))).toBe(true);
    clearTreeCache();
    expect(inspectManaged({ HOME: h.root, OORT_HOME: h.home, PATH: '' })).toMatchObject({
      state: 'untrusted',
      problem: { dir: link, why: `is a link whose text points out of the managed copy (${text})` },
    });
  });

  it('closure.runtime-dependencies-are-walked-and-dev-dependencies-are-not', () => {
    const h = harness({ trusted: true });
    const pkg = path.join(h.root, 'build', 'oortmem');
    const main = pkgAt(pkg, { dependencies: { left: '1' }, devDependencies: { tooling: '1' } });
    // pnpm-like: both linked from node_modules into a store outside the package.
    const store = trustedTmpdir('oort-store-');
    const leftFile = dep(path.join(store, 'left'));
    const toolFile = dep(path.join(store, 'tooling'));
    fs.mkdirSync(path.join(pkg, 'node_modules'));
    fs.symlinkSync(path.join(store, 'left'), path.join(pkg, 'node_modules', 'left'));
    fs.symlinkSync(path.join(store, 'tooling'), path.join(pkg, 'node_modules', 'tooling'));
    const ctx = { io: { env: { HOME: h.root, OORT_HOME: h.home, PATH: '' } } } as never;
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).not.toThrow();
    // A writable file in a dev dependency: Node never loads it from oort, not walked.
    fs.chmodSync(toolFile, 0o666);
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).not.toThrow();
    // In a runtime dependency, found the way Node finds it: refused.
    fs.chmodSync(leftFile, 0o666);
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).toThrow(`${leftFile} can be written by others`);
  });

  it('closure.a-dependency-of-a-dependency-is-found-beside-it-as-pnpm-lays-it-out', () => {
    const h = harness({ trusted: true });
    const pkg = path.join(h.root, 'build', 'oortmem');
    const main = pkgAt(pkg, { dependencies: { a: '1' } });
    // store/a@1/node_modules/{a, b}: a needs b, which Node finds beside it.
    const nm = path.join(trustedTmpdir('oort-pnpm-'), 'a@1', 'node_modules');
    dep(path.join(nm, 'a'));
    fs.writeFileSync(
      path.join(nm, 'a', 'package.json'),
      JSON.stringify({ name: 'a', dependencies: { b: '1' } }),
    );
    const deep = dep(path.join(nm, 'b'), 'deep.js');
    fs.mkdirSync(path.join(pkg, 'node_modules'));
    fs.symlinkSync(path.join(nm, 'a'), path.join(pkg, 'node_modules', 'a'));
    const ctx = { io: { env: { HOME: h.root, OORT_HOME: h.home, PATH: '' } } } as never;
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).not.toThrow();
    fs.chmodSync(deep, 0o666);
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).toThrow(`${deep} can be written by others`);
  });

  it('closure.a-linked-directory-that-is-not-a-dependency-is-walked-too', () => {
    const h = harness({ trusted: true });
    const pkg = path.join(h.root, 'build', 'oortmem');
    const main = pkgAt(pkg);
    const vendor = path.join(trustedTmpdir('oort-vendor-'), 'vendor');
    const file = dep(vendor, 'lib.js');
    fs.symlinkSync(vendor, path.join(pkg, 'dist', 'vendor'));
    const ctx = { io: { env: { HOME: h.root, OORT_HOME: h.home, PATH: '' } } } as never;
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).not.toThrow();
    fs.chmodSync(file, 0o666);
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).toThrow(`${file} can be written by others`);
  });

  it('ancestors.a-planted-writable-node-modules-above-the-copy-is-refused', () => {
    const h = harness({ trusted: true });
    const env = { HOME: h.root, OORT_HOME: h.home, PATH: '' };
    npmPrefixCopy(path.join(h.home, 'cli'), VERSION);
    const pkg = path.join(h.root, 'build', 'oortmem');
    const main = pkgAt(pkg);
    clearTreeCache();
    expect(inspectManaged(env).state).toBe('ok');
    // <HOME>/node_modules, writable by anyone: Node would search it for what oort does not ship.
    const planted = path.join(h.root, 'node_modules');
    fs.mkdirSync(planted);
    fs.chmodSync(planted, 0o777);
    clearTreeCache();
    const s = inspectManaged(env);
    expect(s).toMatchObject({ state: 'untrusted', problem: { dir: planted } });
    expect(s.state === 'untrusted' && s.problem.why).toContain(
      `and Node loads modules from ${planted} for anything not found nearer`,
    );
    expect(s.state === 'untrusted' && s.problem.fix).not.toMatch(/chmod|chown/);
    expect(() => checkAgentPath(main, { io: { env } } as never)).toThrow(
      `and Node loads modules from ${planted}`,
    );
    // Yours alone: fine.
    fs.chmodSync(planted, 0o755);
    clearTreeCache();
    expect(inspectManaged(env).state).toBe('ok');
  });

  /** One run of the managed-copy checks with `NODE_PATH` as given, from a fresh walk. */
  const managedWith = (
    h: Harness,
    extra: Record<string, string> = {},
  ): ReturnType<typeof inspectManaged> => {
    clearTreeCache();
    return inspectManaged({ HOME: h.root, OORT_HOME: h.home, PATH: '', ...extra });
  };

  it('ancestors.what-is-inside-a-node_modules-above-the-copy-is-walked-and-capped', () => {
    const h = harness({ trusted: true });
    npmPrefixCopy(path.join(h.home, 'cli'), VERSION);
    expect(managedWith(h).state).toBe('ok');
    // Deep inside a package nobody declares: a name-level check would miss it.
    const planted = path.join(h.root, 'node_modules');
    const deep = dep(path.join(planted, 'some-pkg', 'lib', 'deeper'), 'x.js');
    expect(managedWith(h).state).toBe('ok');
    fs.chmodSync(deep, 0o666);
    forgetSearched(planted); // a change below a folder that passed (the folder itself is unchanged)
    const s = managedWith(h);
    expect(s).toMatchObject({ state: 'untrusted', problem: { dir: deep } });
    expect(s.state === 'untrusted' && s.problem.why).toContain(
      `can be written by others, and Node loads modules from ${planted} for anything not found nearer`,
    );
    expect(s.state === 'untrusted' && s.problem.fix).toBe(
      `move ${planted} aside (Node searches it), or make everything in it writable only by you`,
    );
    // Past the shared cap: refused too, to move aside, never chmod or chown. Only this folder is
    // searched, so nothing above the machine's checkout is looked at.
    fs.chmodSync(deep, 0o644);
    for (let i = 0; i < 6; i++) dep(path.join(planted, `many-${i}`));
    const rules = { home: h.root, strictFor: () => false };
    const state = { count: 0, visited: new Set<string>() };
    const over = searchedFolders([planted], rules, state, 5);
    expect(over).toMatchObject({ dir: planted });
    expect(over?.why).toMatch(/holds more than 5 entries to check/);
    expect(over?.fix).toBe(
      `move ${planted} aside (Node searches it), or make everything in it writable only by you`,
    );
    expect(over?.fix).not.toMatch(/chmod|chown/);
    expect(
      searchedFolders([planted], rules, { count: 0, visited: new Set() }, 5_000),
    ).toBeUndefined();
  });

  it('globals.a-relative-NODE_PATH-entry-is-refused-whatever-the-copy', () => {
    const h = harness({ trusted: true });
    npmPrefixCopy(path.join(h.home, 'cli'), VERSION);
    expect(managedWith(h).state).toBe('ok');
    for (const np of ['vendor', ['/abs', 'rel/libs'].join(path.delimiter), './x']) {
      const s = managedWith(h, { NODE_PATH: np });
      expect(s.state).toBe('untrusted');
      if (s.state !== 'untrusted') continue;
      expect(s.problem.why).toContain('relative NODE_PATH entry');
      expect(s.problem.fix).toBe('make it absolute, or remove it from NODE_PATH');
    }
    // Empty entries are not relative ones.
    expect(managedWith(h, { NODE_PATH: path.delimiter }).state).toBe('ok');
    // A copy of your own: the same.
    const pkg = path.join(h.root, 'build', 'oortmem');
    const main = pkgAt(pkg, {});
    const ctx = {
      io: { env: { HOME: h.root, OORT_HOME: h.home, PATH: '', NODE_PATH: 'rel' } },
    } as never;
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).toThrow('relative NODE_PATH entry');
  });

  it('ancestors.a-link-to-a-directory-is-walked-under-the-same-rules-and-cap', () => {
    const h = harness({ trusted: true });
    npmPrefixCopy(path.join(h.home, 'cli'), VERSION);
    const planted = path.join(h.root, 'node_modules');
    fs.mkdirSync(planted, { recursive: true });
    const store = path.join(h.root, 'store');
    const inner = dep(path.join(store, 'pkg', 'lib'), 'x.js');
    fs.symlinkSync(path.join(store, 'pkg'), path.join(planted, 'linked'));
    expect(managedWith(h).state).toBe('ok');
    fs.chmodSync(inner, 0o666);
    forgetSearched(planted);
    forgetSearched(path.join(store, 'pkg'));
    const s = managedWith(h);
    expect(s).toMatchObject({ state: 'untrusted', problem: { dir: inner } });
    expect(s.state === 'untrusted' && s.problem.why).toContain(
      `can be written by others, and Node loads modules from ${planted} for anything not found nearer`,
    );
    fs.chmodSync(inner, 0o664);
    forgetSearched(planted);
    forgetSearched(path.join(store, 'pkg'));
    expect(managedWith(h).state).toBe('untrusted');
    // Past the cap: move the folder aside. A cycle through the link walks once.
    fs.chmodSync(inner, 0o644);
    forgetSearched(planted);
    forgetSearched(path.join(store, 'pkg'));
    fs.symlinkSync(planted, path.join(store, 'pkg', 'back'));
    expect(managedWith(h).state).toBe('ok');
    for (let i = 0; i < 6; i++) dep(path.join(store, 'pkg', `many-${i}`));
    const rules = { home: h.root, strictFor: () => false };
    const over = searchedFolders([planted], rules, { count: 0, visited: new Set() }, 5);
    expect(over?.why).toMatch(/holds more than 5 entries to check/);
    expect(over?.fix).toBe(
      `move ${planted} aside (Node searches it), or make everything in it writable only by you`,
    );
  });

  it("globals.node's-global-folders-are-checked-and-walked-like-an-ancestor-node_modules", () => {
    const h = harness({ trusted: true });
    npmPrefixCopy(path.join(h.home, 'cli'), VERSION);
    // The list: NODE_PATH entries (absolute only), ~/.node_modules, ~/.node_libraries and
    // <node prefix>/lib/node.
    expect(
      globalFolders(
        { NODE_PATH: ['/a/b', 'rel', '', '/c'].join(path.delimiter) },
        '/home/u',
        '/n/bin/node',
      ),
    ).toEqual([
      '/a/b',
      '/c',
      path.join('/home/u', '.node_modules'),
      path.join('/home/u', '.node_libraries'),
      path.join('/n', 'lib', 'node'),
    ]);
    // A NODE_PATH folder with something writable deep inside: refused, by the file.
    const globals = path.join(trustedTmpdir('oort-nodepath-'), 'libs');
    const file = dep(path.join(globals, 'cjs-dep', 'lib'), 'index.js');
    const withPath = { NODE_PATH: globals };
    expect(managedWith(h, withPath).state).toBe('ok');
    fs.chmodSync(file, 0o666);
    forgetSearched(globals);
    const s = managedWith(h, withPath);
    expect(s).toMatchObject({ state: 'untrusted', problem: { dir: file } });
    expect(s.state === 'untrusted' && s.problem.why).toContain(
      `and Node loads modules from ${globals} for anything not found nearer`,
    );
    // Without NODE_PATH it is not searched: fine. The same for ~/.node_modules.
    expect(managedWith(h).state).toBe('ok');
    const dot = path.join(h.root, '.node_modules');
    const dotFile = dep(path.join(dot, 'cjs-dep'), 'index.js', 0o666);
    expect(managedWith(h)).toMatchObject({ state: 'untrusted', problem: { dir: dotFile } });
    fs.rmSync(dot, { recursive: true });
    expect(managedWith(h).state).toBe('ok');
    // A copy of your own: a dependency found only through NODE_PATH is walked as well.
    const pkg = path.join(h.root, 'build', 'oortmem');
    const main = pkgAt(pkg, { dependencies: { 'only-global': '1' } });
    const ctx = {
      io: { env: { HOME: h.root, OORT_HOME: h.home, PATH: '', ...withPath } },
    } as never;
    fs.chmodSync(file, 0o644);
    forgetSearched(globals);
    const found = dep(path.join(globals, 'only-global', 'lib'), 'g.js');
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).not.toThrow();
    fs.chmodSync(found, 0o666);
    forgetSearched(globals);
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).toThrow(`${found} can be written by others`);
  });

  it('closure.a-linked-directory-gets-the-ancestor-check-and-its-dependencies-are-walked', () => {
    const h = harness({ trusted: true });
    const pkg = path.join(h.root, 'build', 'oortmem');
    const main = pkgAt(pkg);
    // dist/vendor is a link (not a dependency link) to <store>/vendor, which needs `needed`,
    // found beside it in <store>/node_modules.
    const store = trustedTmpdir('oort-linked-');
    const vendor = path.join(store, 'vendor');
    dep(vendor, 'lib.js');
    fs.writeFileSync(
      path.join(vendor, 'package.json'),
      JSON.stringify({ name: 'vendor', dependencies: { needed: '1' } }),
    );
    const needed = dep(path.join(store, 'node_modules', 'needed'), 'n.js');
    fs.symlinkSync(vendor, path.join(pkg, 'dist', 'vendor'));
    const ctx = { io: { env: { HOME: h.root, OORT_HOME: h.home, PATH: '' } } } as never;
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).not.toThrow();
    // Its runtime dependency is in the closure: a writable file in it is refused.
    fs.chmodSync(needed, 0o666);
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).toThrow(`${needed} can be written by others`);
    fs.chmodSync(needed, 0o644);
    // The ancestor check runs on the link's realpath: a writable node_modules above <store>/vendor.
    const above = path.join(store, 'node_modules');
    fs.chmodSync(above, 0o777);
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).toThrow(`and Node loads modules from ${above}`);
    fs.chmodSync(above, 0o755);
    clearTreeCache();
    expect(() => checkAgentPath(main, ctx)).not.toThrow();
  });
});
