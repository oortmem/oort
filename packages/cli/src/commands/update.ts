import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hookStatus } from '@oortmem/claude-code';
import { VERSION, resolveHome } from '@oortmem/core';
import { binPath, runForwarding, runNodeScript } from '../io.js';
import { emit, jsonMode } from '../output.js';
import { callDaemon } from '../serve-client.js';
import { isNewerVersion, socketPathFor } from '../serve-protocol.js';
import { uiFor, type Ui } from '../ui.js';
import {
  asVersion,
  fetchLatest,
  readUpdateCache,
  releaseNotesUrl,
  writeUpdateCache,
} from '../update-check.js';
import { Refusal, confirm, echo, shellWord as sh, shown, tilde, type Ctx } from '../util.js';
import { hookBinaryOf, settingsFile, versionManagerOf } from './install.js';

/**
 * `oort update [--check] [--yes] [--json] [--version <x.y.z>]` (CON-114): every copy of oort that
 * matters to this machine, brought to the latest release with one confirmation.
 *
 * - **Which copies.** The hooks' copy (the binary `~/.claude/settings.json` runs), the running copy
 *   (this process's script), the managed copy (`~/.oort/cli`, `npm i -g --prefix ~/.oort/cli`), and
 *   every other `oort` on PATH. Finding them runs nothing: each copy's version is read from files
 *   (the nearest oortmem package.json, a pnpm shim's target, a PyPI launcher's dist-info).
 * - **What it runs.** For the hooks', the running and the managed copy, and the first `oort` on
 *   PATH (what `oort` runs in this shell), when it is an npm install (the managed copy, an npm
 *   global): `npm i -g --prefix <prefix> oortmem@X --prefer-online`, the prefix named so the right
 *   copy changes whichever npm comes first, `npm` found on PATH as an absolute path and run with no
 *   shell from the home directory. pnpm globals, PyPI launchers and checkouts get their command
 *   printed, never run. A copy in a temporary place (the npx cache, pnpm dlx, a temp dir, fnm's
 *   link for a shell that ended) is never updated in place.
 * - **Verified.** An install counts only when the copy then resolves to `<prefix>/lib/node_modules/
 *   oortmem/dist/main.js` and that package says the target version.
 * - **npm's lag.** For a minute or so after a release npm answers ETARGET; the install is retried
 *   with backoff for up to 2 minutes, with a progress line.
 * - **After.** With a verified copy only: `oort serve` is stopped if it runs, that copy's `oort
 *   doctor --json` migrates the store (after copying it) exactly as doctor does, and it starts the
 *   daemon again. Older copies left on PATH are listed with the command that updates or removes
 *   each; nothing is ever deleted.
 */

export interface UpdateOptions {
  check?: boolean;
  yes?: boolean;
  json?: boolean;
  version?: string;
}

/** Everything `oort update` does outside its own logic; tests fake each one. */
export interface UpdateDeps {
  /** npm's latest `oortmem` (default: `fetchLatest` with `ctx.fetch`). */
  latest(): Promise<string>;
  /**
   * Runs an installer (an absolute path) in `cwd`, its output forwarded to stderr; resolves the
   * exit code and output tail.
   */
  run(
    file: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
  ): Promise<{ code: number; output: string }>;
  /** Runs `node <script> <args>` (a verified copy of oort); resolves the exit code and stdout. */
  runNode(
    script: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; stdout: string }>;
  /** Whether `oort serve` answers, and its version and pid. */
  daemon(): Promise<{ running: boolean; version?: string; pid?: number }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** The system's temporary directory (a copy inside it is temporary). */
  tmpdir(): string;
  platform: NodeJS.Platform;
}

/** How long `oort update` waits out npm's lag after a release (ETARGET). */
export const NPM_LAG_MS = 2 * 60_000;
/** What npm prints for a version its registry does not list yet. */
const NOT_LISTED_YET = /\bETARGET\b|No matching version found|notarget/i;

export type CopyKind =
  'managed' | 'npm-global' | 'pnpm-global' | 'pypi' | 'source' | 'transient' | 'unknown';

export type CopyRole = 'hooks' | 'running' | 'managed' | 'path';

export interface Copy {
  /** The path as found: the hooks' binary, this process's script, a PATH entry. */
  path: string;
  /** Where it really lives, when the path resolves (through a pnpm shim, its target). */
  realpath?: string;
  kind: CopyKind;
  /** Its version, read from its files; absent when they say nothing (never by running it). */
  version?: string;
  roles: CopyRole[];
  /** The first `oort` on PATH: what typing `oort` runs in this shell. */
  firstOnPath?: boolean;
  /** The npm prefix (managed and npm globals) or the checkout (source). */
  prefix?: string;
  /** A Node version manager the copy lives under (`fnm`, `nvm`, `Volta`, `asdf`). */
  versionManager?: string;
  /** PyPI: installed with pipx, else with pip under `python`. */
  pipx?: boolean;
  python?: string;
  /** Why it is transient or not recognised. */
  why?: string;
}

