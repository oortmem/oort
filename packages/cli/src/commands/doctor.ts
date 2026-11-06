import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONSOLIDATE_EVERY_SAVES,
  consolidationDue,
  filterFor,
  hookStatus,
  readConsolidationState,
} from '@oortmem/claude-code';
import {
  ANONYMOUS_AGENT,
  addressOf,
  isAgentId,
  localGrant,
  principalGrant,
  readAgents,
  resolveConfig,
  resolveHome,
} from '@oortmem/core';
import {
  listBackups,
  readEmbedderBinding,
  SCHEMA_VERSION,
  sqliteSchemaVersion,
} from '@oortmem/store-sqlite';
import { HOSTS, HOST_LABEL, detectHosts, inspectHost, type HostStatus } from '../connectors.js';
import {
  ROLES,
  ROLE_VENDOR,
  keyLookup,
  routeFor,
  type AdapterRole,
  type KeyOrigin,
} from '../credentials.js';
import { describeProblem, inspectCredentialsFile } from '../credentials-file.js';
import { PROVIDER_ENV } from '../keychain.js';
import { OortCloudError, cloudUrl, createCloudClient, readCloudSettings } from '../cloud.js';
import { galaxyLine } from './galaxy.js';
import { spaceLine } from './whoami.js';
import { LOCAL_INSTALL_HINT, LOCAL_PROVIDER, importLocalModels } from '../local-models.js';
import { RELAY_MODELS, relayUrl } from '../relay.js';
import { emit, jsonMode } from '../output.js';
import { uiFor, type Ui } from '../ui.js';
import {
  Refusal,
  echo,
  fixForRoles,
  shellWord as sh,
  keyRemedy,
  shown,
  tilde,
  withWired,
  type Ctx,
} from '../util.js';
import { hostContext } from './connect.js';
import { VERSION } from '@oortmem/core';
import { hookBinaryOf, hookCommandPath, settingsFile, unstableCopy } from './install.js';

export { unstableCopy };
import { binPath } from '../io.js';
import { compareVersions } from '../serve-protocol.js';
import { availableUpdate, noticeText, readUpdateCache, updateCheckOff } from '../update-check.js';
import { managedPrefixFor } from './update.js';
import { managedCopy, managedIsCurrent, manualInstall } from './managed.js';
import { SKIP_FILE, callDaemon, clearSkip, readSkip } from '../serve-client.js';
import { socketPathFor } from '../serve-protocol.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info' | 'unknown';

export interface Check {
  group: 'keys' | 'hooks' | 'serve' | 'mcp' | 'store' | 'relay' | 'cloud' | 'updates';
  name: string;
  status: CheckStatus;
  /** One line; never a key or a memory. */
  detail: string;
  /** One command or sentence that fixes a `warn` or `fail`. */
  fix?: string;
  /**
   * The command in `fix`, runnable as it is, when the fix is one (`--json` only): set where the
   * sentence wraps it, else `fix` itself when it is a bare command (`commandIn`).
   */
  fixCommand?: string;
}

