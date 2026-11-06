/**
 * `oort update` (CON-114): which copies there are, what kind each is, what it runs for each (and
 * never for a temporary one), npm's lag after a release, the confirmation rules, the JSON, and
 * the store migration and daemon restart afterwards. Every copy is a stand-in in a throwaway HOME,
 * every installer, registry and daemon a fake: nothing is installed, nothing reaches the network.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHooks } from '@oortmem/claude-code';
import { VERSION } from '@oortmem/core';
import { harness, data, type Harness } from '../../test/helpers.js';
import { readUpdateCache } from '../update-check.js';
import {
  NPM_LAG_MS,
  classifyCopy,
  planUpdate,
  verifyInstall,
  type Copy,
  type UpdateDeps,
} from './update.js';

const LATEST = '0.6.3';
const NO_TMP = '/nonexistent-tmp-for-tests';

/** An npm prefix with oortmem `version` in it: `<prefix>/bin/oort` → the package's main.js. */
function npmPrefix(prefix: string, version = VERSION): { bin: string; main: string } {
  const pkg = path.join(prefix, 'lib', 'node_modules', 'oortmem');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'oortmem', version }));
  const main = path.join(pkg, 'dist', 'main.js');
  fs.writeFileSync(main, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  const bin = path.join(prefix, 'bin', 'oort');
  fs.symlinkSync(path.join('..', 'lib', 'node_modules', 'oortmem', 'dist', 'main.js'), bin);
  return { bin, main: fs.realpathSync(main) };
}

/** fnm: the npm global of one Node version, on PATH through a per-shell link. */
function fnm(root: string, version = VERSION): { pathDir: string; bin: string; prefix: string } {
  const prefix = path.join(
    root,
    '.local',
    'share',
    'fnm',
    'node-versions',
    'v22.15.0',
    'installation',
  );
  npmPrefix(prefix, version);
  const shells = path.join(root, '.local', 'state', 'fnm_multishells');
  fs.mkdirSync(shells, { recursive: true });
  const shell = path.join(shells, '51197_1793280789587');
  fs.symlinkSync(prefix, shell);
  return { pathDir: path.join(shell, 'bin'), bin: path.join(shell, 'bin', 'oort'), prefix };
}

/** A pnpm global: `<root>/Library/pnpm/oort` → `.pnpm/oortmem@<v>/node_modules/oortmem`. */
function pnpm(root: string, version = VERSION): { pathDir: string; main: string } {
  const pkg = path.join(
    root,
    'Library',
    'pnpm',
    'global',
    '5',
    '.pnpm',
    `oortmem@${version}`,
    'node_modules',
    'oortmem',
  );
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'oortmem', version }));
  const main = path.join(pkg, 'dist', 'main.js');
  fs.writeFileSync(main, '#!/bin/sh\n', { mode: 0o755 });
  const dir = path.join(root, 'Library', 'pnpm');
  fs.symlinkSync(main, path.join(dir, 'oort'));
  return { pathDir: dir, main: fs.realpathSync(main) };
}

/** The PyPI launcher, installed with pipx: `~/.local/bin/oort` → the venv's script. */
function pipx(root: string): { pathDir: string } {
  const venvBin = path.join(root, '.local', 'pipx', 'venvs', 'oortmem', 'bin');
  fs.mkdirSync(venvBin, { recursive: true });
  const script = path.join(venvBin, 'oort');
  fs.writeFileSync(script, `#!${path.join(venvBin, 'python')}\nfrom oortmem.cli import main\n`, {
    mode: 0o755,
  });
  const dir = path.join(root, '.local', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(script, path.join(dir, 'oort'));
  // What pipx installed, as pip records it: the version is read from here, never by running it.
  const site = path.join(venvBin, '..', 'lib', 'python3.12', 'site-packages');
  fs.mkdirSync(path.join(site, `oortmem-${VERSION}.dist-info`), { recursive: true });
  return { pathDir: dir };
}

/** A copy in npx's cache, as `npx oortmem` (and the PyPI launcher) run it. */
function npx(root: string, version = VERSION): string {
  const pkg = path.join(root, '.npm', '_npx', '6a1f2b', 'node_modules', 'oortmem');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'oortmem', version }));
  const main = path.join(pkg, 'dist', 'main.js');
  fs.writeFileSync(main, '#!/bin/sh\n', { mode: 0o755 });
  return fs.realpathSync(main);
}

interface Fakes {
  deps: Partial<UpdateDeps>;
  installs: { file: string; args: readonly string[]; cwd: string }[];
  node: { script: string; args: readonly string[] }[];
  slept: number[];
  daemon: { running: boolean; version?: string; pid?: number };
}

/**
 * Fake installers, registry, daemon and clock. An install "succeeds" by writing the new version
 * into the package it targets (`--prefix <p>`, or the pnpm package), unless `fail` says otherwise.
 */
