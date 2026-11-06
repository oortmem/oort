import { execFile } from 'node:child_process';
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
import { Refusal, confirm, echo, shown, tilde, type Ctx } from '../util.js';
import { hookBinaryOf, settingsFile, versionManagerOf } from './install.js';

/**
 * `oort update [--check] [--yes] [--json] [--version <x.y.z>]` (CON-114): every copy of oort that
 * matters to this machine, brought to the latest release with one confirmation.
 *
 * - **Which copies.** The hooks' copy (the binary `~/.claude/settings.json` runs), the running copy
 *   (this process's script), the managed copy (`~/.oort/cli`, `npm i -g --prefix ~/.oort/cli`), and
 *   every other `oort` on PATH.
 * - **What it runs.** For the hooks', the running and the managed copy, and the first `oort` on
 *   PATH (what `oort` runs in this shell), the installer that made
 *   it: `npm i -g --prefix <prefix> oortmem@X --prefer-online` (the managed copy and npm globals,
 *   the prefix named so the right copy changes whichever npm comes first) or `pnpm add -g
 *   oortmem@X`. A PyPI launcher gets its pipx or pip command printed, never run. A copy in a
 *   temporary place (the npx cache, pnpm dlx, a temp dir, fnm's link for a shell that ended) is
 *   never updated in place. Installers run with no shell, through `UpdateDeps.run`.
 * - **npm's lag.** For a minute or so after a release npm answers ETARGET; the install is retried
 *   with backoff for up to 2 minutes, with a progress line.
 * - **After.** `oort serve` is stopped if it runs, the new copy's `oort doctor --json` migrates the
 *   store (after copying it) exactly as doctor does, and the daemon is started again from the new
 *   copy. Older copies left on PATH are listed with the command that updates or removes each;
 *   nothing is ever deleted.
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
  /** Runs an installer, its output forwarded to stderr; resolves the exit code and output tail. */
  run(
    file: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; output: string }>;
  /** Runs `node <script> <args>` (a copy of oort); resolves the exit code and stdout. */
  runNode(
    script: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; stdout: string }>;
  /** `<bin> <args>` with no shell and a short timeout: a version probe; undefined on failure. */
  probe(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string | undefined>;
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
/** What npm and pnpm print for a version their registry does not list yet. */
const NOT_LISTED_YET =
  /\bETARGET\b|No matching version found|ERR_PNPM_NO_MATCHING_VERSION|notarget/i;

export type CopyKind =
  'managed' | 'npm-global' | 'pnpm-global' | 'pypi' | 'source' | 'transient' | 'unknown';

export type CopyRole = 'hooks' | 'running' | 'managed' | 'path';

export interface Copy {
  /** The path as found: the hooks' binary, this process's script, a PATH entry. */
  path: string;
  /** Where it really lives, when the path resolves. */
  realpath?: string;
  kind: CopyKind;
  /** Its version, when it could be read (package.json, or a probe). */
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
  /** The installer `oort update` runs (`update`): file and arguments, never a shell line. */
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
    /\/\.pnpm\/oortmem@[^/]+\/node_modules\/oortmem\/dist\/main\.js$/.test(r) ||
    /\/pnpm\/global\//.test(r)
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

/** `arg` as a shell word for people to copy (single-quoted when it needs it). */
function sh(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

const npmArgs = (prefix: string, target: string): string[] => [
  'i',
  '-g',
  '--prefix',
  prefix,
  `oortmem@${target}`,
  '--prefer-online',
];

/**
 * What `oort update` does with each copy (pure): runs the installer for the hooks', the running
 * and the managed copy when they are behind, prints the command for a PyPI launcher or a
 * checkout, lists any other older copy on PATH with the command that updates or removes it, and
 * never touches a temporary one. `explicit` (`--version`): any other version is behind.
 */
export function planUpdate(
  copies: readonly Copy[],
  target: string,
  opts: { explicit?: boolean; platform?: NodeJS.Platform; home?: string } = {},
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
        const argv: [string, string[]] = ['npm', npmArgs(prefix, target)];
        const command = ['npm', ...npmArgs(show(prefix), target)].map(sh).join(' ');
        const removeCommand = `npm rm -g --prefix ${sh(show(prefix))} oortmem`;
        if (primary && opts.platform !== 'win32') {
          return { ...c, action: 'update', argv, command };
        }
        return { ...c, action: primary ? 'manual' : 'listed', command, removeCommand };
      }
      case 'pnpm-global': {
        const command = `pnpm add -g oortmem@${target}`;
        if (primary && opts.platform !== 'win32') {
          return {
            ...c,
            action: 'update',
            argv: ['pnpm', ['add', '-g', `oortmem@${target}`]],
            command,
          };
        }
        return {
          ...c,
          action: primary ? 'manual' : 'listed',
          command,
          removeCommand: 'pnpm rm -g oortmem',
        };
      }
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

/** Every executable `oort` on PATH, in PATH order (a lookup in code, no shell). */
export function oortsOnPath(env: Record<string, string | undefined>): string[] {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  const out: string[] = [];
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `oort${ext}`);
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

const realpathOf = (p: string): string | undefined => {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
};

/** The version in the package.json beside `<x>/dist/main.js`, when it is oortmem's. */
export function packageVersion(real: string | undefined): string | undefined {
  const m = real === undefined ? null : /^(.*)[\\/]dist[\\/]main\.js$/.exec(real);
  if (m?.[1] === undefined) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(m[1], 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    return pkg.name === 'oortmem' ? asVersion(pkg.version) : undefined;
  } catch {
    return undefined;
  }
}

function fileHead(file: string): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
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
 * merged by where they really live, with their kind and version.
 */
export async function discoverCopies(ctx: Ctx, deps: UpdateDeps): Promise<Copy[]> {
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
    const real = realpathOf(f.path);
    const key = real ?? f.path;
    const seen = copies.get(key);
    if (seen !== undefined) {
      if (!seen.roles.includes(f.role)) seen.roles.push(f.role);
      if (f.first === true) seen.firstOnPath = true;
      // Show a bin link (`~/.oort/cli/bin/oort`) rather than the script it points at.
      if (/[\\/]dist[\\/]main\.js$/.test(seen.path) && !/[\\/]dist[\\/]main\.js$/.test(f.path)) {
        seen.path = f.path;
      }
      continue;
    }
    const isJs = real !== undefined && /[\\/]dist[\\/]main\.js$/.test(real);
    const kind = classifyCopy(f.path, real, {
      managedPrefix: realpathOf(managedPrefix) ?? managedPrefix,
      tmp,
      ...(!isJs && real !== undefined && { head: fileHead(real) }),
    });
    copies.set(key, {
      path: f.path,
      ...(real !== undefined && { realpath: real }),
      ...kind,
      roles: [f.role],
      ...(f.first === true && { firstOnPath: true }),
    });
  }
  const childEnv = env as NodeJS.ProcessEnv;
  for (const c of copies.values()) {
    let version =
      c.realpath !== undefined && c.realpath === scriptReal ? VERSION : packageVersion(c.realpath);
    if (version === undefined && c.kind === 'pypi') {
      // The launcher pins the release it runs: `oortmem (Python launcher) X, runs oortmem@X`.
      const out = await deps.probe(c.path, ['--launcher-version'], childEnv);
      version = asVersion(/oortmem@(\S+)/.exec(out ?? '')?.[1]);
    } else if (version === undefined && c.kind === 'unknown' && c.realpath !== undefined) {
      version = asVersion(
        /\d+\.\d+\.\d+[^\s]*/.exec((await deps.probe(c.path, ['--version'], childEnv)) ?? '')?.[0],
      );
    }
    if (version !== undefined) c.version = version;
  }
  return [...copies.values()];
}

/** The defaults: the real network, installers, daemon and clock. */
export function defaultUpdateDeps(ctx: Ctx): UpdateDeps {
  return {
    latest: () => fetchLatest(ctx.fetch ?? globalThis.fetch, { timeoutMs: 10_000 }),
    run: (file, args, env) => runForwarding(file, args, { env }),
    runNode: (script, args, env) => runNodeScript(script, args, { env }),
    probe: (bin, args, env) =>
      new Promise((resolve) => {
        execFile(
          bin,
          [...args],
          { timeout: 5000, env, encoding: 'utf8', windowsHide: true },
          (err, stdout) => resolve(err === null ? String(stdout) : undefined),
        );
      }),
    daemon: async () => {
      if (process.platform === 'win32') return { running: false };
      const r = await callDaemon(
        socketPathFor(resolveHome(ctx.io.env), ctx.io.env),
        'ping',
        {},
        {
          budgetMs: 1000,
        },
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
  return `${version}, ${where}${roles.length > 0 ? `; ${roles.join(', ')}` : ''}`;
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

interface Installed {
  path: string;
  command: string;
  ok: boolean;
  attempts: number;
  version?: string;
  realpath?: string;
}

const seconds = (ms: number): string => `${Math.ceil(ms / 1000)} s`;

/** Runs one copy's installer, waiting out npm's lag (ETARGET) for up to NPM_LAG_MS. */
async function install(
  ctx: Ctx,
  deps: UpdateDeps,
  c: PlannedCopy,
  target: string,
): Promise<Installed> {
  const [file, args] = c.argv as [string, string[]];
  const started = deps.now();
  let delay = 5000;
  for (let attempts = 1; ; attempts++) {
    const r = await deps.run(file, args, ctx.io.env as NodeJS.ProcessEnv);
    const base = { path: c.path, command: c.command ?? '', attempts };
    if (r.code === 0) {
      const real = realpathOf(c.path);
      const version = packageVersion(real);
      return {
        ...base,
        ok: true,
        ...(version !== undefined && { version }),
        ...(real !== undefined && { realpath: real }),
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

  const copies = await discoverCopies(ctx, deps);
  const plan = planUpdate(copies, target, { explicit, platform: deps.platform, home: userHome });
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
    io.err(`oort: ${c.command ?? ''}\n`);
    const r = await install(ctx, deps, c, target);
    installed.push(r);
    io.out(
      `${
        r.ok
          ? ui.ok(`${shown(tilde(c.path, userHome))}: oort ${r.version ?? target}`)
          : ui.fail(
              `${shown(tilde(c.path, userHome))}: the installer failed${r.attempts > 1 ? ` after ${r.attempts} tries` : ''} (${shown(c.command ?? '')})`,
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
  const script = after?.realpath;
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
