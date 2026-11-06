import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VERSION, ensurePrivateDir, resolveHome } from '@oortmem/core';
import { binPath } from '../io.js';
import { isNewerVersion } from '../serve-protocol.js';
import {
  inside,
  tempDirs,
  trustedPath,
  trustedTree,
  untrustedText,
  type Untrusted,
} from '../trust.js';
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
 * asdf, mise, nodenv, nvs) moves when Node changes, fnm's `fnm_multishells` links last one shell,
 * and npx's copy is a cache. `oort setup` installs it, `oort install` and `oort connect` point
 * agents at it (and install it first when the running copy is one of those), and `oort update`
 * keeps it current. Agents run it every prompt, so it is used only when nobody else can change it
 * (`trustedPath`, strict: owner-only all the way down from `OORT_HOME`).
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

const userHome = (env: Record<string, string | undefined>): string => env['HOME'] || os.homedir();

/** What there is at `<OORT_HOME>/cli`. */
export type ManagedState =
  | { state: 'ok'; managed: Managed }
  /**
   * No copy that checks out (none, or a broken one an install repairs). `unsafeHome`: oort will
   * not install one here, because `OORT_HOME` is not safe to hold it.
   */
  | { state: 'absent'; unsafeHome?: Untrusted }
  /** A copy is there, but someone else could change it, or it is somewhere the system clears. */
  | { state: 'untrusted'; problem: Untrusted };

const exists = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * The managed copy, and whether it is safe to run (PR #78 review, I1). `OORT_HOME` must be a
 * directory (not a link to nothing), and it, the prefix and every step down to `main.js` must be
 * this user's with no group or other write (`trustedPath`, strict). A copy in a temporary
 * directory, or one `unstableCopy` rejects, does not count. The layout must check out:
 * `<prefix>/bin/oort` resolves to the oortmem package in that prefix (`verifyInstall`), whose
 * `package.json` names a version, and the script is executable. Reads files; never runs it.
 */
export function inspectManaged(env: Record<string, string | undefined>): ManagedState {
  const home = userHome(env);
  const oortHome = resolveHome(env);
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(oortHome);
  } catch {
    // No OORT_HOME yet: an install would create it inside the nearest directory that exists, so
    // that one is held to the same rules.
    let anchor = path.dirname(oortHome);
    while (!exists(anchor) && path.dirname(anchor) !== anchor) anchor = path.dirname(anchor);
    const unsafe =
      trustedPath(anchor, { home, strict: true }) ?? temporary(anchor, env, 'OORT_HOME');
    return unsafe === undefined ? { state: 'absent' } : { state: 'absent', unsafeHome: unsafe };
  }
  if (lst.isSymbolicLink() && realpathOf(oortHome) === undefined) {
    return {
      state: 'absent',
      unsafeHome: {
        dir: oortHome,
        why: 'is a symlink that leads nowhere',
        fix: `rm ${sh(oortHome)}, or create the directory it points to`,
      },
    };
  }
  const prefix = managedPrefixFor(env);
  const hasPrefix = exists(prefix);
  // A copy that is there but not safe is never repaired in place: chmod or chown on it would
  // adopt whatever someone else put in it. Remove it and install it again (PR #78 review, N1).
  const again = `rm -r ${sh(prefix)} && oort setup`;
  const remove = (u: Untrusted): ManagedState => ({
    state: 'untrusted',
    problem: { ...u, fix: again, command: again },
  });
  const homeProblem =
    trustedPath(oortHome, { home, strict: true }) ?? temporary(oortHome, env, 'OORT_HOME');
  if (homeProblem !== undefined) {
    if (!hasPrefix) return { state: 'absent', unsafeHome: homeProblem };
    // OORT_HOME itself is yours and only too open: tighten it after the copy is gone. Anything
    // else (someone else's, a temp directory): a home of your own first.
    const fix = homeProblem.command?.startsWith('chmod ')
      ? `rm -r ${sh(prefix)} && ${homeProblem.command} && oort setup`
      : undefined;
    return {
      state: 'untrusted',
      problem:
        fix === undefined
          ? {
              dir: homeProblem.dir,
              why: homeProblem.why,
              fix: `${homeProblem.fix}, then oort setup`,
            }
          : { dir: homeProblem.dir, why: homeProblem.why, fix, command: fix },
    };
  }
  if (!hasPrefix) return { state: 'absent' };
  const prefixProblem =
    trustedPath(prefix, { home, strict: true }) ?? temporary(prefix, env, 'the managed copy');
  if (prefixProblem !== undefined) return remove(prefixProblem);
  // main.js loads the rest of the package and its dependencies, and Node looks in the prefix's
  // other node_modules for what is missing: all of it is walked, links and all, before the copy
  // is used, or installed into (an install leaves what else is there).
  const treeProblem = trustedTree(prefix);
  if (treeProblem !== undefined) return remove(treeProblem);
  const bin = path.join(prefix, 'bin', 'oort');
  const version = packageVersion(realpathOf(bin));
  if (version === undefined) return { state: 'absent' };
  const v = verifyInstall({ path: bin, prefix }, version);
  if (!v.ok || v.realpath === undefined) return { state: 'absent' };
  const mainProblem = trustedPath(v.realpath, { home, strict: true });
  if (mainProblem !== undefined) return remove(mainProblem);
  const why = unstableCopy(bin, v.realpath, tempDirs(env));
  if (why !== undefined) return remove({ dir: v.realpath, why: `is in ${why}`, fix: again });
  if (!isExecutable(v.realpath)) return { state: 'absent' };
  return { state: 'ok', managed: { prefix, bin, main: v.realpath, version } };
}