const RUNNABLE =
  /^(oort( [a-z0-9][a-z0-9.-]*| --?[a-z][a-z-]*)+|npm i -g [a-z0-9@/.-]+|chmod [0-7]{3} [^\s;&|`$]+)$/;

/** `fix` when it is one runnable command (or `a && b` of them), else undefined. */
export function commandIn(fix: string | undefined): string | undefined {
  if (fix === undefined) return undefined;
  return fix.split(' && ').every((part) => RUNNABLE.test(part)) ? fix : undefined;
}

/**
 * Doctor's exit code: 1 when a check failed, else 0. Warnings alone exit 0: a keyless or
 * local-only install is a supported state, so `oort doctor && …` keeps working; `--json`'s
 * `data.status` (ok, warn, fail) tells them apart.
 */
export function doctorExit(checks: readonly Check[]): 0 | 1 {
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}

/** The overall state `--json` reports: `fail` when a check failed, `warn` for warnings only. */
export function doctorStatus(checks: readonly Check[]): 'ok' | 'warn' | 'fail' {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  return checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
}

const ROLE_NEED: Record<AdapterRole, string> = {
  embed: 'recall is lexical-only',
  rerank: 'recall is not reranked',
  decide: 'nothing new is saved',
  write: 'nothing new is saved',
};

const CONFIG_KEY: Record<AdapterRole, 'embed' | 'rerank' | 'decide' | 'writer'> = {
  embed: 'embed',
  rerank: 'rerank',
  decide: 'decide',
  write: 'writer',
};

/**
 * A role served by a local model: the package, the downloaded files, and one real load and
 * inference (no network; the model was verified when it was pulled).
 */
async function localModelCheck(
  role: 'embed' | 'rerank',
  config: ReturnType<typeof resolveConfig>,
): Promise<Check> {
  const model = config[role].model;
  const lm = await importLocalModels();
  if (lm instanceof Error) {
    return {
      group: 'keys',
      name: role,
      status: 'warn',
      detail: lm.message,
      fix: LOCAL_INSTALL_HINT,
    };
  }
  try {
    const t0 = performance.now();
    if (role === 'embed') {
      const e = lm.localEmbedder({ home: config.home, model, dimension: config.embed.dimension });
      await e.embed(['oort doctor'], 'query');
    } else {
      const r = lm.localReranker({ home: config.home, model });
      await r.rerank('oort doctor', [{ id: 'd', text: 'oort doctor check' }], 1);
    }
    const ms = Math.round(performance.now() - t0);
    return {
      group: 'keys',
      name: role,
      status: 'ok',
      detail: `local model ${model} on this CPU, no key (loads and runs in ${ms} ms)`,
    };
  } catch (e) {
    const fix =
      e instanceof lm.LocalModelError && e.kind === 'not-ready'
        ? `oort models pull ${model}`
        : 'oort models list';
    return {
      group: 'keys',
      name: role,
      status: e instanceof lm.LocalModelError && e.kind === 'not-ready' ? 'warn' : 'fail',
      detail:
        e instanceof lm.LocalModelError
          ? e.message
          : `local model ${model} failed to run (${(e as Error).name})`,
      fix,
    };
  }
}

/** Keys: which one serves each role (presence only), and whether the relay can serve it. */
async function keyChecks(ctx: Ctx): Promise<{ checks: Check[]; relayed: boolean }> {
  const env = ctx.io.env;
  const lookup = keyLookup(env, ctx.keychain.read);
  let config: ReturnType<typeof resolveConfig> | undefined;
  try {
    config = resolveConfig(ctx.io.cwd, env);
  } catch {
    config = undefined; // the store check reports an invalid config
  }
  const checks: Check[] = [];
  let relayed = false;
  for (const role of ROLES) {
    if ((role === 'embed' || role === 'rerank') && config?.[role].provider === LOCAL_PROVIDER) {
      checks.push(await localModelCheck(role, config));
      continue;
    }
    const r = await routeFor(role, lookup);
    const where = (source: KeyOrigin, provider: string): string =>
      source === 'explicit'
        ? 'given in code'
        : source === 'env'
          ? PROVIDER_ENV[provider as keyof typeof PROVIDER_ENV]
          : ctx.keychain.where(provider as keyof typeof PROVIDER_ENV);
    if (r.via === 'vendor') {
      checks.push({
        group: 'keys',
        name: role,
        status: 'ok',
        detail: `own ${r.provider} key (${where(r.source, r.provider)})`,
      });
      continue;
    }
    if (r.via === 'none') {
      checks.push({
        group: 'keys',
        name: role,
        status: 'warn',
        detail: `no ${r.provider} key and no Oort key, so ${ROLE_NEED[role]}`,
        // The shared remedy: local models first (embed and rerank), never `export KEY=...`.
        fix: keyRemedy({ roles: [role], keyStore: ctx.keychain.supported, code: false }),
        ...withCommand(fixForRoles([role], ctx.keychain.supported)),
      });
      continue;
    }
    relayed = true;
    const allowed = (RELAY_MODELS as Partial<Record<AdapterRole, readonly string[]>>)[role];
    const model = config?.[CONFIG_KEY[role]] as { model?: string } | undefined;
    if (allowed !== undefined && model?.model !== undefined && !allowed.includes(model.model)) {
      checks.push({
        group: 'keys',
        name: role,
        status: 'fail',
        detail: `${CONFIG_KEY[role]}.model ${echo(model.model)} is not served by Oort Pro (it serves ${allowed.join(', ')})`,
        fix: `use ${allowed[0]} in ~/.oort/config.json, or set ${PROVIDER_ENV[ROLE_VENDOR[role]]}`,
      });
      continue;
    }
    checks.push({
      group: 'keys',
      name: role,
      status: 'ok',
      detail: `Oort Pro (${where(r.source, 'oort')}), through the relay`,
    });
  }
  if (ctx.keychain.kind === 'file') {
    const file = ctx.keychain.where('oort');
    const state = inspectCredentialsFile(file);
    const problem = describeProblem(file, state);
    if (problem !== undefined) {
      checks.push({
        group: 'keys',
        name: 'credentials',
        status: 'fail',
        detail: problem.split(' Fix:')[0] ?? problem,
        fix: state.state === 'wide' ? `chmod 600 ${file}` : `fix or delete ${file}`,
      });
    }
  }
  return { checks, relayed };
}

/**
 * The fix that (re)points the hooks: `oort install claude-code` run from this copy, unless this
 * copy is temporary or under a version manager (CON-113), when it would write a path that breaks
 * later; then it names the managed copy (`~/.oort/cli`), installing it first when it is missing.
 */
function hookFix(ctx: Ctx, running: string | undefined): { fix: string; fixCommand: string } {
  const why = unstableCopy(ctx.io.entry, running);
  if (why === undefined) return { fix: HOOK_FIX, fixCommand: HOOK_FIX };
  const home = ctx.io.env['HOME'] ?? '';
  const prefix = managedPrefixFor(ctx.io.env);
  const bin = path.join(prefix, 'bin', 'oort');
  // fixCommand runs as printed: every path one shell word (a HOME with a space or a `$`).
  const run = `${sh(bin)} install claude-code`;
  const show = `${shown(sh(tilde(bin, home)))} install claude-code`;
  if (isExecutable(bin)) {
    return { fix: `${show} (this oort is in ${why})`, fixCommand: run };
  }
  return {
    fix: `npm i -g --prefix ${shown(sh(tilde(prefix, home)))} oortmem && ${show} (this oort is in ${why})`,
    fixCommand: `npm i -g --prefix ${sh(prefix)} oortmem && ${run}`,
  };
}

/** The Claude Code hooks in the user settings file. */
async function hookChecks(ctx: Ctx, cmd: string | undefined, home: string): Promise<Check[]> {
  const fixHooks = hookFix(ctx, cmd);
  const file = settingsFile(false, ctx);
  const show = tilde(file, home);
  if (!fs.existsSync(path.join(home, '.claude'))) {
    return [
      {
        group: 'hooks',
        name: 'claude-code',
        status: 'info',
        detail: 'Claude Code not found (~/.claude)',
      },
    ];
  }
  let status: ReturnType<typeof hookStatus>;
  try {
    status = hookStatus(file, cmd);
  } catch (e) {
    return [
      {
        group: 'hooks',
        name: 'claude-code',
        status: 'fail',
        detail: (e as Error).message.split('\n')[0] ?? 'unreadable settings',
        fix: `fix the JSON in ${show}, then ${fixHooks.fix}`,
        fixCommand: fixHooks.fixCommand,
      },
    ];
  }
  const found = status.events.filter((e) => e.state !== 'missing');
  if (found.length === 0) {
    return [
      {
        group: 'hooks',
        name: 'claude-code',
        status: 'info',
        detail: `not installed in ${show}`,
        ...fixHooks,
      },
    ];
  }
  const binaries = await hookBinaryChecks(ctx, found, cmd, fixHooks);
  const broken = found.filter(
    (e) => e.command !== undefined && !isExecutable(e.command) && e.command !== 'oort',
  );
  const missing = status.events.filter((e) => e.state === 'missing').map((e) => e.event);
  const stale = found.filter((e) => e.state === 'stale');
  if (broken.length > 0) {
    return [
      {
        group: 'hooks',
        name: 'claude-code',
        status: 'fail',
        detail: `${broken.map((e) => e.event).join(', ')} run ${broken[0]?.command ?? ''}, which is not an executable file`,
        ...fixHooks,
      },
      ...binaries,
    ];
  }
  // A version mismatch says more than "another path"; one warning for one cause.
  const versionWarned = binaries.some((c) => c.name === 'claude-code bin' && c.status === 'warn');
  // Another executable copy of this same version (the managed ~/.oort/cli, say, while this one is
  // a PATH copy): the hooks are fine as they are (CON-113). Repointing them at this copy could
  // write a path that breaks later (fnm's per-shell link, a package cache).
  const sameVersion =
    stale.length > 0 &&
    !versionWarned &&
    binaries.some((c) => c.name === 'claude-code bin' && c.status === 'ok');
  if (missing.length === 0 && sameVersion) {
    const hooksBin = hookBinaryOf(`${stale[0]?.command ?? ''} hook ${stale[0]?.event ?? ''}`);
    const here = ctx.io.entry ?? cmd ?? '';
    return [
      {
        group: 'hooks',
        name: 'claude-code',
        status: 'ok',
        detail: `${found.map((e) => e.event).join(', ')} in ${show}`,
      },
      {
        group: 'hooks',
        name: 'claude-code copy',
        status: 'info',
        detail: `the hooks run ${shown(tilde(hooksBin ?? '', home))}; this is another copy of oort ${VERSION} at ${shown(tilde(here, home))}`,
      },
      ...binaries,
    ];
  }
  if (missing.length > 0 || (stale.length > 0 && !versionWarned)) {
    return [
      {
        group: 'hooks',
        name: 'claude-code',
        status: 'warn',
        detail:
          missing.length > 0
            ? `${missing.join(', ')} missing in ${show}`
            : `installed from another path (${stale[0]?.command ?? ''})`,
        ...fixHooks,
      },
      ...binaries,
    ];
  }
  return [
    {
      group: 'hooks',
      name: 'claude-code',
      status: 'ok',
      detail: `${found.map((e) => e.event).join(', ')} in ${show}`,
    },
    ...binaries,
  ];
}

const HOOK_FIX = 'oort install claude-code';
const VERSION_PROBE_MS = 3000;

/** `<bin> --version` through execFile (no shell), with a short timeout; undefined if it fails. */
function probeVersion(
  bin: string,
  env: NodeJS.ProcessEnv,
  viaNode: boolean,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const [file, args] = viaNode ? ['node', [bin, '--version']] : [bin, ['--version']];
    execFile(
      file as string,
      args as string[],
      { timeout: VERSION_PROBE_MS, env, encoding: 'utf8', windowsHide: true },
      (err, stdout) => {
        const v = /\d+\.\d+\.\d+[^\s]*/.exec(String(stdout))?.[0];
        resolve(err === null ? (v ?? '') : undefined);
      },
    );
  });
}

/**
 * Does each hook's binary exist, and is it the oort that is running? A binary that is missing
 * is already a failure on the `claude-code` row, so only the version-manager note is added
 * for it; the file is never run unless it exists.
 */
async function hookBinaryChecks(
  ctx: Ctx,
  found: readonly { event: string; command?: string }[],
  cmd: string | undefined,
  fixHooks: { fix: string; fixCommand: string },
): Promise<Check[]> {
  // Another version: `oort update` brings every copy (the hooks' included) to the latest; or
  // point the hooks at the copy you want.
  const reinstall =
    fixHooks.fix === HOOK_FIX
      ? `oort update, or ${HOOK_FIX} from the oort you want the hooks to use`
      : `oort update, or ${fixHooks.fix}`;
  const seen = new Set<string>();
  const checks: Check[] = [];
  const home = ctx.io.env['HOME'] ?? '';
  for (const e of found) {
    const raw = e.command ?? cmd;
    if (raw === undefined || raw === 'oort') continue;
    const viaNode = raw.startsWith('node ');
    const bin = hookBinaryOf(`${raw} hook ${e.event}`);
    if (bin === undefined || seen.has(bin)) continue;
    seen.add(bin);
    const show = tilde(bin, home);
    const note = unstableHooksNote(ctx, bin, show);
    if (note !== undefined) checks.push(note);
    if (!isExecutable(bin)) continue; // never run a path that is not there
    const got = await probeVersion(bin, { ...process.env, ...ctx.io.env }, viaNode);
    if (got === undefined || got === '') {
      checks.push({
        group: 'hooks',
        name: 'claude-code bin',
        status: 'warn',
        detail: `${show} did not report a version for --version`,
        fix: reinstall,
        fixCommand: 'oort update',
      });
    } else if (got !== VERSION) {
      checks.push({
        group: 'hooks',
        name: 'claude-code bin',
        status: 'warn',
        detail: `the hooks run oort ${got} (${show}), but this is oort ${VERSION}`,
        fix: reinstall,
        fixCommand: 'oort update',
      });
    } else {
      checks.push({
        group: 'hooks',
        name: 'claude-code bin',
        status: 'ok',
        detail: `oort ${got}, the version you are running (${show})`,
      });
    }
  }
  return checks;
}

const UNSTABLE_HOOKS: Record<string, string> = {
  'a Node version manager': 'under a Node version manager: switching Node versions will break them',
  "fnm's link for this shell": "in fnm's link for one shell: it goes away when that shell ends",
  'a package cache':
    'in a package cache, which can be cleared, or hold another version, at any time',
};

/**
 * An info row when the hooks run a copy that will not stay put (CON-114): a Node version manager,
 * fnm's per-shell link or a package cache. The fix is the managed copy (`~/.oort/cli`): pointing
 * the hooks at it when it is there, else `oort setup` or installing it by hand first. A temp
 * directory is left out: no `oort install` ever writes one (`hookCommandPath` refuses it).
 */
function unstableHooksNote(ctx: Ctx, bin: string, show: string): Check | undefined {
  let real: string | undefined;
  try {
    real = fs.realpathSync(bin);
  } catch {
    real = undefined;
  }
  const why = unstableCopy(bin, real);
  const detail = why === undefined ? undefined : UNSTABLE_HOOKS[why];
  if (detail === undefined) return undefined;
  const home = ctx.io.env['HOME'] ?? '';
  const prefix = managedPrefixFor(ctx.io.env);
  const managedBin = path.join(prefix, 'bin', 'oort');
  const run = `${sh(managedBin)} install claude-code`;
  const base = {
    group: 'hooks' as const,
    name: 'claude-code node',
    status: 'info' as const,
    detail: `the hooks run ${shown(show)}, ${detail}`,
  };
  if (managedCopy(ctx.io.env) !== undefined) {
    return {
      ...base,
      fix: `${shown(sh(tilde(managedBin, home)))} install claude-code (the managed copy, which stays put)`,
      fixCommand: run,
    };
  }
  return {
    ...base,
    fix: `oort setup, or ${manualInstall(ctx.io.env)} and then oort install claude-code (a managed copy that stays put)`,
    fixCommand: `npm i -g --prefix ${sh(prefix)} oortmem && ${run}`,
  };
}

/** The managed copy, when it checks out and is this version or newer. */
function currentManaged(ctx: Ctx): ReturnType<typeof managedCopy> {
  const m = managedCopy(ctx.io.env);
  return managedIsCurrent(m) ? m : undefined;
}

/**
 * `oort serve`: running or not, its pid, version and socket, and a warning when it is another
 * oort than this one (the hooks then run in-process until it restarts). Reads only; a stale
 * socket is reported, never removed.
 */
async function serveChecks(ctx: Ctx): Promise<Check[]> {
  const home = resolveHome(ctx.io.env);
  const socket = socketPathFor(home, ctx.io.env);
  const show = shown(tilde(socket, ctx.io.env['HOME'] ?? ''));
  const base = { group: 'serve' as const, name: 'daemon' };
  const skip = readSkip(home);
  // A refusal for a pending migration needs no row: the store check below migrates the store and
  // reopens the daemon to the hooks.
  const skipping: Check[] =
    skip !== undefined && skip.until > Date.now() && skip.reason !== 'migration'
      ? [
          {
            group: 'serve',
            name: 'hooks',
            status: 'warn',
            detail: `skip the daemon until ${new Date(skip.until).toISOString()}, after ${skip.reason === 'refused' ? 'a refusal (another protocol or version, an answer that is not a hook result, or a daemon that would not start)' : 'a hook timed out on it'}; they run in-process (${SKIP_FILE})`,
            fix: 'oort serve status (tries it again), or oort serve stop && oort serve --detach',
            fixCommand: 'oort serve status',
          },
        ]
      : [];
  return [...(await daemonChecks()), ...skipping];

  async function daemonChecks(): Promise<Check[]> {
    const r = await callDaemon(socket, 'ping', {}, { budgetMs: 1000 });
    if (r.ok) {
      const version = shown(r.result['version']);
      const pid = shown(r.result['pid']);
      if (r.result['version'] !== VERSION) {
        return [
          {
            ...base,
            status: 'warn',
            detail: `running oort ${version} (pid ${pid}, ${show}), but this is oort ${VERSION}: hooks run in-process until it restarts`,
            fix: 'oort serve stop && oort serve --detach',
          },
        ];
      }
      return [{ ...base, status: 'ok', detail: `running, pid ${pid}, oort ${version}, ${show}` }];
    }
    switch (r.reason) {
      case 'absent':
        return [
          {
            ...base,
            status: 'info',
            detail: 'not running; hooks run in-process',
            fix: 'oort serve --detach',
          },
        ];
      case 'refused':
        return [
          {
            ...base,
            status: 'info',
            detail: `not running; a stopped daemon left ${show} behind (the next start replaces it)`,
            fix: 'oort serve --detach',
          },
        ];
      case 'untrusted':
        return [
          {
            ...base,
            status: 'warn',
            detail: `${show} or its directory belongs to another user or is writable by others: hooks never use it`,
            fix: `remove ${show} and run chmod 700 on its directory`,
          },
        ];
      default:
        return [
          {
            ...base,
            status: 'warn',
            detail: `${show} does not answer (${r.reason}): hooks fall back to in-process`,
            fix: 'oort serve stop && oort serve --detach',
          },
        ];
    }
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The MCP entry in every host's config. */
function mcpChecks(ctx: Ctx, cmd: string | undefined): Check[] {
  const hc = hostContext(ctx);
  const detected = new Set(detectHosts(hc));
  return HOSTS.map((host): Check => {
    const s: HostStatus = inspectHost(host, hc, cmd);
    const show = tilde(s.file, hc.home);
    const base = { group: 'mcp' as const, name: host };
    switch (s.state) {
      case 'connected':
        return { ...base, status: 'ok', detail: `${HOST_LABEL[host]} starts oort mcp (${show})` };
      case 'outdated':
        return {
          ...base,
          status: 'warn',
          detail:
            s.noAgent === true
              ? `Oort's entry in ${show} names no agent (from before agents): ${HOST_LABEL[host]} runs as an anonymous agent that reads and writes your Planet only, with no Star`
              : `Oort's entry in ${show} is from another install path or an older version`,
          fix: `oort connect ${host}`,
        };
      case 'broken':
        return {
          ...base,
          status: 'fail',
          detail: `Oort's entry in ${show} runs a command that is not an executable file`,
          fix: `oort connect ${host}`,
        };
      case 'foreign':
        return {
          ...base,
          status: 'info',
          detail: `${show} has an "oort" server Oort did not write; left alone`,
        };
      case 'invalid':
        return {
          ...base,
          status: 'fail',
          detail: (s.message ?? `${show} cannot be read`).replace(s.file, show),
          fix: `fix ${show} by hand (Oort will not edit it until it parses)`,
        };
      case 'absent':
        return detected.has(host)
          ? {
              ...base,
              status: 'info',
              detail:
                host === 'claude-code'
                  ? 'MCP server not added (the hooks work without it)'
                  : `${HOST_LABEL[host]} found, not connected`,
              fix: `oort connect ${host}`,
            }
          : { ...base, status: 'info', detail: `${HOST_LABEL[host]} not found` };
    }
  });
}

