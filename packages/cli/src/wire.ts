import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MissingCredentialError,
  OortConfig,
  cachingEmbedder,
  layeredEmbeddingCache,
  memoryEmbeddingCache,
  agentHome,
  ANONYMOUS_AGENT,
  isAgentId,
  localScope,
  resolveProject,
  resolveConfig,
  type DecisionController,
  type Embedder,
  type MemoryStore,
  type MemoryWriter,
  type Reranker,
  type Home,
  type ResolvedConfig,
  type Scope,
} from '@oortmem/core';
import { createHookLogger, type HookLogger } from '@oortmem/claude-code';
import { openSqliteStore, readEmbedderBinding, writeEmbedderBinding } from '@oortmem/store-sqlite';
import type { Env } from './io.js';
import {
  keyLookup,
  routeFor,
  summary,
  ROLES,
  type AdapterRole,
  type RoleRoute,
  type RouteSummary,
} from './credentials.js';
import { diskEmbeddingCache } from './embed-cache-disk.js';
import {
  EmbedderMismatchError,
  LOCAL_PROVIDER,
  embedderId,
  legacyEmbedderId,
  loadLocal,
} from './local-models.js';
import { createKeychain, type KeychainReader } from './keychain.js';
import { RELAY_MODELS, RELAY_PATHS, relayUrl, viaRelay, type OortRelayError } from './relay.js';
import { Refusal, echo } from './util.js';

import { cloudUrl, createCloudClient, readCloudSettings, type CloudClient } from './cloud.js';
export type { AdapterRole } from './credentials.js';

export interface Wired {
  config: ResolvedConfig;
  /**
   * Which store this machine uses (`~/.oort/cloud.json`). In `cloud` mode memories live in Oort
   * Cloud: `cloud` is the API client and no vendor adapter is loaded (the cloud calls the models).
   * The local store still holds the hooks' cursors and queue.
   */
  mode?: 'local' | 'cloud';
  cloud?: CloudClient;
  /** Why cloud mode has no client (no Oort key, a bad OORT_CLOUD_URL). */
  cloudProblem?: string;
  /** `scope.agentId` is the acting agent (`agent.id`). */
  scope: Scope;
  /**
   * Whether this project is private, only when its own `oort.config.json` sets `project.private`
   * (true or false); undefined when the value is a default or comes from the home config, and
   * whenever the project config was not read (the drain). Oort Cloud records what it is told, so
   * only an explicit setting is ever stated.
   */
  statedPrivacy?: boolean;
  /** Which of the person's agents this run acts as, and where its new memories land. */
  agent: WiredAgent;
  store: MemoryStore;
  embed?: Embedder;
  rerank?: Reranker;
  decide?: DecisionController;
  write?: MemoryWriter;
  /**
   * The embedder the config selects and the one the store's vectors come from (local mode, when
   * an embedder was wired). When they differ, `embed` is left unset (dense recall and writes
   * would mix vector spaces) and `reembedWith` holds the configured embedder for `oort reembed`.
   */
  embedder?: { active: string; bound: string; matches: boolean };
  reembedWith?: Embedder;
  /** Why each absent adapter is absent (usually a `MissingCredentialError`). */
  unavailable: Partial<Record<AdapterRole, Error>>;
  /** Which key serves each role (never the key itself). Absent in test doubles. */
  routes?: Record<AdapterRole, RouteSummary>;
  /**
   * Relay refusals (401, 402, 429) seen by adapters routed through Oort Pro,
   * newest last, so a command that degraded quietly (recall) can say why.
   */
  relayErrors?: OortRelayError[];
  harnessLog: HookLogger;
  /**
   * Config problems worked around while wiring, as short tokens
   * (`embed-dimension-ignored`, `project-id-untrusted`). Commands print each
   * message on stderr; hooks log the code.
   */
  warnings: WireWarning[];
  close(): Promise<void>;
}

/**
 * The agent a run acts as (CON-62): every host is its own agent, sharing the person's Planet and
 * keeping a Star no other agent reads. `home` is `star` when it is configured as a Star
 * (`oort connect <host> --star`), so its new memories stay private to it.
 */