/** `dir`'s realpath is in a temporary directory: not a place for the managed copy. */
function temporary(
  dir: string,
  env: Record<string, string | undefined>,
  what: string,
): Untrusted | undefined {
  const real = realpathOf(dir) ?? dir;
  if (!inside(real, tempDirs(env))) return undefined;
  return {
    dir: real,
    why: 'is in a temporary directory, which the system clears',
    fix:
      what === 'OORT_HOME'
        ? 'set OORT_HOME to a directory of your own (the default is ~/.oort)'
        : `rm -r ${sh(dir)}, then oort setup`,
  };
}

/** The managed copy, when it checks out and is safe to run (`inspectManaged`). */
export function managedCopy(env: Record<string, string | undefined>): Managed | undefined {
  const s = inspectManaged(env);
  return s.state === 'ok' ? s.managed : undefined;
}

/** The refusal for a managed copy that is not safe to run: the directory, why, and the fix. */
export function untrustedManagedMessage(
  problem: Untrusted,
  env: Record<string, string | undefined>,
): string {
  return `The managed copy in ${shownPrefix(env)} is not safe for agents to run: ${shown(untrustedText(problem))}. Oort never repairs a copy like this in place, since what is in it may not be what npm installed.`;
}

/** The refusal for an `OORT_HOME` oort will not install the managed copy into. */
export function unsafeHomeMessage(problem: Untrusted): string {
  return `Oort will not install its managed copy there: ${shown(untrustedText(problem))}.`;
}

/** The managed copy is this version or newer: setup and install use it as it is. */
export const managedIsCurrent = (m: Managed | undefined): m is Managed =>
  m !== undefined && !isNewerVersion(VERSION, m.version);

/**
 * A path for a printed command: `~/…` when that needs no quotes (the shell expands it), else the
 * absolute path, quoted (`~` inside quotes is not expanded; PR #78 review, M1).
 */
export function shellPath(p: string, home: string): string {
  const t = tilde(p, home);
  return t.startsWith('~') && sh(t) === t ? t : sh(p);
}

/** The prefix as people see it: `~/.oort/cli`, one shell word. */
export function shownPrefix(env: Record<string, string | undefined>): string {
  return shown(shellPath(managedPrefixFor(env), userHome(env)));
}

/** The command that installs the managed copy by hand: `npm i -g --prefix ~/.oort/cli oortmem`. */
export const manualInstall = (env: Record<string, string | undefined>): string =>
  `npm i -g --prefix ${shownPrefix(env)} oortmem`;

