import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VERSION, ensurePrivateDir, resolveHome } from '@oortmem/core';
import { binPath } from '../io.js';
import { isNewerVersion } from '../serve-protocol.js';
import { Refusal, shellWord as sh, shown, tilde, type Ctx } from '../util.js';
import { hookCommandPath, unstableCopy } from './install.js';
import {
  defaultUpdateDeps,
  managedPrefixFor,
  npmArgs,
  onPath,
  packageVersion,
  runInstaller,
  verifyInstall,
} from './update.js';

/**
 * The managed copy of oort: `<OORT_HOME>/cli` (`~/.oort/cli`), installed with
 * `npm i -g --prefix ~/.oort/cli oortmem`. It is the copy the Claude Code hooks and the MCP
 * entries run, because it stays put: an npm global under a Node version manager (nvm, fnm, Volta,
 * asdf) moves when Node changes, fnm's `fnm_multishells` links last one shell, and npx's copy is a
 * cache. `oort setup` installs it, `oort install` and `oort connect` point agents at it (and
 * install it first when the running copy is one of those), and `oort update` keeps it current.
 */

export interface Managed {
  /** `<OORT_HOME>/cli`, as configured (not resolved). */
  prefix: string;
  /** `<prefix>/bin/oort`. */
  bin: string;
  /** The realpath of `<prefix>/lib/node_modules/oortmem/dist/main.js`: what agents run. */
  main: string;
  version: string;
}

const isExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