function fakes(
  opts: {
    fail?: (attempt: number) => string | undefined;
    pnpmMain?: string;
    latest?: () => Promise<string>;
  } = {},
): Fakes {
  let clock = Date.parse('2026-11-06T12:00:00Z');
  let attempt = 0;
  const f: Fakes = {
    installs: [],
    node: [],
    slept: [],
    daemon: { running: false },
    deps: {},
  };
  f.deps = {
    latest: opts.latest ?? (async () => LATEST),
    run: async (file, args, _env, cwd) => {
      f.installs.push({ file, args, cwd });
      attempt++;
      const failure = opts.fail?.(attempt);
      if (failure !== undefined) return { code: 1, output: failure };
      const version = /oortmem@(\S+)/.exec(args.join(' '))?.[1] ?? '';
      const at = args.indexOf('--prefix');
      const pkg =
        at >= 0
          ? path.join(args[at + 1]!, 'lib', 'node_modules', 'oortmem', 'package.json')
          : path.join(path.dirname(path.dirname(opts.pnpmMain ?? '')), 'package.json');
      fs.writeFileSync(pkg, JSON.stringify({ name: 'oortmem', version }));
      return { code: 0, output: `added 1 package\n` };
    },
    runNode: async (script, args) => {
      f.node.push({ script, args });
      if (args[0] === 'doctor') {
        return {
          code: 0,
          stdout: JSON.stringify({
            schema: 'oort.v1',
            ok: true,
            data: {
              checks: [
                {
                  group: 'store',
                  name: 'store',
                  status: 'ok',
                  detail: '~/.oort/oort.sqlite opens; 3 memories visible from here',
                },
                {
                  group: 'store',
                  name: 'migration',
                  status: 'ok',
                  detail: 'migrated the store from schema version 3 to 4',
                },
                {
                  group: 'store',
                  name: 'backup',
                  status: 'info',
                  detail:
                    'the copy taken before the last schema migration is at ~/.oort/oort.sqlite.pre-v4.1',
                },
              ],
            },
          }),
        };
      }
      if (args[0] === 'serve' && args[1] === 'stop') f.daemon = { running: false };
      if (args[0] === 'serve' && args[1] === '--detach')
        f.daemon = { running: true, version: LATEST, pid: 4242 };
      return { code: 0, stdout: '{}' };
    },
    daemon: async () => f.daemon,
    sleep: async (ms) => {
      f.slept.push(ms);
      clock += ms;
    },
    now: () => clock,
    tmpdir: () => NO_TMP,
    platform: 'darwin',
  };
  return f;
}

interface Machine {
  h: Harness;
  env: Record<string, string>;
  managed?: { bin: string; main: string };
  /** A stand-in `npm` (never run: the fakes run nothing), appended to PATH unless `noNpm`. */
  tools: string;
  noNpm?: boolean;
}

