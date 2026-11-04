import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MissingCredentialError,
  OortConfig,
  localScope,
  resolveProject,
  resolveConfig,
  type DecisionController,
  type Embedder,
  type MemoryStore,
  type MemoryWriter,
  type Reranker,
  type ResolvedConfig,
  type Scope,
} from '@oortmem/core';
import { createHookLogger, type HookLogger } from '@oortmem/claude-code';
import { openSqliteStore } from '@oortmem/store-sqlite';
import type { Env } from './io.js';
import {
  keyLookup,
  routeFor,
  summary,
  type AdapterRole,
  type RoleRoute,
  type RouteSummary,
} from './credentials.js';
import { createKeychain, type KeychainReader } from './keychain.js';
import { RELAY_MODELS, RELAY_PATHS, relayUrl, viaRelay, type OortRelayError } from './relay.js';
import { echo } from './util.js';

export type { AdapterRole } from './credentials.js';

export interface Wired {
  config: ResolvedConfig;
  scope: Scope;
  store: MemoryStore;
  embed?: Embedder;
  rerank?: Reranker;
  decide?: DecisionController;
  write?: MemoryWriter;
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

export interface WireWarning {
  code: 'embed-dimension-ignored' | 'project-id-untrusted' | 'keychain-unreadable';
  /** One line for stderr; holds config values only. */
  message: string;
}

export interface WireOptions {
  env?: Env;
  /** How long a store write may wait for another connection's lock (the store's default: 5000). */
  busyTimeoutMs?: number;
  /** false: read no `oort.config.json` at all, only the home config (the drain). */
  projectConfig?: boolean;
  /**
   * Reads a provider key from the OS keychain when its env var is unset or
   * empty. Defaults to the macOS Keychain; tests inject a double.
   */
  keychain?: KeychainReader;
  /** The fetch every adapter uses (default: the global one); tests inject a fake. */
  fetch?: typeof fetch;
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
  const scope = localScope(project.projectId);
  const store = await openSqliteStore({
    path: path.join(config.home, 'oort.sqlite'),
    coldDir: path.join(config.home, 'cold'),
    dimension: config.embed.dimension,
    d: config.activation.d,
    ...(opts.busyTimeoutMs !== undefined && { busyTimeoutMs: opts.busyTimeoutMs }),
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
    store,
    unavailable: {},
    routes,
    relayErrors,
    harnessLog: createHookLogger(config.home),
    warnings,
    close: () => store.close(),
  };
  const embed = await load(EMBED, config, await routeOf(EMBED), relay, onRelayError, async (r) =>
    (await import('@oortmem/embed-voyage')).voyageEmbedder({
      apiKey: r.key,
      model: config.embed.model,
      dimension: config.embed.dimension,
      ...(r.relay !== undefined && { baseUrl: `${r.relay}${RELAY_PATHS.voyage}`, relay: true }),
      ...fetchOpt,
    }),
  );
  if ('ok' in embed) out.embed = embed.ok;
  else out.unavailable.embed = embed.error;
  const rerank = await load(RERANK, config, await routeOf(RERANK), relay, onRelayError, async (r) =>
    (await import('@oortmem/rerank-voyage')).voyageReranker({
      apiKey: r.key,
      model: config.rerank.model,
      ...(r.relay !== undefined && { baseUrl: `${r.relay}${RELAY_PATHS.voyage}`, relay: true }),
      ...fetchOpt,
    }),
  );
  if ('ok' in rerank) out.rerank = rerank.ok;
  else out.unavailable.rerank = rerank.error;
  const decide = await load(DECIDE, config, await routeOf(DECIDE), relay, onRelayError, async (r) =>
    (await import('@oortmem/decide-jev')).jevDecider({
      apiKey: r.key,
      ...(r.relay !== undefined && { baseURL: `${r.relay}${RELAY_PATHS.typesafe}`, relay: true }),
      ...fetchOpt,
    }),
  );
  if ('ok' in decide) out.decide = decide.ok;
  else out.unavailable.decide = decide.error;
  const write = await load(WRITE, config, await routeOf(WRITE), relay, onRelayError, async (r) =>
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
  return out;
};