export type Action = 'update' | 'current' | 'manual' | 'listed' | 'transient' | 'unknown';

export interface PlannedCopy extends Copy {
  action: Action;
  /** The installer `oort update` runs (`update`): an absolute file and arguments, never a shell line. */
  argv?: [string, string[]];
  /** The command for people: the same installer, or the one to run yourself. */
  command?: string;
  /** The command that removes it (`listed` and `manual`): printed, never run. */
  removeCommand?: string;
  note?: string;
}

const MANAGER_NAME: Record<string, string> = {
  '.nvm/': 'nvm',
  fnm_multishells: 'fnm',
  'node-versions/': 'fnm',
  '.volta/': 'Volta',
  '.asdf/': 'asdf',
};

const slash = (p: string): string => p.replaceAll('\\', '/');

/**
 * What kind of install a copy is, from where it really lives (`real`) and where it was found
 * (`found`); `head` is the start of the found file (a Python launcher's shebang). Pure.
 */
export function classifyCopy(
  found: string,
  real: string | undefined,
  where: { managedPrefix: string; tmp: string; head?: string },
): Omit<Copy, 'path' | 'realpath' | 'roles' | 'version'> {
  const f = slash(found);
  const r = real === undefined ? undefined : slash(real);
  for (const p of [r, f]) {
    if (p === undefined) continue;
    const segments = p.split('/');
    if (segments.includes('_npx')) {
      return {
        kind: 'transient',
        why: 'it lives in the npx cache, which keeps whatever version a later `npx oortmem` asks for',
      };
    }
    if (segments.includes('dlx')) {
      return { kind: 'transient', why: "it lives in pnpm dlx's cache, which pnpm clears" };
    }
  }
  if (r === undefined) {
    return f.includes('fnm_multishells')
      ? { kind: 'transient', why: "it is fnm's link for a shell that has ended" }
      : { kind: 'unknown', why: 'the file it points to is gone' };
  }
  const tmp = slash(where.tmp);
  if (r === tmp || r.startsWith(`${tmp}/`)) {
    return { kind: 'transient', why: 'it lives in a temporary directory, which the system clears' };
  }
  const managed = slash(where.managedPrefix);
  if (r.startsWith(`${managed}/`)) return { kind: 'managed', prefix: where.managedPrefix };
  if (
    /\/\.pnpm\/oortmem@[^/]+\/node_modules\/oortmem\//.test(r) ||
    /\/pnpm\/(global|store)\//.test(r)
  ) {
    return { kind: 'pnpm-global' };
  }
  const npm = /^(.*)\/lib\/node_modules\/oortmem\/dist\/main\.js$/.exec(r);
  if (npm?.[1] !== undefined) {
    const marker = versionManagerOf(r) ?? versionManagerOf(f);
    return {
      kind: 'npm-global',
      prefix: path.normalize(npm[1]),
      ...(marker !== undefined && { versionManager: MANAGER_NAME[marker] ?? marker }),
    };
  }
  const source = /^(.*)\/packages\/cli\/dist\/main\.js$/.exec(r);
  if (source?.[1] !== undefined && !r.includes('/node_modules/')) {
    return { kind: 'source', prefix: path.normalize(source[1]) };
  }
  const head = where.head ?? '';
  const shebang = /^#!\s*(\S+)/.exec(head)?.[1];
  if (/^#!.*python/.test(head) || r.includes('/pipx/venvs/')) {
    const pipx = r.includes('/pipx/venvs/') || (shebang?.includes('/pipx/venvs/') ?? false);
    return { kind: 'pypi', pipx, ...(shebang !== undefined && !pipx && { python: shebang }) };
  }
  return {
    kind: 'unknown',
    why: 'not an npm, pnpm, pipx or pip install that oort update knows how to update',
  };
}

/** npm's arguments for installing oortmem `target` into `prefix` (the managed copy, an npm global). */
export const npmArgs = (prefix: string, target: string): string[] => [
  'i',
  '-g',
  '--prefix',
  prefix,
  `oortmem@${target}`,
  '--prefer-online',
];

/**
 * What `oort update` does with each copy (pure): runs npm for the hooks', the running, the
 * managed copy and the first on PATH when they are npm installs and behind (only with `npm`, an
 * absolute path found on PATH; else it prints the command), prints the command for a pnpm global,
 * a PyPI launcher or a checkout, lists any other older copy on PATH with the command that updates
 * or removes it, and never touches a temporary one. `explicit` (`--version`): any other version
 * is behind.
 */
