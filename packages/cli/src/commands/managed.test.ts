/**
 * The managed copy (CON-114): `oort install` and `oort connect` point agents at `$OORT_HOME/cli`
 * when it checks out, and from a temporary copy install it first or refuse. Every npm is a fake
 * (`fakeNpm`) behind a stand-in on PATH: nothing is installed, nothing reaches the network.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERSION } from '@oortmem/core';
import {
  data,
  fakeNpm,
  harness,
  npmPrefixCopy,
  npmTrap,
  type Harness,
} from '../../test/helpers.js';
import { managedCopy, plannedMain } from './managed.js';

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
    const h = harness();
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
    const h = harness();
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
    const h = harness();
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
      `This oort is in a package cache, so agents would lose it later: installing oort ${VERSION} in ~/oort-home/cli first`,
    );
    const text = fs.readFileSync(settings(h), 'utf8');
    expect(text).toContain(path.join(h.home, 'cli', 'lib', 'node_modules', 'oortmem'));
    expect(text).not.toContain('_npx');
  });

  it('install.from-a-transient-copy-without-npm-refuses-with-the-commands', async () => {
    const h = harness();
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
    const h = harness();
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
    const h = harness();
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
    const h = harness();
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
