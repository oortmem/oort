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
  localGrant,
  localScope,
  nodeGrant,
  planetNode,
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
  type Grant,
  type ProjectResolution,
} from '@oortmem/core';
import { createHookLogger, type HookLogger } from '@oortmem/claude-code';
import type { Env } from './io.js';
import {
  keyLookup,
  routeFor,
  type KeyLookup,
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
import {
  PROVIDER_ENV,
  createKeychain,
  keychainFor,
  type KeychainReader,
  type Provider,
} from './keychain.js';
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
  /**
   * Whether `oort keys set` and `oort login` can keep a key here (the Keychain or
   * credentials.json, and `OORT_NO_KEYCHAIN` unset). False: missing-key messages name the
   * environment variable instead. Absent (test doubles) counts as true.
   */
  keyStore?: boolean;
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
      `Agent ${echo(id)} is not an agent id: lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.`,
    );
  }
  return { id, home: agentHome(home, id), source };
}

export interface WireWarning {
  code:
    | 'embed-dimension-ignored'
    | 'project-id-untrusted'
    | 'keychain-unreadable'
    | 'cloud-unavailable'
    | 'serve-ignored'
    | 'judge-ignored';
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
  /**
   * Keep Oort Cloud connections open between requests: set by the long-lived processes
   * (`oort serve`, `oort mcp`), so a warm one sends each request on an open connection.
   */
  cloudKeepAlive?: boolean;
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
        `${spec.configKey}.provider "${provider}" is not available; this version supports "${spec.provider}" (${spec.pkg})${spec.role === 'embed' || spec.role === 'rerank' ? ` or "${LOCAL_PROVIDER}" (\`oort models pull\`)` : ''}.`,
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
  sqlite: Pick<
    typeof import('@oortmem/store-sqlite'),
    'readEmbedderBinding' | 'writeEmbedderBinding'
  >,
  storePath: string,
  config: ResolvedConfig,
  write: boolean,
): { active: string; bound: string; matches: boolean } {
  const active = embedderId(config.embed);
  const recorded = sqlite.readEmbedderBinding(storePath);
  const bound = !recorded.hasMemories ? active : (recorded.model ?? legacyEmbedderId(config.embed));
  if (write && recorded.model !== bound) {
    try {
      sqlite.writeEmbedderBinding(storePath, bound);
    } catch {
      // Best effort: the comparison below does not depend on it.
    }
  }
  return { active, bound, matches: bound === active };
}

/** Where a role's key may come from (the SDK's `keySources`); the CLI uses all three. */
export type KeySource = 'explicit' | 'env' | 'keychain';

/**
 * What `wireEngine` takes: everything `wire` does except the agent, plus the SDK's choices. The
 * engine is principal-free: who reads and writes (org, user, agent, project) is `principalFor`'s.
 */
export interface EngineOptions extends Omit<WireOptions, 'agent'> {
  /** Used only to find the project and its `oort.config.json`. */
  cwd: string;
  /** `auto` (default): `$OORT_HOME/cloud.json` decides, as the CLI does. */
  mode?: 'auto' | 'local' | 'cloud';
  /**
   * Open the local store in cloud mode too: the CLI's hooks keep their cursors and queue there.
   * The SDK leaves it off, so cloud mode opens, creates and writes nothing under `OORT_HOME`.
   */
  storeInCloud?: boolean;
  /** Report `project-id-untrusted` (default true); the SDK turns it off for an explicit project. */
  projectWarning?: boolean;
  /** Laid over the resolved config (the SDK's `config`), already validated by the caller. */
  configOverlay?: Record<string, unknown>;
  /**
   * Keys given in code, tried before any other source (SDK `keys`). Only ever passed to the
   * adapters and the cloud client; never stored on the engine.
   */
  explicitKeys?: Partial<Record<Provider, string>>;
  /** The key sources to read (default: all three). */
  keySources?: readonly KeySource[];
  /** Test hook: adapters to use instead of loading the vendor packages (never a public option). */
  adapters?: Partial<Record<AdapterRole, unknown>>;
}

/**
 * The engine without a principal (CON-108): config, mode, store or cloud client, and adapters.
 * `store` is absent in cloud mode unless `storeInCloud` asked for it.
 */
export interface Engine {
  config: ResolvedConfig;
  mode: 'local' | 'cloud';
  store?: MemoryStore;
  cloud?: CloudClient;
  cloudProblem?: string;
  embed?: Embedder;
  rerank?: Reranker;
  decide?: DecisionController;
  write?: MemoryWriter;
  embedder?: { active: string; bound: string; matches: boolean };
  reembedWith?: Embedder;
  unavailable: Partial<Record<AdapterRole, Error>>;
  keyStore: boolean;
  routes: Record<AdapterRole, RouteSummary>;
  relayErrors: OortRelayError[];
  warnings: WireWarning[];
  /** The cwd's project, resolved once (`resolveProject`). */
  project: ProjectResolution;
  /** `project.private` as the cwd's own `oort.config.json` states it (see `Wired.statedPrivacy`). */
  statedPrivacy?: boolean;
  close(): Promise<void>;
}

/** Config and project for a cwd: the synchronous first half of wiring (no store, no keys). */
interface Prepared {
  config: ResolvedConfig;
  warnings: WireWarning[];
  project: ProjectResolution;
}

/** Deep merge of plain objects: `over` wins; arrays and scalars replace. */
function overlay(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] =
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      b !== null &&
      typeof b === 'object' &&
      !Array.isArray(b)
        ? overlay(b as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

function prepare(opts: EngineOptions, env: Env): Prepared {
  const cwd = opts.cwd;
  let config = resolveConfig(cwd, env, {
    ...(opts.projectConfig !== undefined && { projectConfig: opts.projectConfig }),
  });
  const warnings: WireWarning[] = [];
  if (opts.configOverlay !== undefined && Object.keys(opts.configOverlay).length > 0) {
    // The host's code is the operator: its overlay outranks both files (but never sets `serve`;
    // the caller has refused that already). Re-validated as a whole by the strict schema.
    const { home, sources, ignoredProjectKeys, ...plain } = config;
    const merged = OortConfig.parse(overlay(plain, opts.configOverlay));
    const over = Object.fromEntries(
      Object.keys(opts.configOverlay).map((k) => [k, 'home' as const]),
    );
    config = {
      ...merged,
      home,
      sources: { ...sources, ...over },
      ...(ignoredProjectKeys !== undefined && { ignoredProjectKeys }),
    };
  }
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
  // `serve` starts processes on this machine: a repository's oort.config.json cannot set it.
  if (config.ignoredProjectKeys?.includes('serve') === true) {
    warnings.push({
      code: 'serve-ignored',
      message: 'project config serve ignored; oort serve reads the home config only.',
    });
  }
  // Who counts as an expert is the person's call, not a repository's.
  if (config.ignoredProjectKeys?.includes('judge') === true) {
    warnings.push({
      code: 'judge-ignored',
      message: 'project config judge ignored; judgment memory reads the home config only.',
    });
  }
  const project = resolveProject(cwd, config.home);
  // A repository file cannot choose a scope without the user's trust binding.
  if (
    project.untrustedId !== undefined &&
    opts.projectConfig !== false &&
    opts.projectWarning !== false
  ) {
    warnings.push({
      code: 'project-id-untrusted',
      message: `oort.config.json sets project.id ${echo(project.untrustedId)}, ignored until you trust it: run \`oort project link\` in this repository.`,
    });
  }
  return { config, warnings, project };
}