/** A file that writes `marker` if anything ever runs it. */
function trap(file: string, marker: string, shebang = '#!/bin/sh'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${shebang}\necho ran >> '${marker}'\necho 0.0.1\n`, { mode: 0o755 });
}

/** A throwaway machine: `h.root` is HOME, `h.home` OORT_HOME; PATH holds only `pathDirs`. */
function machine(pathDirs: string[] = []): Machine {
  const h = harness();
  fs.mkdirSync(h.home, { recursive: true, mode: 0o700 });
  const tools = path.join(h.root, 'tools');
  trap(path.join(tools, 'npm'), path.join(h.root, 'NPM_RAN'));
  return {
    h,
    tools,
    env: { HOME: h.root, OORT_HOME: h.home, PATH: pathDirs.join(path.delimiter) },
  };
}

/** The managed copy (`~/.oort/cli`), with the Claude Code hooks pointing at it. */
function withManagedHooks(m: Machine, version = VERSION): { bin: string; main: string } {
  m.managed = npmPrefix(path.join(m.h.home, 'cli'), version);
  installHooks(path.join(m.h.root, '.claude', 'settings.json'), m.managed.main);
  return m.managed;
}

async function update(
  m: Machine,
  args: string[],
  f: Fakes,
  running: { script: string; entry?: string },
  io: Record<string, unknown> = {},
) {
  return m.h.run(
    ['update', ...args],
    {
      env: {
        ...m.env,
        PATH: [m.env.PATH ?? '', ...(m.noNpm === true ? [] : [m.tools])].join(path.delimiter),
      },
      entry: running.entry ?? running.script,
      ...io,
    },
    undefined,
    { binPath: running.script, updateDeps: f.deps },
  );
}

/** The installers run, as `npm …` (the file is the absolute npm found on PATH). */
const argv = (f: Fakes): string[] =>
  f.installs.map((i) => [path.basename(i.file), ...i.args].join(' '));

let net: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  net = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('oort update must not use the real network in tests');
  });
});
afterEach(() => {
  expect(net).not.toHaveBeenCalled();
  net.mockRestore();
});

describe('copy classification', () => {
  const where = { managedPrefix: '/Users/x/.oort/cli', tmp: '/private/var/folders/tmp' };
  const k = (found: string, real: string | undefined, head?: string) =>
    classifyCopy(found, real, { ...where, ...(head !== undefined && { head }) });

  it('update.classifies-every-kind-of-install', () => {
    const main = 'lib/node_modules/oortmem/dist/main.js';
    expect(k('/Users/x/.oort/cli/bin/oort', `/Users/x/.oort/cli/${main}`)).toEqual({
      kind: 'managed',
      prefix: '/Users/x/.oort/cli',
    });
    expect(k('/usr/local/bin/oort', `/usr/local/${main}`)).toEqual({
      kind: 'npm-global',
      prefix: '/usr/local',
    });
    expect(
      k('/Users/x/.nvm/versions/node/v22/bin/oort', `/Users/x/.nvm/versions/node/v22/${main}`),
    ).toMatchObject({
      kind: 'npm-global',
      versionManager: 'nvm',
    });
    // fnm: the PATH entry is a per-shell link; the install is that Node version's npm global.
    expect(
      k(
        '/Users/x/.local/state/fnm_multishells/1_2/bin/oort',
        `/Users/x/.local/share/fnm/node-versions/v22.15.0/installation/${main}`,
      ),
    ).toEqual({
      kind: 'npm-global',
      prefix: '/Users/x/.local/share/fnm/node-versions/v22.15.0/installation',
      versionManager: 'fnm',
    });
    expect(k('/Users/x/.local/state/fnm_multishells/1_2/bin/oort', undefined)).toMatchObject({
      kind: 'transient',
    });
    expect(
      k(
        '/Users/x/Library/pnpm/oort',
        '/Users/x/Library/pnpm/global/5/.pnpm/oortmem@0.6.1/node_modules/oortmem/dist/main.js',
      ),
    ).toEqual({ kind: 'pnpm-global' });
    expect(
      k(
        '/Users/x/.local/bin/oort',
        '/Users/x/.local/pipx/venvs/oortmem/bin/oort',
        '#!/Users/x/.local/pipx/venvs/oortmem/bin/python\n',
      ),
    ).toEqual({ kind: 'pypi', pipx: true });
    expect(
      k('/opt/py/bin/oort', '/opt/py/bin/oort', '#!/opt/py/bin/python3.12\nimport sys\n'),
    ).toEqual({
      kind: 'pypi',
      pipx: false,
      python: '/opt/py/bin/python3.12',
    });
    expect(k('/src/oort/packages/cli/dist/main.js', '/src/oort/packages/cli/dist/main.js')).toEqual(
      {
        kind: 'source',
        prefix: '/src/oort',
      },
    );
    expect(k('/x', '/Users/x/.npm/_npx/6a1f/node_modules/oortmem/dist/main.js')).toMatchObject({
      kind: 'transient',
    });
    expect(
      k('/x', '/Users/x/Library/Caches/pnpm/dlx/abc/node_modules/oortmem/dist/main.js'),
    ).toMatchObject({
      kind: 'transient',
    });
    expect(k('/x', `/private/var/folders/tmp/abc/${main}`)).toMatchObject({ kind: 'transient' });
    expect(k('/opt/homebrew/bin/oort', '/opt/homebrew/bin/oort', '\u007fELF')).toMatchObject({
      kind: 'unknown',
    });
  });

  it('update.plans-never-touch-a-temporary-copy-and-print-pip-instead-of-running-it', () => {
    const copies: Copy[] = [
      {
        path: '/t',
        realpath: '/t',
        kind: 'transient',
        version: '0.6.1',
        roles: ['running'],
        why: 'npx',
      },
      {
        path: '/p',
        realpath: '/p',
        kind: 'pypi',
        pipx: false,
        python: '/usr/bin/python3',
        version: '0.6.1',
        roles: ['path'],
        firstOnPath: true,
      },
    ];
    const plan = planUpdate(copies, LATEST);
    expect(plan[0]).toMatchObject({ action: 'transient' });
    expect(plan[0]?.argv).toBeUndefined();
    expect(plan[0]?.note).toContain('never updated in place');
    expect(plan[1]).toMatchObject({
      action: 'manual',
      command: '/usr/bin/python3 -m pip install -U oortmem',
    });
    expect(plan[1]?.argv).toBeUndefined();
  });
});

describe('oort update: the plan for each machine', () => {
  it('update.managed-only: one npm install into ~/.oort/cli, no shell', async () => {
    const m = machine();
    const managed = withManagedHooks(m, '0.6.2');
    const f = fakes();
    const r = await update(m, ['--yes', '--json'], f, { script: managed.main, entry: managed.bin });
    expect(r.code, r.io.stderr).toBe(0);
    // npm found on PATH as an absolute path, run with no shell from the home directory.
    expect(f.installs).toEqual([
      {
        file: path.join(m.tools, 'npm'),
        cwd: m.h.root,
        args: [
          'i',
          '-g',
          '--prefix',
          path.join(m.h.home, 'cli'),
          `oortmem@${LATEST}`,
          '--prefer-online',
        ],
      },
    ]);
    const d = data(r.io.stdout, 'update');
    expect(d.copies).toHaveLength(1);
    expect(d.copies[0]).toMatchObject({
      kind: 'managed',
      roles: ['running', 'hooks', 'managed'],
      action: 'update',
    });
    expect(d.installed[0]).toMatchObject({ ok: true, attempts: 1, version: LATEST });
    expect(d.releaseNotes).toBe(`https://github.com/oortmem/oort/releases/tag/v${LATEST}`);
    // The notices read the cache: it now knows the latest.
    expect(readUpdateCache(m.h.home).latest).toBe(LATEST);
  });

  it('update.managed-plus-fnm: both updated, each in its own prefix; the fnm link is named', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    const shell = fnm(m.h.root);
    m.env.PATH = shell.pathDir;
    const f = fakes();
    // Run as `oort update` from the fnm shell (as on the maintainer's machine).
    const r = await update(m, ['--yes', '--json'], f, {
      script: fs.realpathSync(shell.bin),
      entry: shell.bin,
    });
    expect(r.code, r.io.stderr).toBe(0);
    expect(argv(f)).toEqual([
      `npm i -g --prefix ${path.join(m.h.home, 'cli')} oortmem@${LATEST} --prefer-online`,
      `npm i -g --prefix ${shell.prefix} oortmem@${LATEST} --prefer-online`,
    ]);
    const d = data(r.io.stdout, 'update');
    const fnmCopy = d.copies.find((c: { path: string }) => c.path === shell.bin);
    expect(fnmCopy).toMatchObject({ kind: 'npm-global', firstOnPath: true, action: 'update' });
    expect(d.copies.find((c: { path: string }) => c.path === managed.bin)).toMatchObject({
      kind: 'managed',
      action: 'update',
    });
    // The human lines name the version manager.
    const human = await update(m, ['--check', '--version', '0.6.4'], fakes(), {
      script: fs.realpathSync(shell.bin),
      entry: shell.bin,
    });
    expect(human.io.stdout).toContain('under fnm');
    expect(human.io.stdout).toContain('first on PATH');
  });

  it('update.pnpm: the pnpm global gets its command printed, never run; npm for the managed copy', async () => {
    const m = machine();
    withManagedHooks(m);
    const p = pnpm(m.h.root);
    m.env.PATH = p.pathDir;
    const f = fakes({ pnpmMain: p.main });
    const r = await update(m, ['--yes', '--json'], f, {
      script: p.main,
      entry: path.join(p.pathDir, 'oort'),
    });
    expect(r.code, r.io.stderr).toBe(0);
    // pnpm's global directory moves with its version: oort update never runs pnpm.
    expect(argv(f)).toEqual([
      `npm i -g --prefix ${path.join(m.h.home, 'cli')} oortmem@${LATEST} --prefer-online`,
    ]);
    const d = data(r.io.stdout, 'update');
    expect(d.copies.find((c: { kind: string }) => c.kind === 'pnpm-global')).toMatchObject({
      action: 'manual',
      command: `pnpm add -g oortmem@${LATEST}`,
      removeCommand: 'pnpm rm -g oortmem',
    });
  });

  it('update.pnpm-shims-are-read-never-run: the target and its version come from the text', async () => {
    const m = machine();
    withManagedHooks(m);
    // A real pnpm global bin: a shell script naming the package's main.js, relative to itself.
    const pkg = path.join(
      m.h.root,
      'Library',
      'pnpm',
      'global',
      'v11',
      '9f8e',
      'node_modules',
      'oortmem',
    );
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'oortmem', version: '0.6.1' }),
    );
    const marker = path.join(m.h.root, 'SHIM_TARGET_RAN');
    trap(path.join(pkg, 'dist', 'main.js'), marker);
    const bin = path.join(m.h.root, 'Library', 'pnpm', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'oort'),
      [
        '#!/bin/sh',
        'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
        'if [ -x "$basedir/node" ]; then',
        '  exec "$basedir/node"  "$basedir/../global/v11/9f8e/node_modules/oortmem/dist/main.js" "$@"',
        'else',
        '  exec node  "$basedir/../global/v11/9f8e/node_modules/oortmem/dist/main.js" "$@"',
        'fi',
        `echo ran >> '${path.join(m.h.root, 'SHIM_RAN')}'`,
      ].join('\n'),
      { mode: 0o755 },
    );
    m.env.PATH = [path.join(m.h.home, 'cli', 'bin'), bin].join(path.delimiter);
    const r = await update(m, ['--check', '--json'], fakes(), {
      script: m.managed!.main,
      entry: m.managed!.bin,
    });
    expect(r.code, r.io.stderr).toBe(0);
    const shim = data(r.io.stdout, 'update').copies.find(
      (c: { path: string }) => c.path === path.join(bin, 'oort'),
    );
    expect(shim).toMatchObject({
      kind: 'pnpm-global',
      version: '0.6.1',
      realpath: fs.realpathSync(path.join(pkg, 'dist', 'main.js')),
      action: 'listed',
    });
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(m.h.root, 'SHIM_RAN'))).toBe(false);
  });

  it('update.pypi: the launcher gets its pipx command printed, never run; npx is never touched', async () => {
    const m = machine();
    const launcher = pipx(m.h.root);
    m.env.PATH = launcher.pathDir;
    // The launcher runs the release through npx when no other oort is installed.
    const cached = npx(m.h.root);
    const f = fakes();
    const r = await update(m, ['--yes', '--json'], f, { script: cached }, {});
    expect(r.code, r.io.stderr).toBe(0);
    expect(f.installs).toEqual([]);
    const d = data(r.io.stdout, 'update');
    expect(d.upToDate).toBe(false);
    expect(d.copies.find((c: { kind: string }) => c.kind === 'pypi')).toMatchObject({
      action: 'manual',
      command: 'pipx upgrade oortmem',
      removeCommand: 'pipx uninstall oortmem',
      version: VERSION,
    });
    expect(d.copies.find((c: { kind: string }) => c.kind === 'transient')).toMatchObject({
      action: 'transient',
    });
    const human = await update(m, ['--yes'], fakes(), { script: cached });
    expect(human.io.stdout).toContain('pipx upgrade oortmem');
    expect(human.io.stdout).toContain('never updated in place: it lives in the npx cache');
  });

  it('update.npx: the hooks copy is updated, the npx copy is explained and left alone', async () => {
    const m = machine();
    withManagedHooks(m);
    const cached = npx(m.h.root);
    const f = fakes();
    const r = await update(m, ['--yes'], f, { script: cached });
    expect(r.code, r.io.stderr).toBe(0);
    expect(argv(f)).toEqual([
      `npm i -g --prefix ${path.join(m.h.home, 'cli')} oortmem@${LATEST} --prefer-online`,
    ]);
    expect(r.io.stdout).toContain('never updated in place: it lives in the npx cache');
    expect(fs.existsSync(cached)).toBe(true);
  });

  it('update.other-copies-on-path-are-listed-with-commands-and-never-deleted', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    const p = pnpm(m.h.root, '0.6.1');
    const global = npmPrefix(path.join(m.h.root, 'usr-local'), '0.6.0');
    // `oort` in this shell is the managed copy; the others come after it.
    m.env.PATH = [
      path.join(m.h.home, 'cli', 'bin'),
      p.pathDir,
      path.join(m.h.root, 'usr-local', 'bin'),
    ].join(path.delimiter);
    const f = fakes();
    const r = await update(m, ['--yes'], f, { script: managed.main, entry: managed.bin });
    expect(r.code, r.io.stderr).toBe(0);
    expect(f.installs).toHaveLength(1);
    expect(r.io.stdout).toContain('Other copies of oort, left as they are');
    expect(r.io.stdout).toContain(`update it: pnpm add -g oortmem@${LATEST}`);
    expect(r.io.stdout).toContain('or remove it: pnpm rm -g oortmem');
    expect(r.io.stdout).toContain(`or remove it: npm rm -g --prefix ~/usr-local oortmem`);
    expect(fs.existsSync(p.main)).toBe(true);
    expect(fs.existsSync(global.main)).toBe(true);
  });
});