/** What `installManaged` runs, for people: `npm i -g --prefix ~/.oort/cli oortmem@X --prefer-online`. */
export function installCommandFor(
  env: Record<string, string | undefined>,
  target = VERSION,
): string {
  const [i, g, flag, , pkg, online] = npmArgs('', target);
  return ['npm', i, g, flag, shownPrefix(env), pkg, online]
    .map((a, n) => (n === 4 ? a : shown(sh(a ?? ''))))
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

/**
 * Whether `installManaged` can run here: not Windows, an `OORT_HOME` that is safe to hold the
 * managed copy, and npm on PATH (absolute entries only). `because` says why not, for people.
 */
export function canInstallManaged(ctx: Ctx):
  | { ok: true }
  | {
      ok: false;
      reason: 'no-npm' | 'unsupported' | 'unsafe-home' | 'untrusted';
      because: string;
    } {
  const deps = { ...defaultUpdateDeps(ctx), ...ctx.updateDeps };
  if (deps.platform === 'win32') {
    return { ok: false, reason: 'unsupported', because: 'it is not set up on Windows yet' };
  }
  const s = inspectManaged(ctx.io.env);
  if (s.state === 'untrusted') {
    return { ok: false, reason: 'untrusted', because: shown(untrustedText(s.problem)) };
  }
  if (s.state === 'absent' && s.unsafeHome !== undefined) {
    return { ok: false, reason: 'unsafe-home', because: shown(untrustedText(s.unsafeHome)) };
  }
  return onPath('npm', ctx.io.env)[0] === undefined
    ? { ok: false, reason: 'no-npm', because: 'npm is not on PATH' }
    : { ok: true };
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
  // Never into a managed copy, or an OORT_HOME, that someone else could change (PR #78, I1, M2).
  const state = inspectManaged(env);
  if (state.state === 'untrusted') {
    throw new Refusal(untrustedManagedMessage(state.problem, env), { code: 'refused' });
  }
  if (state.state === 'absent' && state.unsafeHome !== undefined) {
    throw new Refusal(unsafeHomeMessage(state.unsafeHome), { code: 'refused' });
  }
  try {
    ensurePrivateDir(resolveHome(env));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'error';
    throw new Refusal(
      `Could not create ${shown(resolveHome(env))} for the managed copy (${code}): ${
        code === 'EACCES' || code === 'EPERM'
          ? 'it, or the directory above it, belongs to another user or is read-only'
          : 'check that the path, and any link in it, leads to a directory of yours'
      }. Set OORT_HOME to a directory of your own, or fix its permissions, then run this again.`,
      { code: 'refused' },
    );
  }
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
  // Checked afresh (runInstaller forgot the walk from before npm ran): the whole new tree.
  const after = r.ok ? inspectManaged(env) : undefined;
  if (after?.state === 'ok') {
    return { ok: true, managed: after.managed, command, attempts: r.attempts };
  }
  if (after?.state === 'untrusted') {
    return {
      ok: false,
      reason: 'unverified',
      command,
      detail: `npm finished, but the copy it left is not safe for agents to run: ${shown(untrustedText(after.problem))}`,
      attempts: r.attempts,
    };
  }
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

/** How a running copy that others can write is described (`runningUnstable`). */
const WRITABLE = 'a directory someone else can change';

/**
 * Why the running copy is no place to point agents at, or undefined when it is one: what
 * `unstableCopy` rejects (a package cache, a temp directory, fnm's per-shell link, a Node version
 * manager), or a path whose walk from `/` fails `trustedPath` (a directory writable by others,
 * sticky or not, or owned by another user; PR #78 review, I2).
 */
export function runningUnstable(ctx: Ctx): string | undefined {
  const entry = ctx.io.entry;
  const real = realpathOf(entry) ?? realpathOf(ctx.binPath ?? binPath());
  const why = unstableCopy(entry, real, tempDirs(ctx.io.env));
  if (why !== undefined || real === undefined) return why;
  const u =
    trustedPath(real, { home: userHome(ctx.io.env), strict: false }) ??
    copyTree(real, ctx.io.env, false);
  return u === undefined ? undefined : `${WRITABLE} (${shown(untrustedText(u))})`;
}

/**
 * The package a copy's script belongs to: the nearest directory above it, at most six levels up,
 * whose package.json is oortmem's. Undefined when there is none (nothing more to walk).
 */
export function oortPackageRoot(real: string): string | undefined {
  let dir = path.dirname(real);
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (pkg.name === 'oortmem') return dir;
    } catch {
      // Not here.
    }
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/**
 * The whole package a copy outside the managed one belongs to (`--this-copy`, the fallback,
 * another copy doctor finds), walked as `trustedTree` walks the managed copy, but with the lenient
 * rules (PR #78 review): `main.js` loads all of it. Links out (a pnpm checkout's node_modules)
 * are judged by the path to what they open, not walked into.
 */
export function copyTree(
  real: string,
  env: Record<string, string | undefined>,
  strict: boolean,
): Untrusted | undefined {
  const root = oortPackageRoot(real);
  return root === undefined ? undefined : trustedTree(root, { strict, home: userHome(env) });
}

/** What a copy in `why` risks, for the sentence `This oort is in <why>, <risk>`. */
export const riskOf = (why: string): string =>
  why.startsWith(WRITABLE) ? 'which agents should not run' : 'which agents would lose later';

/**
 * Agents are about to be pointed at `p` (any config write: hooks, MCP entries): refuses unless it
 * is the managed copy that checks out and is safe (`inspectManaged`), or a copy outside it that
 * stays put and that nobody else can change (`unstableCopy` with every temp directory, and
 * `trustedPath`, strict inside `OORT_HOME`). Run right before every write (PR #78 review, I1).
 */
export function checkAgentPath(p: string, ctx: Ctx): void {
  const env = ctx.io.env;
  const s = inspectManaged(env);
  if (s.state === 'ok' && s.managed.main === p) return;
  const real = realpathOf(p);
  const refuse = (why: string): never => {
    throw new Refusal(`Oort will not point agents at ${shown(p)}: ${why}.`, { code: 'refused' });
  };
  if (real === undefined) refuse('it does not exist');
  const why = unstableCopy(p, real, tempDirs(env));
  if (why !== undefined) refuse(`it is in ${why}`);
  const oortHome = realpathOf(resolveHome(env)) ?? resolveHome(env);
  const strict = inside(real as string, [oortHome]);
  if (strict && s.state === 'untrusted') refuse(shown(untrustedText(s.problem)));
  const u =
    trustedPath(real as string, { home: userHome(env), strict }) ??
    copyTree(real as string, env, strict);
  if (u !== undefined) refuse(shown(untrustedText(u)));
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
  /** `--this-copy`: a managed copy there is, passed over for this one. */
  passedOver?: Managed;
}

/**
 * The binary `oort install` and `oort connect` write (CON-114): the managed copy when it checks
 * out, is safe to run and is this version or newer; else this copy, when it stays put and nobody
 * else can change it (`runningUnstable`). When this copy is not one of those, the managed copy is
 * installed first (`say` prints the line); if it cannot be, a refusal names the commands to run.
 * A managed copy that is there but not safe to run is refused outright, with its fix (PR #78, I1).
 * `dryRun` installs nothing: it returns where the managed copy would be. `thisCopy`
 * (`--this-copy`, for developers testing their own build) writes this copy even when a managed
 * copy is there, and installs nothing; an unstable or untrusted copy is still refused.
 */
export async function agentBinary(
  ctx: Ctx,
  opts: { say: (line: string) => void; dryRun?: boolean; action: string; thisCopy?: boolean },
): Promise<AgentBinary> {
  const env = ctx.io.env;
  const thisCopy = opts.thisCopy === true;
  const state = inspectManaged(env);
  if (!thisCopy && state.state === 'untrusted') {
    throw new Refusal(untrustedManagedMessage(state.problem, env), { code: 'refused' });
  }
  const managed = state.state === 'ok' ? state.managed : undefined;
  if (!thisCopy && managedIsCurrent(managed)) {
    return { path: managed.main, from: 'managed', version: managed.version };
  }
  const why = runningUnstable(ctx);
  if (why === undefined) {
    const running = hookCommandPath(ctx.io.entry);
    return {
      path: running,
      from: 'running',
      version: VERSION,
      ...(managed !== undefined &&
        (thisCopy ? { passedOver: managed } : { olderManaged: managed })),
    };
  }
  const prefix = shownPrefix(env);
  const manual = `\`${manualInstall(env)}\`, then \`${prefix}/bin/oort ${opts.action}\``;
  if (thisCopy) throw new Refusal(thisCopyRefusal(why, env, opts.action), { code: 'refused' });
  const lead = `This oort is in ${why}, ${riskOf(why)}`;
  if (opts.dryRun === true) {
    opts.say(
      `${lead}: \`oort ${opts.action}\` installs oort ${VERSION} in ${prefix} first (${installCommandFor(env)}).\n`,
    );
    return { path: plannedMain(env), from: 'managed', version: VERSION };
  }
  opts.say(`${lead}: installing oort ${VERSION} in ${prefix} first (${installCommandFor(env)}).\n`);
  const r = await installManaged(ctx);
  if (!r.ok) {
    throw new Refusal(
      `${lead}, and the managed copy could not be installed (${r.detail}). Run ${manual}.`,
      { code: 'refused' },
    );
  }
  return { path: r.managed.main, from: 'managed', version: r.managed.version, installed: true };
}

/**
 * `--this-copy` from a copy that does not stay put, or that someone else could change: refused,
 * because that path breaks later (or is not safe) whatever is intended. The same sentence for
 * install, connect and setup.
 */
export function thisCopyRefusal(
  why: string,
  env: Record<string, string | undefined>,
  action: string,
): string {
  const prefix = shownPrefix(env);
  return `This oort is in ${why}, ${riskOf(why)}, so --this-copy will not write it. Run \`${manualInstall(env)}\`, then \`${prefix}/bin/oort ${action}\`, or run --this-copy from a copy that stays put (a build of your own, an npm global outside a Node version manager).`;
}