/** The local store: present, private, and readable. It is never created here. */
async function storeChecks(ctx: Ctx): Promise<Check[]> {
  const home = resolveHome(ctx.io.env);
  const userHome = ctx.io.env['HOME'] ?? '';
  const show = tilde(home, userHome);
  const db = path.join(home, 'oort.sqlite');
  if (!fs.existsSync(db)) {
    return [
      {
        group: 'store',
        name: 'store',
        status: 'info',
        detail: `no store yet in ${show}; the first memory (or oort setup) creates it`,
      },
    ];
  }
  const checks: Check[] = [];
  let before: number | undefined;
  try {
    before = sqliteSchemaVersion(db);
  } catch {
    before = undefined; // unreadable: the open below reports it
  }
  try {
    // Opening migrates an older store (after copying it): doctor is where the hooks send you.
    let cloudMode = false;
    const { count, planet, star, agent, stars, embedder } = await withWired(ctx, async (w) => {
      cloudMode = w.mode === 'cloud';
      const all = await w.store.list(localGrant(filterFor(w.scope)), { validOnly: false });
      // Your Planet (shared by your agents) and this agent's own Star, every project (CON-62).
      const { orgId, customerId, agentId } = w.scope;
      const mine = await w.store.list(principalGrant({ orgId, customerId, agentId }), {
        validOnly: false,
        embeddings: false,
      });
      const atStar = mine.filter((m) => addressOf(m).level === 'agent').length;
      const configured = Object.entries(readAgents(w.config.home))
        .filter(([, a]) => a.star)
        .map(([id]) => id);
      return {
        count: all.length,
        planet: mine.length - atStar,
        star: atStar,
        agent: w.agent,
        stars: configured,
        embedder: w.embedder,
      };
    });
    checks.push({
      group: 'store',
      name: 'store',
      status: 'ok',
      detail: `${tilde(db, userHome)} opens; ${count} ${count === 1 ? 'memory' : 'memories'} visible from here`,
    });
    // The store opened at the current schema (migrated now, or earlier by another command): a
    // daemon refused for a pending migration may start, and the hooks may try it again.
    if (readSkip(home)?.reason === 'migration') clearSkip(home);
    if (before !== undefined && before < SCHEMA_VERSION) {
      checks.push({
        group: 'store',
        name: 'migration',
        status: 'ok',
        detail: `migrated the store from schema version ${before} to ${SCHEMA_VERSION}; ${
          before === 1
            ? 'your memories now live in your Planet'
            : before === 2
              ? 'it can now hold judgments (oort judge)'
              : 'lexical search now finds Chinese, Japanese, Korean, Thai and Indic words'
        }${
          before <= 3
            ? '. Then restart any Oort MCP server started before the upgrade (quit and reopen Claude Code, Claude Desktop or Cursor): an older Oort cannot write to the new search index'
            : ''
        }`,
      });
    }
    const bound = readEmbedderBinding(db);
    if (embedder !== undefined && !embedder.matches) {
      checks.push({
        group: 'store',
        name: 'embedder',
        status: 'warn',
        detail: `memories are embedded with ${embedder.bound}, embed is set to ${embedder.active}: dense recall and saving are off`,
        fix: 'oort reembed',
      });
    } else if (embedder !== undefined) {
      checks.push({
        group: 'store',
        name: 'embedder',
        status: 'ok',
        detail: `${embedder.active}; the store's vectors match`,
      });
    } else if (bound.model !== null) {
      checks.push({
        group: 'store',
        name: 'embedder',
        status: 'info',
        detail: `the store's vectors come from ${bound.model}; no embedder is available, so recall is lexical`,
      });
    }
    const n = (k: number) => `${k} ${k === 1 ? 'memory' : 'memories'}`;
    checks.push({
      group: 'store',
      name: 'spaces',
      status: 'info',
      detail:
        agent.source === 'none'
          ? `Planet: ${n(planet)} (every project)`
          : `Planet: ${n(planet)} (every project); Star ${agent.id}: ${n(star)}`,
    });
    const keeping = stars.length > 0 ? `; agents keeping a Star: ${stars.join(', ')}` : '';
    checks.push({
      group: 'store',
      name: 'agent',
      status: 'info',
      detail:
        agent.source === 'none'
          ? `no agent named: reads and writes your Planet only, no Star (name one with --agent or OORT_AGENT)${keeping}`
          : `acting as ${agent.id} (from ${agent.source === 'flag' ? '--agent' : 'OORT_AGENT'}): reads your Planet and its own Star; new memories go to ${agent.home === 'star' ? `Star ${agent.id}` : 'your Planet'}${agent.home === 'star' ? ', and it never changes your Planet' : ''}${keeping}`,
    });
    // Oort Cloud consolidates itself; locally the hook drain does, when due (CON-48).
    if (!cloudMode) checks.push(consolidationCheck(home));
    // The newest copy taken before a migration (the names sort by time within each kind).
    const backup = (['pre-v2', 'pre-v3', 'pre-v4'] as const)
      .map((kind) => listBackups(db, kind).at(-1))
      .filter((f): f is string => f !== undefined)
      .sort((a, b) => {
        const at = (f: string) => f.slice(f.lastIndexOf('.') + 1);
        return at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0;
      })
      .at(-1);
    if (backup !== undefined) {
      checks.push({
        group: 'store',
        name: 'backup',
        status: 'info',
        detail: `the copy taken before the last schema migration is at ${tilde(backup, userHome)}`,
        fix: `delete it once Oort works as before`,
      });
    }
  } catch (e) {
    checks.push({
      group: 'store',
      name: 'store',
      status: 'fail',
      detail: `${tilde(db, userHome)} does not open: ${(e as Error).message.split('\n')[0] ?? ''}`,
      fix: `close other oort processes and run oort stats; if it still fails, move ${show} aside`,
    });
  }
  if (process.platform !== 'win32') {
    const mode = fs.statSync(home).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      checks.push({
        group: 'store',
        name: 'permissions',
        status: 'warn',
        detail: `${show} is mode ${mode.toString(8)}, so other users can read your memories`,
        fix: `chmod 700 ${show}`,
      });
    }
  }
  return checks;
}