describe("oort update: npm's lag after a release", () => {
  const ETARGET =
    'npm error code ETARGET\nnpm error notarget No matching version found for oortmem@0.6.3.\n';

  it('update.retries-etarget-with-backoff-and-a-progress-line', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    const f = fakes({ fail: (n) => (n <= 2 ? ETARGET : undefined) });
    const r = await update(m, ['--yes', '--json'], f, { script: managed.main, entry: managed.bin });
    expect(r.code, r.io.stderr).toBe(0);
    expect(f.installs).toHaveLength(3);
    expect(f.slept).toEqual([5000, 10_000]);
    expect(r.io.stderr).toContain(`npm does not list oortmem ${LATEST} yet`);
    expect(r.io.stderr).toContain('trying again in 5 s, 120 s left');
    expect(data(r.io.stdout, 'update').installed[0]).toMatchObject({ ok: true, attempts: 3 });
  });

  it('update.gives-up-after-2-minutes-and-exits-1', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    const f = fakes({ fail: () => ETARGET });
    const r = await update(m, ['--yes', '--json'], f, { script: managed.main, entry: managed.bin });
    expect(r.code).toBe(1);
    expect(f.slept.reduce((a, b) => a + b, 0)).toBe(NPM_LAG_MS);
    const env = JSON.parse(r.io.stdout) as {
      ok: boolean;
      exitCode: number;
      data: { installed: { ok: boolean }[] };
    };
    expect(env).toMatchObject({ ok: true, exitCode: 1 });
    expect(env.data.installed[0]?.ok).toBe(false);
  });

  it('update.another-failure-is-not-retried', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    const f = fakes({ fail: () => 'npm error code EACCES\n' });
    const r = await update(m, ['--yes'], f, { script: managed.main, entry: managed.bin });
    expect(r.code).toBe(1);
    expect(f.installs).toHaveLength(1);
    expect(f.slept).toEqual([]);
    expect(r.io.stdout).toContain('the installer failed');
  });
});