export interface WiredAgent {
  id: string;
  home: Home;
  /**
   * Where the id came from: `--agent` (or a host's `oort mcp --agent`), `OORT_AGENT`, or `none`:
   * no agent was named, and the run is `anonymous`, reading and writing the Planet only.
   */
  source: 'flag' | 'env' | 'none';
}

/**
 * The agent for this run: the flag, else `OORT_AGENT`, else anonymous (`ANONYMOUS_AGENT`: the
 * Planet only, no Star read or written). Never Claude Code by default: an MCP entry written before
 * agents existed must not act as one. Refuses a bad or reserved id. An agent id is local
 * configuration, not authentication: any local process can name any agent.
 */
export function resolveAgent(home: string, env: Env, flag?: string): WiredAgent {
  const fromEnv = env['OORT_AGENT'];
  if (flag === undefined && (fromEnv === undefined || fromEnv === '')) {
    return { id: ANONYMOUS_AGENT, home: 'planet', source: 'none' };
  }
  const [id, source] = flag !== undefined ? [flag, 'flag' as const] : [fromEnv!, 'env' as const];
  if (!isAgentId(id)) {
    throw new Refusal(
      `agent ${echo(id)} is not an agent id: lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.`,
    );
  }
  return { id, home: agentHome(home, id), source };
}

export interface WireWarning {
  code:
    | 'embed-dimension-ignored'
    | 'project-id-untrusted'
    | 'keychain-unreadable'
    | 'cloud-unavailable';
  /** One line for stderr; holds config values only. */
  message: string;
}

export interface WireOptions {
  env?: Env;
  /** How long a store write may wait for another connection's lock (the store's default: 5000). */
  busyTimeoutMs?: number;
  /**
   * false: never migrate the store; an older one makes wiring reject with
   * `StoreMigrationRequiredError` (the hooks). Default true (every command).
   */
  migrate?: boolean;
  /** false: read no `oort.config.json` at all, only the home config (the drain). */
  projectConfig?: boolean;
  /**
   * Reads a provider key from the OS keychain when its env var is unset or
   * empty. Defaults to the macOS Keychain; tests inject a double.
   */
  keychain?: KeychainReader;
  /** The fetch every adapter uses (default: the global one); tests inject a fake. */
  fetch?: typeof fetch;
  /**
   * The adapters to load (default: all four). A hook that only recalls asks for embed and rerank,
   * so it neither reads the TypeSafe and Anthropic keys nor imports their SDKs (CON-57).
   */
  roles?: readonly AdapterRole[];
  /** Per-request timeout for the Oort Cloud client (the hooks pass their budget). */
  cloudTimeoutMs?: number;
  /** The agent to act as (`--agent`); default `OORT_AGENT`, else anonymous (Planet only). */
  agent?: string;
}

export type WireFn = (cwd: string, opts?: WireOptions) => Promise<Wired>;

interface Spec {
  role: AdapterRole;
  configKey: 'embed' | 'rerank' | 'decide' | 'writer';
  provider: string;
  envVar: string;
  pkg: string;
  /** The models the relay serves for this role (any, when absent). */
  relayModels?: readonly string[];
}

const EMBED: Spec = {
  role: 'embed',
  configKey: 'embed',
  provider: 'voyage',
  envVar: 'VOYAGE_API_KEY',
  pkg: '@oortmem/embed-voyage',
  relayModels: RELAY_MODELS.embed,
};
const RERANK: Spec = {
  role: 'rerank',
  configKey: 'rerank',
  provider: 'voyage',
  envVar: 'VOYAGE_API_KEY',
  pkg: '@oortmem/rerank-voyage',
  relayModels: RELAY_MODELS.rerank,
};
const DECIDE: Spec = {
  role: 'decide',
  configKey: 'decide',
  provider: 'jev',
  envVar: 'TYPESAFE_API_KEY',
  pkg: '@oortmem/decide-jev',
};
const WRITE: Spec = {
  role: 'write',
  configKey: 'writer',
  provider: 'anthropic',
  envVar: 'ANTHROPIC_API_KEY',
  pkg: '@oortmem/writer',
  relayModels: RELAY_MODELS.write,
};

/** How an adapter reaches its vendor: directly, or through the relay root `relay`. */
type Reach = { key: string; relay?: string };