/** When the hooks last consolidated the local store, and when they will next. */
export function consolidationCheck(home: string, now = new Date()): Check {
  const s = readConsolidationState(home);
  const due = consolidationDue(s, now);
  const when = (iso: string): string => {
    const h = Math.round((now.getTime() - Date.parse(iso)) / 3_600_000);
    return h < 1
      ? 'less than an hour ago'
      : h < 48
        ? `${h} h ago`
        : `${Math.round(h / 24)} days ago`;
  };
  const next = due.due
    ? due.reason === 'resume'
      ? 'the next drain resumes it'
      : due.reason === 'retry'
        ? 'the next drain retries it'
        : 'due: the next drain (after a Claude Code turn) runs it'
    : `next ${due.nextAt ?? ''}, or after ${CONSOLIDATE_EVERY_SAVES - s.savesSince} more saved turns`;
  if (s.lastRunAt === null) {
    return {
      group: 'store',
      name: 'consolidation',
      status: 'info',
      detail: `never ran from the hooks; ${next}`,
      fix: 'oort consolidate runs it now',
      fixCommand: 'oort consolidate',
    };
  }
  const last =
    s.lastOutcome === 'complete'
      ? `last ran ${when(s.lastRunAt)}`
      : s.lastOutcome === 'partial'
        ? `last run ${when(s.lastRunAt)} stopped at its time budget`
        : `last run ${when(s.lastRunAt)} failed (see ~/.oort/logs/hooks.log)`;
  const counts =
    s.last !== undefined
      ? ` (${s.last.evicted} to cold, ${s.last.expired} expired, ${s.last.promoted + s.last.demoted - s.last.evicted} re-tiered)`
      : '';
  return {
    group: 'store',
    name: 'consolidation',
    status: s.lastOutcome === 'error' ? 'warn' : 'info',
    detail: `${last}${counts}; ${next}`,
    ...(s.lastOutcome === 'error' && { fix: 'oort consolidate' }),
  };
}

