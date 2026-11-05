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
import { ROLES, ROLE_VENDOR, keyLookup, routeFor, type AdapterRole } from '../credentials.js';
import { describeProblem, inspectCredentialsFile } from '../credentials-file.js';
import { PROVIDER_ENV } from '../keychain.js';
import { OortCloudError, cloudUrl, createCloudClient, readCloudSettings } from '../cloud.js';
import { spaceLine } from './whoami.js';
import { LOCAL_INSTALL_HINT, LOCAL_PROVIDER, importLocalModels } from '../local-models.js';
import { RELAY_MODELS, relayUrl } from '../relay.js';
import { uiFor, type Ui } from '../ui.js';
import { Refusal, echo, shown, tilde, withWired, type Ctx } from '../util.js';
import { hostContext } from './connect.js';
import { VERSION } from '@oortmem/core';
import { hookBinaryOf, hookCommandPath, settingsFile, versionManagerOf } from './install.js';
import { SKIP_FILE, callDaemon, readSkip } from '../serve-client.js';
import { socketPathFor } from '../serve-protocol.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info' | 'unknown';

export interface Check {
  group: 'keys' | 'hooks' | 'serve' | 'mcp' | 'store' | 'relay' | 'cloud';
  name: string;
  status: CheckStatus;
  /** One line; never a key or a memory. */
  detail: string;
  /** One command or sentence that fixes a `warn` or `fail`. */
  fix?: string;
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
    const where = (source: 'env' | 'keychain', provider: string): string =>
      source === 'env'
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
        fix: ctx.keychain.supported
          ? `oort keys set ${r.provider}, or oort login (Oort Pro)`
          : `export ${PROVIDER_ENV[r.provider]}=..., or OORT_API_KEY=... from oortcloud.dev/account (Oort Pro)`,
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

/** The Claude Code hooks in the user settings file. */
async function hookChecks(ctx: Ctx, cmd: string | undefined, home: string): Promise<Check[]> {
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
        fix: `fix the JSON in ${show}, then oort install claude-code`,
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
        fix: 'oort install claude-code',
      },
    ];
  }
  const binaries = await hookBinaryChecks(ctx, found, cmd);
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
        fix: HOOK_FIX,
      },
      ...binaries,
    ];
  }
  // A version mismatch says more than "another path"; one warning for one cause.
  const versionWarned = binaries.some((c) => c.name === 'claude-code bin' && c.status === 'warn');
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
        fix: 'oort install claude-code',
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
const REINSTALL_FIX = `${HOOK_FIX} (run it from the oort you want the hooks to use)`;
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
): Promise<Check[]> {
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
    const manager = versionManagerOf(bin);
    if (manager !== undefined) {
      checks.push({
        group: 'hooks',
        name: 'claude-code node',
        status: 'info',
        detail: `the hooks run ${show}, under a Node version manager: switching Node versions will break them`,
        fix: 'install oortmem somewhere stable (npm i -g oortmem with a system Node), then oort install claude-code',
      });
    }
    if (!isExecutable(bin)) continue; // never run a path that is not there
    const got = await probeVersion(bin, { ...process.env, ...ctx.io.env }, viaNode);
    if (got === undefined || got === '') {
      checks.push({
        group: 'hooks',
        name: 'claude-code bin',
        status: 'warn',
        detail: `${show} did not report a version for --version`,
        fix: REINSTALL_FIX,
      });
    } else if (got !== VERSION) {
      checks.push({
        group: 'hooks',
        name: 'claude-code bin',
        status: 'warn',
        detail: `the hooks run oort ${got} (${show}), but this is oort ${VERSION}`,
        fix: REINSTALL_FIX,
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

/**
 * `oort serve`: running or not, its pid, version and socket, and a warning when it is another
 * oort than this one (the hooks then run in-process until it restarts). Reads only; a stale
 * socket is reported, never removed.
 */
async function serveChecks(ctx: Ctx): Promise<Check[]> {
  const home = resolveHome(ctx.io.env);
  const socket = socketPathFor(home);
  const show = shown(tilde(socket, ctx.io.env['HOME'] ?? ''));
  const base = { group: 'serve' as const, name: 'daemon' };
  const skip = readSkip(home);
  const skipping: Check[] =
    skip !== undefined && skip.until > Date.now()
      ? [
          {
            group: 'serve',
            name: 'hooks',
            status: 'warn',
            detail: `skip the daemon until ${new Date(skip.until).toISOString()}, after ${skip.reason === 'refused' ? 'it refused a hook (another protocol or version)' : 'a hook timed out on it'}; they run in-process (${SKIP_FILE})`,
            fix: 'oort serve status (tries it again), or oort serve stop && oort serve --detach',
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
    if (before !== undefined && before < SCHEMA_VERSION) {
      checks.push({
        group: 'store',
        name: 'migration',
        status: 'ok',
        detail: `migrated the store from schema version ${before} to ${SCHEMA_VERSION}; your memories now live in your Planet`,
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
    const backup = listBackups(db, 'pre-v2').at(-1);
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
      },
    ];
  }
}

const GLYPH: Record<CheckStatus, string> = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  info: '·',
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
  const keys = await keyChecks(ctx);
  const checks: Check[] = [
    ...keys.checks,
    ...(await hookChecks(ctx, cmd, home)),
    ...(await serveChecks(ctx)),
    ...mcpChecks(ctx, cmd),
    ...(await storeChecks(ctx)),
    ...(await relayChecks(ctx, keys.relayed)),
    ...(await cloudChecks(ctx)),
  ];
  const ok = !checks.some((c) => c.status === 'fail');
  if (opts.json === true) {
    ctx.io.out(`${JSON.stringify({ ok, checks }, null, 2)}\n`);
    return ok ? 0 : 1;
  }
  const ui = uiFor(ctx.io);
  const problems = checks.filter((c) => c.status === 'warn' || c.status === 'fail').length;
  ctx.io.out(
    ui.header(
      'doctor',
      problems === 0 ? ui.success('no problems') : ui.warning(`${problems} to fix`),
    ),
  );
  for (const group of ['keys', 'hooks', 'serve', 'mcp', 'store', 'relay', 'cloud'] as const) {
    const rows = checks.filter((c) => c.group === group);
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
  return ok ? 0 : 1;
}