/**
 * One adapter, or why it is unavailable. `make` (which imports the adapter
 * package) only runs when the provider is supported and a key is found, so a
 * keyless run never loads a network client. With no vendor key and an Oort
 * key, the adapter goes through the relay, and its 401, 402 and 429 become
 * an `OortRelayError`.
 */
async function load<T extends object>(
  spec: Spec,
  config: ResolvedConfig,
  route: RoleRoute,
  relay: { url: string } | { error: string },
  onRelayError: (e: OortRelayError) => void,
  make: (reach: Reach) => Promise<T>,
): Promise<{ ok: T } | { error: Error }> {
  const provider = config[spec.configKey].provider;
  if (provider !== spec.provider) {
    return {
      error: new Error(
        `${spec.configKey}.provider "${provider}" is not available; Phase 1 ships "${spec.provider}" (${spec.pkg}).`,
      ),
    };
  }
  if (route.via === 'none') {
    return { error: new MissingCredentialError(spec.envVar, `${spec.configKey}.apiKey`) };
  }
  let reach: Reach = { key: route.key };
  if (route.via === 'oort') {
    if ('error' in relay) return { error: new Error(relay.error) };
    const model = (config[spec.configKey] as { model?: string }).model;
    if (spec.relayModels !== undefined && !spec.relayModels.includes(model ?? '')) {
      return {
        error: new Error(
          `${spec.configKey}.model ${echo(model ?? '')} is not served by Oort Pro (it serves ${spec.relayModels.join(', ')}); use that model, or set ${spec.envVar}.`,
        ),
      };
    }
    reach = { key: route.key, relay: relay.url };
  }
  try {
    const adapter = await make(reach);
    return { ok: reach.relay === undefined ? adapter : viaRelay(adapter, onRelayError) };
  } catch (e) {
    if (e instanceof MissingCredentialError) return { error: e };
    if ((e as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      return {
        error: new Error(
          `${spec.configKey}.provider "${provider}" needs ${spec.pkg}; install it with: pnpm add ${spec.pkg}`,
        ),
      };
    }
    // The name only: a constructor's message is not ours to vouch for (it could echo its options).
    return { error: new Error(`${spec.pkg} could not be constructed (${(e as Error).name}).`) };
  }
}

/**
 * Query embeddings are reused for `recall.queryCacheTtlSec` (CON-57): in memory for a long-lived
 * process (`oort mcp`), and on disk under `$OORT_HOME/cache/query-embed` for the hooks, which are
 * a new process per prompt. Keys are hashes; no query text is stored.
 */
function withQueryCache(embed: Embedder, config: ResolvedConfig): Embedder {
  const ttlMs = config.recall.queryCacheTtlSec * 1000;
  if (ttlMs <= 0) return embed;
  const cache = layeredEmbeddingCache(
    memoryEmbeddingCache({ ttlMs }),
    diskEmbeddingCache(path.join(config.home, 'cache', 'query-embed'), { ttlMs }),
  );
  return cachingEmbedder(embed, cache, {
    model: config.embed.model,
    dimension: config.embed.dimension,
  });
}

/** `embed.dimension` as the home config (or the default) sets it, ignoring any project config. */
function homeDimension(home: string): number {
  const file = path.join(home, 'config.json');
  // resolveConfig has already validated this file.
  const raw = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    : {};
  return OortConfig.shape.embed.parse(raw['embed']).dimension;
}

/**
 * Compares the configured embedder with the one the store is bound to. A store with no memories
 * takes the configured one; a store with memories but no binding predates bindings, so its
 * vectors are Voyage's. `write` false (the hooks): nothing is recorded, only compared.
 */
function bindEmbedder(
  storePath: string,
  config: ResolvedConfig,
  write: boolean,
): { active: string; bound: string; matches: boolean } {
  const active = embedderId(config.embed);
  const recorded = readEmbedderBinding(storePath);
  const bound = !recorded.hasMemories ? active : (recorded.model ?? legacyEmbedderId(config.embed));
  if (write && recorded.model !== bound) {
    try {
      writeEmbedderBinding(storePath, bound);
    } catch {
      // Best effort: the comparison below does not depend on it.
    }
  }
  return { active, bound, matches: bound === active };
}

/**
 * Builds the engine for `cwd`: resolved config, the cwd's project scope, the
 * SQLite store under `$OORT_HOME`, and each adapter whose key is set. A
 * missing key leaves that adapter undefined (recorded in `unavailable`);
 * commands decide whether that degrades or refuses.
 */
export const wire: WireFn = async (cwd, opts = {}) => {
  const env = opts.env ?? process.env;
  let config = resolveConfig(cwd, env, {
    ...(opts.projectConfig !== undefined && { projectConfig: opts.projectConfig }),
  });
  const warnings: WireWarning[] = [];
  // One store serves every project, so its dimension is the home config's: a
  // project config cannot change it (the store would refuse to open, or embed
  // vectors it cannot hold).
  if (config.sources['embed'] === 'project') {
    const dimension = homeDimension(config.home);
    if (dimension !== config.embed.dimension) {
      warnings.push({
        code: 'embed-dimension-ignored',
        message: `project config embed.dimension ${config.embed.dimension} ignored; the store uses ${dimension} from the home config.`,
      });
      config = { ...config, embed: { ...config.embed, dimension } };
    }
  }
  const project = resolveProject(cwd, config.home);
  // A repository file cannot choose a scope without the user's trust binding.
  if (project.untrustedId !== undefined && opts.projectConfig !== false) {
    warnings.push({
      code: 'project-id-untrusted',
      message: `oort.config.json sets project.id ${echo(project.untrustedId)}, ignored until you trust it: run \`oort project link\` in this repository.`,
    });
  }
  const agent = resolveAgent(config.home, env, opts.agent);
  const scope: Scope = { ...localScope(project.projectId), agentId: agent.id };
  const storePath = path.join(config.home, 'oort.sqlite');
  const store = await openSqliteStore({
    path: storePath,
    coldDir: path.join(config.home, 'cold'),
    dimension: config.embed.dimension,
    d: config.activation.d,
    ...(opts.busyTimeoutMs !== undefined && { busyTimeoutMs: opts.busyTimeoutMs }),
    ...(opts.migrate === false && { migrate: false }),
  });
  // Env first (set and non-empty), then the keychain, each item read at most once.
  const reader: KeychainReader =
    opts.keychain ??
    (env['OORT_NO_KEYCHAIN'] === '1'
      ? async () => undefined
      : createKeychain({
          env,
          warn: (message) => warnings.push({ code: 'keychain-unreadable', message }),
        }).read);
  const lookup = keyLookup(env, reader);
  const relay = relayUrl(env);
  const relayErrors: OortRelayError[] = [];
  const onRelayError = (e: OortRelayError): void => void relayErrors.push(e);
  const routes = {} as Record<AdapterRole, RouteSummary>;
  const routeOf = async (spec: Spec): Promise<RoleRoute> => {
    const r = await routeFor(spec.role, lookup);
    routes[spec.role] = summary(r);
    return r;
  };
  const fetchOpt = opts.fetch === undefined ? {} : { fetch: opts.fetch };
  const out: Wired = {
    config,
    scope,
    agent,
    store,
    unavailable: {},
    routes,
    relayErrors,
    harnessLog: createHookLogger(config.home),
    warnings,
    close: () => store.close(),
  };
  const stated =
    opts.projectConfig === false || scope.projectId === undefined
      ? undefined
      : statedProjectPrivacy(cwd, config);
  if (stated !== undefined) out.statedPrivacy = stated;
  const settings = readCloudSettings(config.home);
  if (settings.store === 'cloud') {
    out.mode = 'cloud';
    const url = cloudUrl(env);
    const key = await lookup('oort');
    if ('error' in url) out.cloudProblem = url.error;
    else if (key === undefined)
      out.cloudProblem =
        'cloud mode needs the Oort key: run `oort login` (or `oort cloud use --local`).';
    else
      out.cloud = createCloudClient({
        url: url.url,
        key: key.key,
        ...fetchOpt,
        ...(opts.cloudTimeoutMs !== undefined && { timeoutMs: opts.cloudTimeoutMs }),
      });
    if (out.cloudProblem !== undefined)
      warnings.push({ code: 'cloud-unavailable', message: out.cloudProblem });
    // The cloud runs the models with Oort's keys: no vendor adapter, no vendor key read.
    return out;
  }
  out.mode = 'local';
  const want = new Set<AdapterRole>(opts.roles ?? ROLES);
  // The selected adapters load in parallel; key reads are cached per provider, so a shared key
  // (Voyage for embed and rerank) is still read once.
  await Promise.all([
    want.has('embed') &&
      (async () => {
        const embed =
          config.embed.provider === LOCAL_PROVIDER
            ? await loadLocal('embed', config)
            : await load(EMBED, config, await routeOf(EMBED), relay, onRelayError, async (r) =>
                (await import('@oortmem/embed-voyage')).voyageEmbedder({
                  apiKey: r.key,
                  model: config.embed.model,
                  dimension: config.embed.dimension,
                  ...(r.relay !== undefined && {
                    baseUrl: `${r.relay}${RELAY_PATHS.voyage}`,
                    relay: true,
                  }),
                  ...fetchOpt,
                }),
              );
        if ('error' in embed) {
          out.unavailable.embed = embed.error;
          return;
        }
        const bound = bindEmbedder(storePath, config, opts.migrate !== false);
        out.embedder = bound;
        if (bound.matches) out.embed = withQueryCache(embed.ok, config);
        else {
          out.reembedWith = embed.ok;
          out.unavailable.embed = new EmbedderMismatchError(bound.bound, bound.active);
        }
      })(),
    want.has('rerank') &&
      (async () => {
        const rerank =
          config.rerank.provider === LOCAL_PROVIDER
            ? await loadLocal('rerank', config)
            : await load(RERANK, config, await routeOf(RERANK), relay, onRelayError, async (r) =>
                (await import('@oortmem/rerank-voyage')).voyageReranker({
                  apiKey: r.key,
                  model: config.rerank.model,
                  ...(r.relay !== undefined && {
                    baseUrl: `${r.relay}${RELAY_PATHS.voyage}`,
                    relay: true,
                  }),
                  ...fetchOpt,
                }),
              );
        if ('ok' in rerank) out.rerank = rerank.ok;
        else out.unavailable.rerank = rerank.error;
      })(),
    want.has('decide') &&
      (async () => {
        const decide = await load(
          DECIDE,
          config,
          await routeOf(DECIDE),
          relay,
          onRelayError,
          async (r) =>
            (await import('@oortmem/decide-jev')).jevDecider({
              apiKey: r.key,
              ...(r.relay !== undefined && {
                baseURL: `${r.relay}${RELAY_PATHS.typesafe}`,
                relay: true,
              }),
              ...fetchOpt,
            }),
        );
        if ('ok' in decide) out.decide = decide.ok;
        else out.unavailable.decide = decide.error;
      })(),
    want.has('write') &&
      (async () => {
        const write = await load(
          WRITE,
          config,
          await routeOf(WRITE),
          relay,
          onRelayError,
          async (r) =>
            (await import('@oortmem/writer')).anthropicWriter({
              ...(r.relay === undefined
                ? { apiKey: r.key }
                : { authToken: r.key, baseURL: `${r.relay}${RELAY_PATHS.anthropic}`, relay: true }),
              model: config.writer.model,
              ...fetchOpt,
            }),
        );
        if ('ok' in write) out.write = write.ok;
        else out.unavailable.write = write.error;
      })(),
  ]);
  // Routes are reported in role order, whatever order the parallel loads finished in.
  const ordered = {} as Record<AdapterRole, RouteSummary>;
  for (const role of ROLES) if (routes[role] !== undefined) ordered[role] = routes[role];
  out.routes = ordered;
  return out;
};

/**
 * `project.private` exactly as the nearest `oort.config.json` at or above `cwd` writes it, when
 * the resolved config took its `project` from that file; undefined for a default (or a home
 * config's value) and for an unreadable file.
 */
export function statedProjectPrivacy(cwd: string, config: ResolvedConfig): boolean | undefined {
  if (config.sources['project'] !== 'project') return undefined;
  let dir = path.resolve(cwd);
  for (;;) {
    const file = path.join(dir, 'oort.config.json');
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          project?: { private?: unknown };
        };
        const v = raw.project?.private;
        return typeof v === 'boolean' ? v : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The privacy statement to send with a call about this project: only an explicit one. */
export const privacyStatement = (w: Pick<Wired, 'statedPrivacy'>): { projectPrivate?: boolean } =>
  w.statedPrivacy === undefined ? {} : { projectPrivate: w.statedPrivacy };