const PROBE_TIMEOUT_MS = 3000;

/** GET `<relay>/health` with no credentials; true only for 200 `{"ok":true}`. */
async function probeRelay(url: string, doFetch: typeof fetch): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await doFetch(`${url}/health`, { signal: abort.signal, redirect: 'error' });
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return false;
    }
    const body: unknown = await res.json();
    return (body as { ok?: unknown } | null)?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The relay: its URL, and, when a role goes through it, whether `/health` answers within 3 s. */
async function relayChecks(ctx: Ctx, relayed: boolean): Promise<Check[]> {
  const r = relayUrl(ctx.io.env);
  if ('error' in r) {
    return [
      {
        group: 'relay',
        name: 'relay',
        status: relayed ? 'fail' : 'warn',
        detail: r.error,
        fix: 'unset OORT_RELAY_URL (or set it to an https URL, or http://localhost for wrangler dev)',
      },
    ];
  }
  if (!relayed) {
    return [
      {
        group: 'relay',
        name: 'relay',
        status: 'info',
        detail: `not used: every role has its own key or none (${r.url})`,
      },
    ];
  }
  const up = await probeRelay(r.url, ctx.fetch ?? globalThis.fetch);
  return [
    up
      ? { group: 'relay', name: 'relay', status: 'ok', detail: `${r.url} reachable` }
      : {
          group: 'relay',
          name: 'relay',
          status: 'warn',
          detail: `${r.url} unreachable (no healthy answer from /health within 3 s)`,
          fix: 'check your network and proxy; if it persists, see status at oortcloud.dev, or set your own keys with oort keys set <provider>',
        },
  ];
}