describe('oort update: confirmation (CON-107)', () => {
  it('confirm.update-no-tty-refuses-json-refuses-declined-exits-0-yes-runs', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    const running = { script: managed.main, entry: managed.bin };
    // No terminal on stdin: refused, exit 2, nothing run, no prompt.
    let f = fakes();
    let r = await update(m, [], f, running);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('stdin is not a terminal');
    expect(r.io.asked).toEqual([]);
    expect(f.installs).toEqual([]);
    // --json never asks, even on a terminal.
    f = fakes();
    r = await update(m, ['--json'], f, running, { tty: true });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.io.stdout)).toMatchObject({
      ok: false,
      error: { code: 'needs-confirmation', fix: 'oort update --json --yes' },
    });
    expect(f.installs).toEqual([]);
    // Declined on a terminal: exit 0, nothing run, the question on stderr only.
    f = fakes();
    r = await update(m, [], f, running, { tty: true, answer: 'n' });
    expect(r.code).toBe(0);
    expect(r.io.asked[0]).toContain(`Update 1 copy of oort to ${LATEST}?`);
    expect(r.io.stdout).not.toContain('[y/N]');
    expect(r.io.stdout).toContain('Nothing updated.');
    expect(f.installs).toEqual([]);
    // Yes: it runs.
    f = fakes();
    r = await update(m, [], f, running, { tty: true, answer: 'y' });
    expect(r.code).toBe(0);
    expect(f.installs).toHaveLength(1);
  });
});