export function planUpdate(
  copies: readonly Copy[],
  target: string,
  opts: { explicit?: boolean; platform?: NodeJS.Platform; home?: string; npm?: string } = {},
): PlannedCopy[] {
  const show = (p: string): string => (opts.home === undefined ? p : tilde(p, opts.home));
  return copies.map((c): PlannedCopy => {
    const behind =
      c.version === undefined ||
      (opts.explicit === true ? c.version !== target : isNewerVersion(target, c.version));
    if (!behind) return { ...c, action: 'current' };
    // The copies that matter: the hooks', the running, the managed one, and what `oort` runs.
    const primary = c.firstOnPath === true || c.roles.some((r) => r !== 'path');
    switch (c.kind) {
      case 'managed':
      case 'npm-global': {
        const prefix = c.prefix ?? '';
        const command = ['npm', ...npmArgs(show(prefix), target)].map(sh).join(' ');
        const removeCommand = `npm rm -g --prefix ${sh(show(prefix))} oortmem`;
        if (primary && opts.platform !== 'win32' && opts.npm !== undefined) {
          return { ...c, action: 'update', argv: [opts.npm, npmArgs(prefix, target)], command };
        }
        return {
          ...c,
          action: primary ? 'manual' : 'listed',
          command,
          removeCommand,
          ...(primary && opts.npm === undefined && { note: 'no npm on PATH to run it with' }),
        };
      }
      case 'pnpm-global':
        // pnpm's global directory moves with its version and settings (`global/5`, the isolated
        // `global/v11/<hash>` of pnpm 11): `pnpm add -g` cannot be pointed at this copy for sure.
        return {
          ...c,
          action: primary ? 'manual' : 'listed',
          command: `pnpm add -g oortmem@${target}`,
          removeCommand: 'pnpm rm -g oortmem',
          ...(primary && {
            note: 'run it with the pnpm that installed this copy; oort update never runs pnpm for you',
          }),
        };
      case 'pypi': {
        const python = c.python ?? 'python3';
        return {
          ...c,
          action: 'manual',
          command:
            c.pipx === true ? 'pipx upgrade oortmem' : `${sh(python)} -m pip install -U oortmem`,
          removeCommand:
            c.pipx === true ? 'pipx uninstall oortmem' : `${sh(python)} -m pip uninstall oortmem`,
          note: 'the Python launcher from PyPI runs the oortmem release it was built for; oort update never runs pip for you',
        };
      }
      case 'source':
        return {
          ...c,
          action: 'manual',
          command: `cd ${sh(show(c.prefix ?? '.'))} && git pull && pnpm install && pnpm build`,
          note: 'built from a checkout of the repository',
        };
      case 'transient':
        return {
          ...c,
          action: 'transient',
          note: `never updated in place: ${c.why ?? 'it lives in a temporary place'}`,
        };
      default:
        return { ...c, action: 'unknown', note: c.why ?? 'not an install oort update knows' };
    }
  });
}

/**
 * Every executable `name` on PATH, in PATH order: a lookup in code, no shell, and only absolute
 * PATH entries (a relative one would make the answer depend on the cwd).
 */
export function onPath(name: string, env: Record<string, string | undefined>): string[] {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  const out: string[] = [];
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (!fs.statSync(candidate).isFile()) continue;
        if (!out.includes(candidate)) out.push(candidate);
      } catch {
        // not here
      }
    }
  }
  return out;
}

/** Every executable `oort` on PATH, in PATH order. */
export const oortsOnPath = (env: Record<string, string | undefined>): string[] =>
  onPath('oort', env);

const realpathOf = (p: string): string | undefined => {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * Up to `max` bytes of `file`, only when it is a regular file: opened non-blocking and checked with
 * fstat first, so a FIFO (or a device) in its place can never hang the read. Undefined otherwise.
 */
function readRegular(file: string, max: number): Buffer | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return undefined;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return undefined;
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n);
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

function readPackage(dir: string): { name?: unknown; version?: unknown } | undefined {
  const raw = readRegular(path.join(dir, 'package.json'), 1024 * 1024);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw.toString('utf8')) as { name?: unknown; version?: unknown };
  } catch {
    return undefined;
  }
}

/** The version in the package.json beside `<x>/dist/main.js`, when it is oortmem's. */
export function packageVersion(real: string | undefined): string | undefined {
  const m = real === undefined ? null : /^(.*)[\\/]dist[\\/]main\.js$/.exec(real);
  if (m?.[1] === undefined) return undefined;
  const pkg = readPackage(m[1]);
  return pkg?.name === 'oortmem' ? asVersion(pkg.version) : undefined;
}

/**
 * The version of the oortmem package `real` lies in: the nearest package.json above it named
 * `oortmem` (at most six levels up). A file, never a process.
 */