/** Oort Cloud: which store this machine uses, and in cloud mode whether the account answers. */
async function cloudChecks(ctx: Ctx): Promise<Check[]> {
  const settings = readCloudSettings(resolveHome(ctx.io.env));
  const stars = Object.entries(readAgents(resolveHome(ctx.io.env)))
    .filter(([, a]) => a.star)
    .map(([id]) => id);
  const starCheck: Check[] =
    settings.store === 'cloud' && stars.length > 0
      ? [
          {
            group: 'cloud',
            name: 'stars',
            status: 'warn',
            detail: `${stars.join(', ')} ${stars.length === 1 ? 'keeps' : 'keep'} a Star, which Oort Cloud does not have yet: their saves are refused (the hooks save nothing) until this changes`,
            fix: `oort connect ${stars[0]} --no-star, or oort cloud use --local`,
            fixCommand: `oort connect ${stars[0]} --no-star`,
          },
        ]
      : [];
  return [...starCheck, ...(await cloudStoreChecks(ctx, settings))];
}

/** The cloud store's own checks (see `cloudChecks`). */
async function cloudStoreChecks(
  ctx: Ctx,
  settings: ReturnType<typeof readCloudSettings>,
): Promise<Check[]> {
  const u = cloudUrl(ctx.io.env);
  if (settings.store !== 'cloud') {
    return [
      {
        group: 'cloud',
        name: 'store',
        status: 'info',
        detail: 'local store on this machine',
        fix: 'oort cloud use, to keep memories in Oort Cloud (Oort Pro)',
        fixCommand: 'oort cloud use',
      },
    ];
  }
  if ('error' in u) {
    return [
      {
        group: 'cloud',
        name: 'store',
        status: 'fail',
        detail: u.error,
        fix: 'unset OORT_CLOUD_URL (or set it to an https URL, or http://localhost for wrangler dev)',
      },
    ];
  }
  const key = await keyLookup(ctx.io.env, ctx.keychain.read)('oort');
  if (key === undefined) {
    return [
      {
        group: 'cloud',
        name: 'store',
        status: 'fail',
        detail: 'cloud mode is on, but there is no Oort key: hooks inject nothing and saves wait',
        fix: 'oort login (or oort cloud use --local)',
        fixCommand: 'oort login',
      },
    ];
  }
  const client = createCloudClient({
    url: u.url,
    key: key.key,
    timeoutMs: PROBE_TIMEOUT_MS,
    ...(ctx.fetch !== undefined && { fetch: ctx.fetch }),
  });
  // The agent this check runs as (--agent or OORT_AGENT): spaces list what it may reach.
  const named = ctx.agent ?? ctx.io.env['OORT_AGENT'];
  const agent =
    named !== undefined && isAgentId(named) && named !== ANONYMOUS_AGENT ? named : undefined;
  try {
    const me = await client.whoami(agent);
    const spaces = (me.spaces ?? [{ level: 'planet' as const }]).map(spaceLine);
    return [
      {
        group: 'cloud',
        name: 'store',
        status: 'ok',
        detail: `Oort Cloud (${u.url}), account ${shown(me.account)}, plan ${shown(me.plan)}${me.scope === 'narrowed' ? ', narrowed key' : ''}`,
      },
      {
        group: 'cloud',
        name: 'spaces',
        status: 'info',
        detail: `${agent === undefined ? '' : `as ${agent}: `}${spaces.join('; ')}`,
      },
      ...(me.galaxies !== undefined && me.galaxies.length > 0
        ? [
            {
              group: 'cloud' as const,
              name: 'galaxies',
              status: 'info' as const,
              detail: me.galaxies.map(galaxyLine).join('; '),
            },
          ]
        : []),
    ];
  } catch (e) {
    const err = e instanceof OortCloudError ? e : new OortCloudError('network', 0);
    return [
      {
        group: 'cloud',
        name: 'store',
        status: err.kind === 'network' || err.kind === 'busy' ? 'warn' : 'fail',
        detail: err.message,
        fix:
          err.kind === 'network' || err.kind === 'busy'
            ? 'check your network; saves wait in the local queue meanwhile'
            : 'oort login, or oort cloud use --local',
        ...(err.kind !== 'network' && err.kind !== 'busy' && { fixCommand: 'oort login' }),
      },
    ];
  }
}