describe('oort update: --check, --json and --version', () => {
  it('update.check-reports-only-and-exits-0-with-an-update-available', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    const f = fakes();
    const r = await update(m, ['--check', '--json'], f, {
      script: managed.main,
      entry: managed.bin,
    });
    expect(r.code).toBe(0);
    expect(f.installs).toEqual([]);
    expect(f.node).toEqual([]);
    const env = JSON.parse(r.io.stdout) as Record<string, unknown>;
    expect(env).toMatchObject({ schema: 'oort.v1', command: 'update', ok: true });
    expect(env['exitCode']).toBeUndefined();
    const d = env['data'] as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(
      [
        'check',
        'copies',
        'current',
        'daemon',
        'from',
        'installed',
        'latest',
        'migration',
        'releaseNotes',
        'upToDate',
      ].sort(),
    );
    expect(d).toMatchObject({
      current: VERSION,
      latest: LATEST,
      from: 'npm',
      check: true,
      upToDate: false,
    });
    expect(Object.keys((d['copies'] as object[])[0]!).sort()).toEqual(
      [
        'action',
        'command',
        'firstOnPath',
        'kind',
        'note',
        'path',
        'realpath',
        'removeCommand',
        'roles',
        'version',
      ].sort(),
    );
    // Human --check: the plan and the hint, nothing run.
    const human = await update(m, ['--check'], fakes(), {
      script: managed.main,
      entry: managed.bin,
    });
    expect(human.code).toBe(0);
    expect(human.io.stdout).toContain('Run `oort update` to update.');
  });

  it('update.up-to-date-asks-nothing-and-runs-nothing', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    const f = fakes({ latest: async () => VERSION });
    const r = await update(m, [], f, { script: managed.main, entry: managed.bin });
    expect(r.code).toBe(0);
    expect(r.io.asked).toEqual([]);
    expect(f.installs).toEqual([]);
    expect(r.io.stdout).toContain('up to date');
  });

  it('update.version-flag-pins-the-release-and-skips-the-registry', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    const f = fakes({
      latest: async () => {
        throw new Error('the registry must not be asked');
      },
    });
    const r = await update(m, ['--version', '0.6.4', '--yes', '--json'], f, {
      script: managed.main,
      entry: managed.bin,
    });
    expect(r.code, r.io.stderr).toBe(0);
    expect(argv(f)[0]).toContain('oortmem@0.6.4');
    expect(data(r.io.stdout, 'update')).toMatchObject({ latest: '0.6.4', from: '--version' });
    const bad = await update(m, ['--version', '0.6.4; rm -rf ~', '--json'], fakes(), {
      script: managed.main,
    });
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.io.stdout)).toMatchObject({ ok: false, error: { code: 'usage' } });
  });

  it('update.registry-unreachable-is-a-network-error-exit-1', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    const f = fakes({
      latest: async () => {
        throw new Error('fetch failed');
      },
    });
    const r = await update(m, ['--json'], f, { script: managed.main, entry: managed.bin });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.io.stdout)).toMatchObject({
      ok: false,
      error: { code: 'network', exitCode: 1 },
    });
  });
});