/** The env vars that carry keys, left out of the key lookup when `keySources` drops `env`. */
const KEY_ENV = new Set(Object.values(PROVIDER_ENV));

/**
 * The second half of wiring: the mode, then (local, or `storeInCloud`) the store, then the keys
 * and either the cloud client or the adapters. The mode is decided before any store is opened,
 * and `@oortmem/store-sqlite` is imported only when one is: cloud mode loads no native module.
 */
async function open(p: Prepared, opts: EngineOptions, env: Env): Promise<Engine> {
  const { config, warnings, project } = p;
  const mode: 'local' | 'cloud' =
    opts.mode === 'local' || opts.mode === 'cloud'
      ? opts.mode
      : readCloudSettings(config.home).store;
  const storePath = path.join(config.home, 'oort.sqlite');
  const sqlite =
    mode === 'local' || opts.storeInCloud === true
      ? await import('@oortmem/store-sqlite')
      : undefined;
  const store = await sqlite?.openSqliteStore({
    path: storePath,
    coldDir: path.join(config.home, 'cold'),
    dimension: config.embed.dimension,
    d: config.activation.d,
    vectorIndex: config.store.vectorIndex,
    binaryAutoThreshold: config.store.binaryAutoThreshold,
    ...(opts.busyTimeoutMs !== undefined && { busyTimeoutMs: opts.busyTimeoutMs }),
    ...(opts.migrate === false && { migrate: false }),
  });
  const sources = new Set<KeySource>(opts.keySources ?? ['explicit', 'env', 'keychain']);
  // Env first (set and non-empty), then the keychain, each item read at most once.
  const none: KeychainReader = async () => undefined;
  const reader: KeychainReader = !sources.has('keychain')
    ? none
    : (opts.keychain ??
      (env['OORT_NO_KEYCHAIN'] === '1'
        ? none
        : createKeychain({
            env,
            warn: (message) => warnings.push({ code: 'keychain-unreadable', message }),
          }).read));
  const keyEnv = sources.has('env')
    ? env
    : Object.fromEntries(Object.entries(env).filter(([k]) => !KEY_ENV.has(k)));
  const fromSources = keyLookup(keyEnv, reader);
  const explicit = sources.has('explicit') ? opts.explicitKeys : undefined;
  const lookup: KeyLookup = async (provider) => {
    const given = explicit?.[provider];
    if (given !== undefined && given !== '') return { source: 'explicit', key: given };
    return fromSources(provider);
  };
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
  const out: Engine = {
    config,
    mode,
    ...(store !== undefined && { store }),
    unavailable: {},
    keyStore: keychainFor(env).supported,
    routes,
    relayErrors,
    warnings,
    project,
    close: async () => {
      await store?.close();
    },
  };
  const stated =
    opts.projectConfig === false || project.projectId === undefined
      ? undefined
      : statedProjectPrivacy(opts.cwd, config);
  if (stated !== undefined) out.statedPrivacy = stated;
  if (mode === 'cloud') {
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
        ...(opts.cloudKeepAlive === true && { keepAlive: true }),
        // Diagnostics only: the API's Server-Timing breakdown, beside the CLI's own clock.
        ...(env['OORT_HOOK_TIMING'] === '1' && { serverTiming: true }),
      });
    if (out.cloudProblem !== undefined)
      warnings.push({ code: 'cloud-unavailable', message: out.cloudProblem });
    // The cloud runs the models with Oort's keys: no vendor adapter, no vendor key read.
    return out;
  }
  if (sqlite === undefined) throw new Error('unreachable: local mode without a store');
  const given = opts.adapters;
  const want = new Set<AdapterRole>(opts.roles ?? ROLES);
  // The selected adapters load in parallel; key reads are cached per provider, so a shared key
  // (Voyage for embed and rerank) is still read once.
  await Promise.all([
    want.has('embed') &&
      (async () => {
        const embed =
          given?.embed !== undefined
            ? { ok: given.embed as Embedder }
            : config.embed.provider === LOCAL_PROVIDER
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
        const bound = bindEmbedder(sqlite, storePath, config, opts.migrate !== false);
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
          given?.rerank !== undefined
            ? { ok: given.rerank as Reranker }
            : config.rerank.provider === LOCAL_PROVIDER
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
        const decide =
          given?.decide !== undefined
            ? { ok: given.decide as DecisionController }
            : await load(DECIDE, config, await routeOf(DECIDE), relay, onRelayError, async (r) =>
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
        const write =
          given?.write !== undefined
            ? { ok: given.write as MemoryWriter }
            : await load(WRITE, config, await routeOf(WRITE), relay, onRelayError, async (r) =>
                (await import('@oortmem/writer')).anthropicWriter({
                  ...(r.relay === undefined
                    ? { apiKey: r.key }
                    : {
                        authToken: r.key,
                        baseURL: `${r.relay}${RELAY_PATHS.anthropic}`,
                        relay: true,
                      }),
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
}

/**
 * The principal-free engine for `opts.cwd` (CON-108): resolved config, the cwd's project, the
 * mode, the store (local mode) or the Oort Cloud client, and each adapter whose key is found. In
 * cloud mode nothing under `OORT_HOME` is opened or created (unless `storeInCloud`), and no native
 * module is loaded. A missing key leaves that adapter undefined (recorded in `unavailable`).
 */
export async function wireEngine(opts: EngineOptions): Promise<Engine> {
  const env = opts.env ?? process.env;
  return open(prepare(opts, env), opts, env);
}

/**
 * Who reads and writes: the scope (org, customer, agent, project), where the agent's new
 * memories land, and the one grant every read and write of this principal uses. `grant` is the
 * acting agent's local grant (the person's Planet and the agent's own Star), or, for an end user
 * (`customerId` other than `self`), the user's Planet alone: today's Star is keyed by org and
 * agent, not by user, so it would leak between users (CON-108 §6.4).
 */
export interface Principal {
  scope: Scope;
  agent: WiredAgent;
  grant: Grant;
}

/**
 * The principal for a scope and agent. `planetOnly` (end users) reads and writes the user's
 * Planet only, with the agent still recorded as the author; an agent whose home is its Star is
 * the caller's to refuse before this.
 */
export function principalFor(
  engine: Pick<Engine, 'config'>,
  p: {
    orgId?: string;
    customerId?: string;
    agent: WiredAgent;
    projectId?: string;
    planetOnly?: boolean;
  },
): Principal {
  const base = localScope(p.projectId);
  const scope: Scope = {
    ...base,
    ...(p.orgId !== undefined && { orgId: p.orgId }),
    ...(p.customerId !== undefined && { customerId: p.customerId }),
    agentId: p.agent.id,
  };
  const projectIds = [...new Set<string | null>([scope.projectId ?? null, null])];
  const principal = { orgId: scope.orgId, customerId: scope.customerId, agentId: scope.agentId };
  const grant =
    p.planetOnly === true
      ? nodeGrant({ principal, read: [{ node: planetNode(principal), projectIds }] })
      : localGrant({ ...principal, projectIds }, { home: p.agent.home });
  void engine;
  return { scope, agent: p.agent, grant };
}

/**
 * Builds the engine for `cwd`: resolved config, the cwd's project scope, the
 * SQLite store under `$OORT_HOME`, and each adapter whose key is set. A
 * missing key leaves that adapter undefined (recorded in `unavailable`);
 * commands decide whether that degrades or refuses. A thin wrapper over
 * `wireEngine` and `principalFor`; the store opens in cloud mode too (the hooks' cursors and
 * queue live there).
 */
export const wire: WireFn = async (cwd, opts = {}) => {
  const env = opts.env ?? process.env;
  const { agent: flag, ...rest } = opts;
  const eopts: EngineOptions = { ...rest, cwd, storeInCloud: true };
  const prepared = prepare(eopts, env);
  const agent = resolveAgent(prepared.config.home, env, flag);
  const engine = await open(prepared, eopts, env);
  const { scope } = principalFor(engine, {
    agent,
    ...(engine.project.projectId !== undefined && { projectId: engine.project.projectId }),
  });
  const { store, project: _p, ...fields } = engine;
  if (store === undefined) throw new Error('unreachable: wire() always opens the store');
  const out: Wired = {
    ...fields,
    scope,
    agent,
    store,
    harnessLog: createHookLogger(engine.config.home),
  };
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