const GLYPH: Record<CheckStatus, string> = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  info: '•', // the same mark as ui.info
  unknown: '?',
};

function paint(ui: Ui, status: CheckStatus, s: string): string {
  return status === 'ok'
    ? ui.green(s)
    : status === 'warn'
      ? ui.yellow(s)
      : status === 'fail'
        ? ui.red(s)
        : ui.dim(s);
}

const withCommand = (c: string | undefined): { fixCommand?: string } =>
  c === undefined ? {} : { fixCommand: c };

/** `oort doctor [--json]`: every check, with a one-line fix per problem. Exits 1 if one fails. */
export async function doctorCommand(opts: { json?: boolean }, ctx: Ctx): Promise<number> {
  const home = ctx.io.env['HOME'] ?? '';
  let cmd: string | undefined;
  try {
    cmd = hookCommandPath(ctx.io.entry);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    cmd = undefined; // not the installed bin: entries are judged on their own paths
  }
  // The hooks are judged against the copy running, wherever it lives (CON-113): another copy
  // of the same version is fine, and a temporary one is never suggested as their path.
  let running: string | undefined;
  try {
    running = fs.realpathSync(ctx.binPath ?? binPath());
  } catch {
    running = undefined;
  }
  const keys = await keyChecks(ctx);
  const checks: Check[] = [
    ...keys.checks,
    ...(await hookChecks(ctx, cmd ?? running, home)),
    ...(await serveChecks(ctx)),
    // `oort connect` writes the managed copy when it checks out (CON-114): entries are judged
    // against that, else against this bin.
    ...mcpChecks(ctx, currentManaged(ctx)?.main ?? cmd),
    ...(await storeChecks(ctx)),
    ...(await relayChecks(ctx, keys.relayed)),
    ...(await cloudChecks(ctx)),
  ];
  const exit = doctorExit(checks);
  if (jsonMode(ctx)) {
    const problems = checks.filter((c) => c.status === 'warn' || c.status === 'fail').length;
    emit(ctx, {
      status: doctorStatus(checks),
      problems,
      checks: checks.map((c) => ({ ...c, ...withCommand(c.fixCommand ?? commandIn(c.fix)) })),
    });
    return exit;
  }
  const ui = uiFor(ctx.io);
  const problems = checks.filter((c) => c.status === 'warn' || c.status === 'fail').length;
  ctx.io.out(
    ui.header(
      'doctor',
      problems === 0 ? ui.success('no problems') : ui.warning(`${problems} to fix`),
    ),
  );
  // The update notice (CON-114): a line for people, never in --json (`oort update --check
  // --json` is the data). From the cache only: doctor makes no new network call for it.
  const update = updateRow(ctx);
  for (const group of [
    'keys',
    'hooks',
    'serve',
    'mcp',
    'store',
    'relay',
    'cloud',
    'updates',
  ] as const) {
    const rows =
      group === 'updates'
        ? update === undefined
          ? []
          : [update]
        : checks.filter((c) => c.group === group);
    if (group === 'updates' && rows.length === 0) continue;
    ctx.io.out(`${group === 'keys' ? '' : '\n'}${ui.bold(group)}\n`);
    ctx.io.out(
      ui.kv(
        rows.flatMap((c) => [
          [`${paint(ui, c.status, GLYPH[c.status])} ${c.name}`, c.detail] as const,
          ...(c.fix !== undefined
            ? [
                [
                  '',
                  ui.dim(`${c.status === 'warn' || c.status === 'fail' ? 'fix' : 'try'}: ${c.fix}`),
                ] as const,
              ]
            : []),
        ]),
        { indent: 2 },
      ),
    );
  }
  return exit;
}