describe('oort update: after installing', () => {
  it('update.stops-the-daemon-migrates-with-the-new-copy-and-starts-it-again', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    fs.writeFileSync(path.join(m.h.home, 'oort.sqlite'), '');
    const f = fakes();
    f.daemon = { running: true, version: VERSION, pid: 999 };
    const r = await update(m, ['--yes', '--json'], f, { script: managed.main, entry: managed.bin });
    expect(r.code, r.io.stderr).toBe(0);
    // In order, all from the new copy: stop the old daemon, migrate (doctor), start the new one.
    expect(f.node).toEqual([
      { script: managed.main, args: ['serve', 'stop', '--json'] },
      { script: managed.main, args: ['doctor', '--json'] },
      { script: managed.main, args: ['serve', '--detach', '--json'] },
    ]);
    const d = data(r.io.stdout, 'update');
    expect(d.migration).toMatchObject({
      ran: true,
      ok: true,
      migrated: 'migrated the store from schema version 3 to 4',
    });
    expect(d.migration.backup).toContain('pre-v4');
    expect(d.daemon).toMatchObject({
      running: true,
      version: VERSION,
      restarted: true,
      now: { version: LATEST, pid: 4242 },
    });
    const human = await update(m, ['--yes', '--version', '0.6.4'], fakes(), {
      script: managed.main,
      entry: managed.bin,
    });
    expect(human.io.stdout).toContain('store: migrated the store from schema version 3 to 4');
    expect(human.io.stdout).toContain(
      'Release notes: https://github.com/oortmem/oort/releases/tag/v0.6.4',
    );
  });

  it('update.no-store-no-daemon-nothing-else-runs', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    const f = fakes();
    const r = await update(m, ['--yes', '--json'], f, { script: managed.main, entry: managed.bin });
    expect(r.code).toBe(0);
    expect(f.node).toEqual([]);
    expect(data(r.io.stdout, 'update').migration).toEqual({ ran: false });
  });
});

describe('oort update: an install counts only when the copy is the target (I1)', () => {
  it('update.an-installer-that-exits-0-but-changes-nothing-is-a-failure', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    fs.writeFileSync(path.join(m.h.home, 'oort.sqlite'), '');
    const f = fakes();
    f.daemon = { running: true, version: VERSION, pid: 999 };
    f.deps.run = async (file, args, _env, cwd) => {
      f.installs.push({ file, args, cwd });
      return { code: 0, output: 'up to date in 1s\n' };
    };
    const r = await update(m, ['--yes', '--json'], f, { script: managed.main, entry: managed.bin });
    expect(r.code).toBe(1);
    const env = JSON.parse(r.io.stdout) as { exitCode: number; data: Record<string, any> };
    expect(env.exitCode).toBe(1);
    expect(env.data['installed'][0]).toMatchObject({
      ok: false,
      unverified: true,
      version: VERSION,
    });
    // Nothing runs from an unverified copy: no migration, the daemon left as it was.
    expect(f.node).toEqual([]);
    expect(env.data['migration']).toEqual({ ran: false });
    expect(env.data['daemon']).toMatchObject({ running: true, restarted: false });
    const human = await update(m, ['--yes'], f, { script: managed.main, entry: managed.bin });
    expect(human.io.stdout).toContain(
      `✗ ~/oort-home/cli/bin/oort: the installer finished, but this copy is oort ${VERSION}, not oortmem ${LATEST}`,
    );
    expect(human.io.stdout).toContain('Skipped the store migration and the oort serve restart');
    expect(human.io.stdout).toContain('oort serve stop && oort serve --detach');
  });

  it('update.a-copy-that-still-resolves-to-a-stale-pnpm-path-is-a-failure', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    // The installer "succeeds", but the copy's link now leads to an old .pnpm/oortmem@… package
    // that happens to say the target version: not the prefix just installed into.
    const stale = path.join(
      m.h.root,
      'Library',
      'pnpm',
      'global',
      '5',
      '.pnpm',
      'oortmem@0.6.1',
      'node_modules',
      'oortmem',
    );
    fs.mkdirSync(path.join(stale, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(stale, 'package.json'),
      JSON.stringify({ name: 'oortmem', version: LATEST }),
    );
    fs.writeFileSync(path.join(stale, 'dist', 'main.js'), '');
    const f = fakes();
    f.deps.run = async (file, args, _env, cwd) => {
      f.installs.push({ file, args, cwd });
      fs.rmSync(managed.bin);
      fs.symlinkSync(path.join(stale, 'dist', 'main.js'), managed.bin);
      return { code: 0, output: '' };
    };
    // Run as the managed bin, so the copy's path is the link that moved.
    const r = await update(m, ['--yes', '--json'], f, { script: managed.bin, entry: managed.bin });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.io.stdout).data.installed[0]).toMatchObject({
      ok: false,
      unverified: true,
    });
    expect(f.node).toEqual([]);
  });

  it('update.verify-install-checks-the-realpath-and-the-version', () => {
    const root = harness().root;
    const p = path.join(root, 'prefix');
    const fresh = npmPrefix(p, LATEST);
    expect(verifyInstall({ path: fresh.bin, prefix: p }, LATEST)).toMatchObject({
      ok: true,
      version: LATEST,
    });
    expect(verifyInstall({ path: fresh.bin, prefix: p }, '0.6.4')).toMatchObject({
      ok: false,
      version: LATEST,
    });
    expect(verifyInstall({ path: fresh.bin, prefix: path.join(root, 'other') }, LATEST).ok).toBe(
      false,
    );
    expect(verifyInstall({ path: path.join(root, 'gone'), prefix: p }, LATEST).ok).toBe(false);
  });
});