export function nearestPackageVersion(real: string | undefined): string | undefined {
  if (real === undefined) return undefined;
  let dir = path.dirname(real);
  for (let i = 0; i < 6; i++) {
    const pkg = readPackage(dir);
    if (pkg !== undefined && pkg.name === 'oortmem') return asVersion(pkg.version);
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/** The first `bytes` of a file as text, or '' when it cannot be read. Reads, never runs. */
function fileHead(file: string, bytes = 256): string {
  return readRegular(file, bytes)?.toString('utf8') ?? '';
}

/** Whether `head` starts a POSIX shell script (`#!/bin/sh`, `#!/usr/bin/env bash`, …). */
const isShellScript = (head: string): boolean =>
  head.startsWith('#!') && /\b(?:sh|bash)\b/.test(head.split('\n', 1)[0] ?? '');

/**
 * The script a package manager's shell shim runs (pnpm's global bins, cmd-shim): read from the
 * shim's text (`"$basedir/…/main.js"` below the shim's own directory, or an absolute path to a
 * `.js` file), never by running it. Text anyone can write: what it names is only ever shown as a
 * pnpm global (print-only, see `discoverCopies`), never given an npm prefix.
 */
export function shimTarget(file: string): string | undefined {
  const text = fileHead(file, 4096);
  if (!isShellScript(text)) return undefined;
  const dir = path.dirname(file);
  const rel = /"\$basedir\/([^"$`]+\.[cm]?js)"/.exec(text)?.[1];
  // `$basedir/…` must stay under the shim's own directory once normalised (no `..` out of it).
  const below = rel === undefined ? undefined : path.normalize(path.join(dir, rel));
  const candidates = [
    ...(below !== undefined && below.startsWith(dir + path.sep) ? [below] : []),
    ...[...text.matchAll(/"(\/[^"$`]+\.[cm]?js)"/g)].map((m) => m[1] as string),
  ];
  for (const c of candidates) {
    const real = realpathOf(c);
    if (real !== undefined && fs.statSync(real).isFile()) return real;
  }
  return undefined;
}

/**
 * A PyPI launcher's version from its installed metadata (`oortmem-<v>.dist-info` in the
 * environment's site-packages), next to the script or its interpreter. A directory read; never
 * the launcher itself.
 */
export function pypiVersion(script: string, python: string | undefined): string | undefined {
  const bases = [path.dirname(path.dirname(script))];
  if (python !== undefined) bases.push(path.dirname(path.dirname(python)));
  for (const base of bases) {
    let pys: string[];
    try {
      pys = fs.readdirSync(path.join(base, 'lib')).filter((d) => /^python\d/.test(d));
    } catch {
      continue;
    }
    for (const py of pys) {
      try {
        for (const e of fs.readdirSync(path.join(base, 'lib', py, 'site-packages'))) {
          const v = asVersion(/^oortmem-(.+)\.dist-info$/.exec(e)?.[1]);
          if (v !== undefined) return v;
        }
      } catch {
        // no site-packages here
      }
    }
  }
  return undefined;
}

/** The binary the Claude Code hooks run (user settings), or undefined when there are none. */
function hooksBinary(ctx: Ctx): string | undefined {
  const file = settingsFile(false, ctx);
  if (!fs.existsSync(file)) return undefined;
  try {
    for (const e of hookStatus(file).events) {
      if (e.command === undefined) continue;
      const bin = hookBinaryOf(`${e.command} hook ${e.event}`);
      if (bin === undefined) continue;
      // A bare `oort` (the plugin, an older install) runs whatever comes first on PATH.
      return bin === 'oort' ? oortsOnPath(ctx.io.env)[0] : bin;
    }
  } catch {
    // Unparseable settings: doctor reports them; the hooks' copy is unknown here.
  }
  return undefined;
}

/** The managed copy's prefix: `<OORT_HOME>/cli` (`npm i -g --prefix ~/.oort/cli oortmem`). */
export const managedPrefixFor = (env: Record<string, string | undefined>): string =>
  path.join(resolveHome(env), 'cli');

/**
 * Every copy that matters: the running one, the hooks', the managed one and each `oort` on PATH,
 * merged by where they really live, with their kind and version. Reads files only: no copy is
 * ever run to find out what it is.
 */