/**
 * Doctor's update line, from the cache: a newer release (with `oort update`), or this one is the
 * latest. Nothing when the check is off or has not run yet.
 */
export function updateRow(ctx: Ctx, now = Date.now()): Check | undefined {
  const home = resolveHome(ctx.io.env);
  const off = updateCheckOff(ctx.io.env, home);
  if (off?.startsWith('home: ') === true) {
    // An opt-out says nothing; a home the check will not write in says why, once.
    return {
      group: 'updates',
      name: 'version',
      status: 'info',
      detail: `update check skipped: ${shown(tilde(home, ctx.io.env['HOME'] ?? ''))} ${off.slice('home: '.length)}`,
    };
  }
  if (off !== undefined) return undefined;
  const cache = readUpdateCache(home);
  const latest = availableUpdate(VERSION, cache);
  if (latest !== undefined) {
    return {
      group: 'updates',
      name: 'version',
      status: 'info',
      detail: noticeText(latest, VERSION).replace(/: oort update$/, ''),
      fix: 'oort update',
    };
  }
  if (cache.latest === undefined || cache.checkedAt === undefined) return undefined;
  if ((compareVersions(VERSION, cache.latest) ?? -1) < 0) return undefined;
  const hours = Math.max(0, Math.round((now - cache.checkedAt) / 3_600_000));
  return {
    group: 'updates',
    name: 'version',
    status: 'ok',
    detail: `oort ${VERSION} is the latest (checked ${hours < 1 ? 'less than an hour' : `${hours} h`} ago)`,
  };
}