describe('oort update: discovering copies runs none of them (I2)', () => {
  it('update.no-copy-on-path-is-ever-run-in-any-mode', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    const marker = path.join(m.h.root, 'RAN');
    // An unrecognised oort, a Python-looking one with no metadata, and a shell script whose text
    // names nothing: none may run, whatever the mode.
    trap(path.join(m.h.root, 'bin-a', 'oort'), marker);
    trap(path.join(m.h.root, 'bin-b', 'oort'), marker, '#!/usr/bin/env python3');
    trap(path.join(m.h.root, 'bin-c', 'oort'), marker, '#!/bin/bash');
    m.env.PATH = ['bin-a', 'bin-b', 'bin-c']
      .map((d) => path.join(m.h.root, d))
      .join(path.delimiter);
    const running = { script: managed.main, entry: managed.bin };
    const modes: [string[], Record<string, unknown>][] = [
      [['--check'], {}],
      [['--check', '--json'], {}],
      [['--json'], { tty: true }],
      [[], {}],
      [[], { tty: true, answer: 'n' }],
      [['--yes'], {}],
      [['--yes', '--json'], {}],
    ];
    for (const [args, io] of modes) {
      const f = fakes();
      const r = await update(m, args, f, running, io);
      expect(fs.existsSync(marker), args.join(' ')).toBe(false);
      expect(fs.existsSync(path.join(m.h.root, 'NPM_RAN'))).toBe(false);
      if (args.includes('--check')) {
        expect(f.installs).toEqual([]);
        expect(f.node).toEqual([]);
      }
      if (args.join(' ') === '--check') {
        expect(r.io.stdout).toContain('version unknown, unrecognised');
        expect(r.io.stdout).toContain('version unknown, PyPI launcher (pip)');
      }
    }
  });

  it('update.a-pypi-launcher-version-comes-from-its-dist-info', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    m.env.PATH = pipx(m.h.root).pathDir;
    const r = await update(m, ['--check', '--json'], fakes(), {
      script: managed.main,
      entry: managed.bin,
    });
    expect(
      data(r.io.stdout, 'update').copies.find((c: { kind: string }) => c.kind === 'pypi'),
    ).toMatchObject({
      version: VERSION,
      command: 'pipx upgrade oortmem',
    });
  });
});

describe('oort update: what it prints and what it runs with (M1, M5)', () => {
  it('update.control-characters-in-a-path-are-shown-never-sent-to-the-terminal', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    const evil = path.join(m.h.root, 'p \u001b]0;TITLE\u0007\u001b[31mRED\u009b2J');
    npmPrefix(evil, '0.6.1');
    m.env.PATH = [path.join(m.h.home, 'cli', 'bin'), path.join(evil, 'bin')].join(path.delimiter);
    const check = await update(m, ['--check'], fakes(), {
      script: managed.main,
      entry: managed.bin,
    });
    const yes = await update(m, ['--yes'], fakes(), { script: managed.main, entry: managed.bin });
    for (const r of [check, yes]) {
      const all = `${r.io.stdout}${r.io.stderr}`;
      expect(all).not.toMatch(/[\u001b\u0007\u009b]/);
      expect(all).toContain('\\u{1b}[31mRED');
    }
  });

  it('update.with-no-npm-on-path-it-prints-the-command-and-runs-nothing', async () => {
    const m = machine();
    const managed = withManagedHooks(m);
    m.noNpm = true;
    // A relative PATH entry with an npm in it is never used either.
    trap(path.join(m.h.cwd, 'rel', 'npm'), path.join(m.h.root, 'REL_NPM_RAN'));
    m.env.PATH = 'rel';
    const f = fakes();
    const r = await update(m, ['--yes', '--json'], f, { script: managed.main, entry: managed.bin });
    expect(r.code).toBe(0);
    expect(f.installs).toEqual([]);
    expect(data(r.io.stdout, 'update').copies[0]).toMatchObject({
      action: 'manual',
      note: 'no npm on PATH to run it with',
      command: `npm i -g --prefix ~/oort-home/cli oortmem@${LATEST} --prefer-online`,
    });
  });
});