const realpathOf = (p: string | undefined): string | undefined => {
  if (p === undefined) return undefined;
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * The managed copy, only when it checks out: `<prefix>/bin/oort` resolves to the oortmem package
 * in that prefix (`verifyInstall`), whose `package.json` names a version, and the script is
 * executable. Reads files; never runs it.
 */
export function managedCopy(env: Record<string, string | undefined>): Managed | undefined {
  const prefix = managedPrefixFor(env);
  const bin = path.join(prefix, 'bin', 'oort');
  const version = packageVersion(realpathOf(bin));
  if (version === undefined) return undefined;
  const v = verifyInstall({ path: bin, prefix }, version);
  if (!v.ok || v.realpath === undefined || !isExecutable(v.realpath)) return undefined;
  return { prefix, bin, main: v.realpath, version };
}

/** The managed copy is this version or newer: setup and install use it as it is. */
export const managedIsCurrent = (m: Managed | undefined): m is Managed =>
  m !== undefined && !isNewerVersion(VERSION, m.version);

/** The prefix as people see it: `~/.oort/cli`, one shell word. */
export function shownPrefix(env: Record<string, string | undefined>): string {
  const home = env['HOME'] || os.homedir();
  return shown(sh(tilde(managedPrefixFor(env), home)));
}

/** The command that installs the managed copy by hand: `npm i -g --prefix ~/.oort/cli oortmem`. */
export const manualInstall = (env: Record<string, string | undefined>): string =>
  `npm i -g --prefix ${shownPrefix(env)} oortmem`;

/** What `installManaged` runs, for people: `npm i -g --prefix ~/.oort/cli oortmem@X --prefer-online`. */
export function installCommandFor(
  env: Record<string, string | undefined>,
  target = VERSION,
): string {
  const home = env['HOME'] || os.homedir();
  return ['npm', ...npmArgs(tilde(managedPrefixFor(env), home), target)]
    .map((a) => shown(sh(a)))
    .join(' ');
}

/**
 * Where the managed copy's script will be once installed (for a preview before installing):
 * `<prefix>/lib/node_modules/oortmem/dist/main.js`, under the realpath of the nearest existing
 * directory, as `verifyInstall` will find it.
 */
export function plannedMain(env: Record<string, string | undefined>): string {
  const prefix = managedPrefixFor(env);
  let dir = prefix;
  const rest: string[] = [];
  while (realpathOf(dir) === undefined && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  const base = realpathOf(dir) ?? dir;
  return path.join(base, ...rest, 'lib', 'node_modules', 'oortmem', 'dist', 'main.js');
}

export type ManagedInstall =
  | { ok: true; managed: Managed; command: string; attempts: number }
  | {
      ok: false;
      /** `no-npm`: none on PATH; `unsupported`: Windows; `failed`, `unverified`: npm ran. */
      reason: 'no-npm' | 'unsupported' | 'failed' | 'unverified';
      command: string;
      /** One clause for people: why it did not happen. */
      detail: string;
      attempts?: number;
    };

/** Whether `installManaged` can run here: npm on PATH (absolute entries only), not Windows. */
export function canInstallManaged(ctx: Ctx): 'yes' | 'no-npm' | 'unsupported' {
  const deps = { ...defaultUpdateDeps(ctx), ...ctx.updateDeps };
  if (deps.platform === 'win32') return 'unsupported';
  return onPath('npm', ctx.io.env)[0] === undefined ? 'no-npm' : 'yes';
}

/**
 * Installs oortmem `target` (this version) into the managed copy, exactly as `oort update` does:
 * the first `npm` on PATH by its absolute path, no shell, from the home directory, the prefix
 * named, ETARGET waited out, and the result checked (`verifyInstall`). Its output goes to stderr.
 * `OORT_HOME` is created owner-only first, so npm never creates it world-readable.
 */
export async function installManaged(ctx: Ctx, target = VERSION): Promise<ManagedInstall> {
  const deps = { ...defaultUpdateDeps(ctx), ...ctx.updateDeps };
  const env = ctx.io.env;
  const command = installCommandFor(env, target);
  if (deps.platform === 'win32') {
    return {
      ok: false,
      reason: 'unsupported',
      command,
      detail: 'the managed copy is not set up on Windows yet',
    };
  }
  const npm = onPath('npm', env)[0];
  if (npm === undefined) {
    return { ok: false, reason: 'no-npm', command, detail: 'npm is not on PATH' };
  }
  const prefix = managedPrefixFor(env);
  ensurePrivateDir(resolveHome(env));
  ctx.io.err(`oort: ${command}\n`);
  const r = await runInstaller(
    ctx,
    deps,
    {
      path: path.join(prefix, 'bin', 'oort'),
      prefix,
      argv: [npm, npmArgs(prefix, target)],
      command,
    },
    target,
    env['HOME'] || os.homedir(),
  );
  const managed = r.ok ? managedCopy(env) : undefined;
  if (managed !== undefined) return { ok: true, managed, command, attempts: r.attempts };
  return r.ok || r.unverified === true
    ? {
        ok: false,
        reason: 'unverified',
        command,
        detail: `npm finished, but ${shownPrefix(env)} does not hold oortmem ${target}`,
        attempts: r.attempts,
      }
    : {
        ok: false,
        reason: 'failed',
        command,
        detail: `npm failed${r.attempts > 1 ? ` after ${r.attempts} tries` : ''}`,
        attempts: r.attempts,
      };
}

/**
 * Why the running copy is no place to point agents at (`unstableCopy`: a package cache, a temp
 * directory, fnm's per-shell link, a Node version manager), or undefined when it is one.
 */
export function runningUnstable(ctx: Ctx): string | undefined {
  const entry = ctx.io.entry;
  const real = realpathOf(entry) ?? realpathOf(ctx.binPath ?? binPath());
  return unstableCopy(entry, real);
}

/** The binary agents are pointed at, and where it came from. */
export interface AgentBinary {
  path: string;
  from: 'managed' | 'running';
  version: string;
  /** The managed copy was installed by this run. */
  installed?: boolean;
  /** A managed copy older than this one, left as it is (`oort update` updates it). */
  olderManaged?: Managed;
}

/**
 * The binary `oort install` and `oort connect` write (CON-114): the managed copy when it checks
 * out and is this version or newer; else this copy, when it is stable (`hookCommandPath`'s rules,
 * and never a package cache, temp directory, fnm link or version manager). When this copy is not
 * stable, the managed copy is installed first (`say` prints the line); if it cannot be, a refusal
 * names the commands to run. `dryRun` installs nothing: it returns where the managed copy would be.
 */
export async function agentBinary(
  ctx: Ctx,
  opts: { say: (line: string) => void; dryRun?: boolean; action: string },
): Promise<AgentBinary> {
  const env = ctx.io.env;
  const managed = managedCopy(env);
  if (managedIsCurrent(managed)) {
    return { path: managed.main, from: 'managed', version: managed.version };
  }
  const why = runningUnstable(ctx);
  if (why === undefined) {
    const running = hookCommandPath(ctx.io.entry);
    return {
      path: running,
      from: 'running',
      version: VERSION,
      ...(managed !== undefined && { olderManaged: managed }),
    };
  }
  const prefix = shownPrefix(env);
  const manual = `\`${manualInstall(env)}\`, then \`${prefix}/bin/oort ${opts.action}\``;
  if (opts.dryRun === true) {
    opts.say(
      `This oort is in ${why}, so agents would lose it later: \`oort ${opts.action}\` installs oort ${VERSION} in ${prefix} first (${installCommandFor(env)}).\n`,
    );
    return { path: plannedMain(env), from: 'managed', version: VERSION };
  }
  opts.say(
    `This oort is in ${why}, so agents would lose it later: installing oort ${VERSION} in ${prefix} first (${installCommandFor(env)}).\n`,
  );
  const r = await installManaged(ctx);
  if (!r.ok) {
    throw new Refusal(
      `This oort is in ${why}, which agents would lose later, and the managed copy could not be installed (${r.detail}). Run ${manual}.`,
      { code: 'refused' },
    );
  }
  return { path: r.managed.main, from: 'managed', version: r.managed.version, installed: true };
}