export function discoverCopies(ctx: Ctx, deps: Pick<UpdateDeps, 'tmpdir'>): Copy[] {
  const env = ctx.io.env;
  const script = ctx.binPath ?? binPath();
  const managedPrefix = managedPrefixFor(env);
  const tmp = realpathOf(deps.tmpdir()) ?? deps.tmpdir();
  const scriptReal = realpathOf(script);
  const found: { path: string; role: CopyRole; first?: boolean }[] = [];
  // This process: as typed (the PATH link, which may be fnm's), when it is the same file.
  const entry = ctx.io.entry;
  found.push({
    path: entry !== undefined && realpathOf(entry) === scriptReal ? entry : script,
    role: 'running',
  });
  const hooks = hooksBinary(ctx);
  if (hooks !== undefined) found.push({ path: hooks, role: 'hooks' });
  const managedBin = path.join(managedPrefix, 'bin', 'oort');
  if (realpathOf(managedBin) !== undefined) found.push({ path: managedBin, role: 'managed' });
  oortsOnPath(env).forEach((p, i) => found.push({ path: p, role: 'path', first: i === 0 }));

  const copies = new Map<string, Copy>();
  for (const f of found) {
    const fileReal = realpathOf(f.path);
    let real = fileReal;
    const isJs = (p: string | undefined): boolean =>
      p !== undefined && /[\\/]dist[\\/]main\.js$/.test(p);
    // A shell shim (pnpm's global bins): the script it names, read from its text. On Unix npm
    // never installs shell shims, so a shim's target is never an npm copy and never merges into
    // one: it is keyed by the shim itself.
    let viaShim = false;
    if (real !== undefined && !isJs(real)) {
      const target = shimTarget(real);
      if (target !== undefined) {
        real = target;
        viaShim = true;
      }
    }
    const key = viaShim ? `shim:${fileReal ?? f.path}` : (real ?? f.path);
    const seen = copies.get(key);
    if (seen !== undefined) {
      if (!seen.roles.includes(f.role)) seen.roles.push(f.role);
      if (f.first === true) seen.firstOnPath = true;
      // Show a bin link (`~/.oort/cli/bin/oort`) rather than the script it points at.
      if (isJs(seen.path) && !isJs(f.path)) seen.path = f.path;
      continue;
    }
    const head = real !== undefined && !isJs(real) ? fileHead(real) : undefined;
    let kind = classifyCopy(f.path, real, {
      managedPrefix: realpathOf(managedPrefix) ?? managedPrefix,
      tmp,
      ...(head !== undefined && { head }),
    });
    let trusted = true;
    if (viaShim && kind.kind !== 'pnpm-global' && kind.kind !== 'transient') {
      // Shim text names an npm prefix, a checkout, the managed copy…: never believed.
      kind = {
        kind: 'unknown',
        why: 'a shell script that names something other than a pnpm global; oort update only reads it',
      };
      trusted = false;
      real = fileReal; // shown as what it is: the script, not what its text claims
    } else if (
      !viaShim &&
      head !== undefined &&
      isShellScript(head) &&
      /[\\/]pnpm[\\/]/.test(f.path)
    ) {
      // A pnpm shim whose target could not be read (or leaves its directory): pnpm, version unknown.
      kind = { kind: 'pnpm-global' };
      trusted = false;
    }
    const version = !trusted
      ? undefined
      : real !== undefined && real === scriptReal
        ? VERSION
        : kind.kind === 'pypi' && real !== undefined
          ? pypiVersion(real, kind.python ?? /^#!\s*(\S+)/.exec(head ?? '')?.[1])
          : nearestPackageVersion(real);
    copies.set(key, {
      path: f.path,
      ...(real !== undefined && { realpath: real }),
      ...kind,
      ...(version !== undefined && { version }),
      roles: [f.role],
      ...(f.first === true && { firstOnPath: true }),
    });
  }
  return [...copies.values()];
}

/** The defaults: the real network, installers, daemon and clock. */
export function defaultUpdateDeps(ctx: Ctx): UpdateDeps {
  return {
    latest: () => fetchLatest(ctx.fetch ?? globalThis.fetch, { timeoutMs: 10_000 }),
    run: (file, args, env, cwd) => runForwarding(file, args, { env, cwd }),
    runNode: (script, args, env) => runNodeScript(script, args, { env }),
    daemon: async () => {
      if (process.platform === 'win32') return { running: false };
      const r = await callDaemon(
        socketPathFor(resolveHome(ctx.io.env), ctx.io.env),
        'ping',
        {},
        { budgetMs: 1000 },
      );
      if (!r.ok) return { running: false };
      const version = asVersion(r.result['version']);
      const pid = r.result['pid'];
      return {
        running: true,
        ...(version !== undefined && { version }),
        ...(Number.isSafeInteger(pid) && { pid: pid as number }),
      };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    tmpdir: () => os.tmpdir(),
    platform: process.platform,
  };
}

const KIND_LABEL: Record<CopyKind, string> = {
  managed: 'managed',
  'npm-global': 'npm global',
  'pnpm-global': 'pnpm global',
  pypi: 'PyPI launcher',
  source: 'built from a checkout',
  transient: 'temporary',
  unknown: 'unrecognised',
};

/** One copy's version, kind and roles, for people; every path in it made safe to print. */
function describeCopy(c: PlannedCopy, home: string): string {
  const where =
    c.kind === 'managed' || (c.kind === 'npm-global' && c.prefix !== undefined)
      ? `${KIND_LABEL[c.kind]} (${tilde(c.prefix ?? '', home)}${c.versionManager !== undefined ? `, under ${c.versionManager}` : ''})`
      : c.kind === 'pypi'
        ? `${KIND_LABEL[c.kind]} (${c.pipx === true ? 'pipx' : 'pip'})`
        : KIND_LABEL[c.kind];
  const roles = [
    ...(c.roles.includes('hooks') ? ['the hooks run it'] : []),
    ...(c.roles.includes('running') ? ['running now'] : []),
    ...(c.firstOnPath === true ? ['first on PATH'] : c.roles.includes('path') ? ['on PATH'] : []),
  ];
  const version = c.version === undefined ? 'version unknown' : `oort ${c.version}`;
  return shown(`${version}, ${where}${roles.length > 0 ? `; ${roles.join(', ')}` : ''}`);
}

/**
 * Each copy and what happens to it, for people: its path, then its version and kind, then the
 * command (indented), so a long path never pushes the rest off the screen.
 */
function planText(ui: Ui, plan: readonly PlannedCopy[], home: string): string {
  const lines: string[] = [];
  for (const c of plan) {
    const mark =
      c.action === 'current'
        ? ui.green('✓')
        : c.action === 'update'
          ? ui.yellow('↑')
          : c.action === 'transient' || c.action === 'unknown'
            ? ui.dim('•')
            : ui.yellow('!');
    lines.push(`  ${mark} ${shown(tilde(c.path, home))}`, `      ${describeCopy(c, home)}`);
    const then =
      c.action === 'update'
        ? `update: ${c.command ?? ''}`
        : c.action === 'manual'
          ? `update it yourself: ${c.command ?? ''}${c.note !== undefined ? ` (${c.note})` : ''}`
          : c.action === 'listed'
            ? `update it: ${c.command ?? ''}\n      or remove it: ${c.removeCommand ?? ''}`
            : c.action === 'transient' || c.action === 'unknown'
              ? (c.note ?? '')
              : '';
    if (then !== '') {
      lines.push(
        ...then.split('\n').map((l) => ui.dim(shown(l.startsWith('      ') ? l : `      ${l}`))),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface Installed {
  path: string;
  command: string;
  ok: boolean;
  attempts: number;
  /** The installer exited 0, but the copy does not resolve to the target's package (I1). */
  unverified?: true;
  version?: string;
  realpath?: string;
}

const seconds = (ms: number): string => `${Math.ceil(ms / 1000)} s`;

/**
 * Whether the installer really changed this copy: it resolves to `<prefix>/lib/node_modules/
 * oortmem/dist/main.js` for the prefix just installed into, and that package is the target. An
 * exit code alone proves nothing (a stale link, an installer that did nothing).
 */
export function verifyInstall(
  c: Pick<Copy, 'path' | 'prefix'>,
  target: string,
): { ok: boolean; realpath?: string; version?: string } {
  const real = realpathOf(c.path);
  const version = packageVersion(real);
  if (real === undefined || c.prefix === undefined) return { ok: false };
  const prefix = realpathOf(c.prefix) ?? c.prefix;
  const expected = path.join(prefix, 'lib', 'node_modules', 'oortmem', 'dist', 'main.js');
  return {
    ok: real === expected && version === target,
    realpath: real,
    ...(version !== undefined && { version }),
  };
}

/**
 * Runs one copy's installer (`c.argv`: an absolute file and its arguments, no shell) in `cwd`,
 * waiting out npm's lag (ETARGET) for up to NPM_LAG_MS, then verifies the copy (`verifyInstall`).
 * `oort setup` and `oort install` use it for the managed copy too.
 */
export async function runInstaller(
  ctx: Ctx,
  deps: Pick<UpdateDeps, 'run' | 'now' | 'sleep'>,
  c: Pick<PlannedCopy, 'path' | 'prefix' | 'argv' | 'command'>,
  target: string,
  cwd: string,
): Promise<Installed> {
  const [file, args] = c.argv as [string, string[]];
  const started = deps.now();
  let delay = 5000;
  for (let attempts = 1; ; attempts++) {
    const r = await deps.run(file, args, ctx.io.env as NodeJS.ProcessEnv, cwd);
    const base = { path: c.path, command: c.command ?? '', attempts };
    if (r.code === 0) {
      const v = verifyInstall(c, target);
      return {
        ...base,
        ok: v.ok,
        ...(!v.ok && { unverified: true as const }),
        ...(v.version !== undefined && { version: v.version }),
        ...(v.realpath !== undefined && { realpath: v.realpath }),
      };
    }
    const left = started + NPM_LAG_MS - deps.now();
    if (!NOT_LISTED_YET.test(r.output) || left <= 0) return { ...base, ok: false };
    const wait = Math.min(delay, left);
    ctx.io.err(
      `oort: npm does not list oortmem ${target} yet (a release takes a minute or so to reach every npm server); trying again in ${seconds(wait)}, ${seconds(left)} left\n`,
    );
    await deps.sleep(wait);
    delay = Math.min(delay * 2, 30_000);
  }
}

interface Migration {
  ran: boolean;
  ok?: boolean;
  /** Doctor's own lines: the store opens, what the migration did, where its copy is. */
  store?: string;
  migrated?: string;
  backup?: string;
}

/** The new copy's `oort doctor --json`: it migrates the store (copying it first), as doctor does. */
async function migrate(ctx: Ctx, deps: UpdateDeps, script: string): Promise<Migration> {
  const home = resolveHome(ctx.io.env);
  if (!fs.existsSync(path.join(home, 'oort.sqlite'))) return { ran: false };
  const r = await deps.runNode(script, ['doctor', '--json'], ctx.io.env as NodeJS.ProcessEnv);
  try {
    const env = JSON.parse(r.stdout) as {
      data?: { checks?: { group?: string; name?: string; status?: string; detail?: string }[] };
    };
    const checks = env.data?.checks ?? [];
    const row = (name: string) => checks.find((c) => c.group === 'store' && c.name === name);
    const store = row('store');
    return {
      ran: true,
      ok: store?.status === 'ok',
      ...(store?.detail !== undefined && { store: shown(store.detail) }),
      ...(row('migration')?.detail !== undefined && { migrated: shown(row('migration')?.detail) }),
      ...(row('backup')?.detail !== undefined && { backup: shown(row('backup')?.detail) }),
    };
  } catch {
    return { ran: true, ok: false };
  }
}

/** `oort update`. */
export async function updateCommand(opts: UpdateOptions, ctx: Ctx): Promise<number> {
  const deps = { ...defaultUpdateDeps(ctx), ...ctx.updateDeps };
  const { io } = ctx;
  const userHome = io.env['HOME'] || os.homedir();
  const home = resolveHome(io.env);
  const ui = uiFor(io);
  const json = jsonMode(ctx);

  let target: string;
  const explicit = opts.version !== undefined;
  if (opts.version !== undefined) {
    const v = asVersion(opts.version.replace(/^v/, ''));
    if (v === undefined) {
      throw new Refusal(`--version ${echo(opts.version)} is not a version (0.6.3, 0.7.0-rc.1).`);
    }
    target = v;
  } else {
    try {
      target = await deps.latest();
    } catch (e) {
      throw new Refusal(
        `Could not ask npm's registry for the latest oortmem (${shown((e as Error).message)}). Check your network, or name the version: \`oort update --version <x.y.z>\`.`,
        { code: 'network', exitCode: 1 },
      );
    }
    // The notices read this cache: it now knows the latest.
    writeUpdateCache(home, { ...readUpdateCache(home), checkedAt: deps.now(), latest: target });
  }

  const copies = discoverCopies(ctx, deps);
  const npm = onPath('npm', io.env)[0];
  const plan = planUpdate(copies, target, {
    explicit,
    platform: deps.platform,
    home: userHome,
    ...(npm !== undefined && { npm }),
  });
  const daemon = await deps.daemon();
  const toRun = plan
    .filter((c) => c.action === 'update')
    // The hooks' copy first, then the managed one, then the running one and the PATH's first.
    .sort((a, b) => rank(a) - rank(b));
  // Up to date: every copy that matters here (the hooks', the running and the managed one) is.
  const upToDate = plan.every(
    (c) => c.action === 'current' || (c.firstOnPath !== true && c.roles.every((r) => r === 'path')),
  );
  const restartDaemon = daemon.running && toRun.length > 0;
  const notes = releaseNotesUrl(target);
  const copiesJson = plan.map((c) => ({
    path: c.path,
    realpath: c.realpath ?? null,
    kind: c.kind,
    version: c.version ?? null,
    roles: c.roles,
    firstOnPath: c.firstOnPath === true,
    action: c.action,
    command: c.command ?? null,
    removeCommand: c.removeCommand ?? null,
    note: c.note ?? null,
  }));
  const base = {
    current: VERSION,
    latest: target,
    from: explicit ? '--version' : 'npm',
    check: opts.check === true,
    upToDate,
    copies: copiesJson,
    releaseNotes: notes,
  };

  io.out(
    ui.header(
      'update',
      upToDate
        ? ui.success(`up to date, oort ${target} is the latest`)
        : VERSION === target
          ? `latest ${target}`
          : `${VERSION} → ${target}`,
    ),
  );
  io.out(planText(ui, plan, userHome));
  if (daemon.running) {
    io.out(
      `${ui.info(
        `oort serve runs oort ${shown(daemon.version ?? '?')}${daemon.pid !== undefined ? ` (pid ${daemon.pid})` : ''}${
          restartDaemon
            ? ': it restarts with the new version'
            : daemon.version !== undefined && isNewerVersion(target, daemon.version)
              ? ': it exits at the next hook from a newer oort (or run oort serve stop && oort serve --detach)'
              : ''
        }`,
      )}\n`,
    );
  }

  if (opts.check === true || toRun.length === 0) {
    if (opts.check === true && toRun.length > 0) {
      io.out(`${ui.dim('Run `oort update` to update.')}\n`);
    } else if (!upToDate) {
      io.out(`${ui.dim('Nothing here that oort update runs itself: use the commands above.')}\n`);
    }
    io.out(`${ui.dim(`Release notes: ${notes}`)}\n`);
    if (json)
      emit(ctx, {
        ...base,
        installed: [],
        migration: { ran: false },
        daemon: daemonJson(daemon, false),
      });
    return 0;
  }

  const n = toRun.length;
  const ok = await confirm(
    io,
    `Update ${n} ${n === 1 ? 'copy' : 'copies'} of oort to ${target}${restartDaemon ? ' and restart oort serve' : ''}?`,
    opts.yes === true,
    'update',
    { json },
  );
  if (!ok) {
    io.out('Nothing updated.\n');
    if (json)
      emit(ctx, {
        ...base,
        declined: true,
        installed: [],
        migration: { ran: false },
        daemon: daemonJson(daemon, false),
      });
    return 0;
  }

  const installed: Installed[] = [];
  for (const c of toRun) {
    io.err(`oort: ${shown(c.command ?? '')}\n`);
    // From the home directory: never a project's .npmrc or package.json.
    const r = await runInstaller(ctx, deps, c, target, userHome);
    installed.push(r);
    const where = shown(tilde(c.path, userHome));
    io.out(
      `${
        r.ok
          ? ui.ok(`${where}: oort ${r.version ?? target}`)
          : r.unverified === true
            ? ui.fail(
                `${where}: the installer finished, but this copy is ${r.version === undefined ? 'not' : `oort ${shown(r.version)}, not`} oortmem ${target} in ${shown(tilde(c.prefix ?? '', userHome))} (${shown(c.command ?? '')})`,
              )
            : ui.fail(
                `${where}: the installer failed${r.attempts > 1 ? ` after ${r.attempts} tries` : ''} (${shown(c.command ?? '')})`,
              )
      }\n`,
    );
    if (!r.ok) break; // the rest would fail the same way; nothing half-done is hidden
  }
  const failed = installed.some((r) => !r.ok);
  // The copy the hooks (and so the daemon) now run: the hooks', else the managed, else this one.
  const after =
    installed.find((r) => r.ok && toRun.find((c) => c.path === r.path)?.roles.includes('hooks')) ??
    installed.find(
      (r) => r.ok && toRun.find((c) => c.path === r.path)?.roles.includes('managed'),
    ) ??
    installed.find((r) => r.ok);
  // Only a verified copy runs anything next: its realpath is the target's package in the prefix
  // just installed into (`verifyInstall`).
  const script = after?.ok === true ? after.realpath : undefined;
  if (script === undefined && (daemon.running || fs.existsSync(path.join(home, 'oort.sqlite')))) {
    io.out(
      `${ui.warn(
        `Skipped the store migration${daemon.running ? ' and the oort serve restart' : ''}: no copy was verified at oortmem ${target}. Once one is, run oort doctor${daemon.running ? ', then oort serve stop && oort serve --detach' : ''}.`,
      )}\n`,
    );
  }
  let migration: Migration = { ran: false };
  let restarted = false;
  let newDaemon: { running: boolean; version?: string; pid?: number } | undefined;
  if (script !== undefined) {
    const env = io.env as NodeJS.ProcessEnv;
    // The old daemon holds the store open: stop it before the migration, start the new one after.
    if (daemon.running) await deps.runNode(script, ['serve', 'stop', '--json'], env);
    migration = await migrate(ctx, deps, script);
    if (migration.ran) {
      io.out(
        migration.ok === true
          ? `${ui.ok(`store: ${migration.migrated ?? migration.store ?? 'opens'}`)}\n${migration.backup !== undefined ? `${ui.info(migration.backup)}\n` : ''}`
          : `${ui.warn('store: the new oort could not open it; run oort doctor')}\n`,
      );
    }
    if (daemon.running) {
      const started = await deps.runNode(script, ['serve', '--detach', '--json'], env);
      newDaemon = await deps.daemon();
      restarted = started.code === 0 && newDaemon.running;
      io.out(
        restarted
          ? `${ui.ok(`oort serve: restarted, oort ${shown(newDaemon.version ?? '?')}${newDaemon.pid !== undefined ? ` (pid ${newDaemon.pid})` : ''}`)}\n`
          : `${ui.warn('oort serve: did not start again; run oort serve --detach (the hooks run in-process meanwhile)')}\n`,
      );
    }
  }

  const left = plan.filter(
    (c) => c.action === 'listed' || c.action === 'manual' || c.action === 'unknown',
  );
  if (left.length > 0) {
    io.out(`\n${ui.bold('Other copies of oort, left as they are')}\n`);
    io.out(planText(ui, left, userHome));
  }
  io.out(`${ui.dim(`Release notes: ${notes}`)}\n`);
  if (json) {
    emit(ctx, {
      ...base,
      installed,
      migration,
      daemon: {
        ...daemonJson(daemon, restarted),
        ...(newDaemon !== undefined && { now: daemonJson(newDaemon, false) }),
      },
    });
  }
  return failed ? 1 : 0;
}

function rank(c: PlannedCopy): number {
  return c.roles.includes('hooks') ? 0 : c.roles.includes('managed') ? 1 : 2;
}

function daemonJson(
  d: { running: boolean; version?: string; pid?: number },
  restarted: boolean,
): Record<string, unknown> {
  return { running: d.running, version: d.version ?? null, pid: d.pid ?? null, restarted };
}
