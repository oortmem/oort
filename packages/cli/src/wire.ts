import * as path from 'node:path';
import {
  MissingCredentialError,
  localScope,
  projectIdFor,
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

export type AdapterRole = 'embed' | 'rerank' | 'decide' | 'write';

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
  harnessLog: HookLogger;
  close(): Promise<void>;
}

export interface WireOptions {
  env?: Env;
}

export type WireFn = (cwd: string, opts?: WireOptions) => Promise<Wired>;

interface Spec {
  configKey: 'embed' | 'rerank' | 'decide' | 'writer';
  provider: string;
  envVar: string;
  pkg: string;
}

const EMBED: Spec = {
  configKey: 'embed',
  provider: 'voyage',
  envVar: 'VOYAGE_API_KEY',
  pkg: '@oortmem/embed-voyage',
};
const RERANK: Spec = {
  configKey: 'rerank',
  provider: 'voyage',
  envVar: 'VOYAGE_API_KEY',
  pkg: '@oortmem/rerank-voyage',
};
const DECIDE: Spec = {
  configKey: 'decide',
  provider: 'jev',
  envVar: 'TYPESAFE_API_KEY',
  pkg: '@oortmem/decide-jev',
};
const WRITE: Spec = {
  configKey: 'writer',
  provider: 'anthropic',
  envVar: 'ANTHROPIC_API_KEY',
  pkg: '@oortmem/writer',
};

/**
 * One adapter, or why it is unavailable. `make` (which imports the adapter
 * package) only runs when the provider is supported and the key is set, so a
 * keyless run never loads a network client.
 */
async function load<T>(
  spec: Spec,
  config: ResolvedConfig,
  env: Env,
  make: (apiKey: string) => Promise<T>,
): Promise<{ ok: T } | { error: Error }> {
  const provider = config[spec.configKey].provider;
  if (provider !== spec.provider) {
    return {
      error: new Error(
        `${spec.configKey}.provider "${provider}" is not available; Phase 1 ships "${spec.provider}" (${spec.pkg}).`,
      ),
    };
  }
  const apiKey = env[spec.envVar];
  if (apiKey === undefined || apiKey === '') {
    return { error: new MissingCredentialError(spec.envVar, `${spec.configKey}.apiKey`) };
  }
  try {
    return { ok: await make(apiKey) };
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
 * Builds the engine for `cwd`: resolved config, the cwd's project scope, the
 * SQLite store under `$OORT_HOME`, and each adapter whose key is set. A
 * missing key leaves that adapter undefined (recorded in `unavailable`);
 * commands decide whether that degrades or refuses.
 */
export const wire: WireFn = async (cwd, opts = {}) => {
  const env = opts.env ?? process.env;
  const config = resolveConfig(cwd, env);
  const scope = localScope(projectIdFor(cwd));
  const store = await openSqliteStore({
    path: path.join(config.home, 'oort.sqlite'),
    coldDir: path.join(config.home, 'cold'),
    dimension: config.embed.dimension,
    d: config.activation.d,
  });
  const out: Wired = {
    config,
    scope,
    store,
    unavailable: {},
    harnessLog: createHookLogger(config.home),
    close: () => store.close(),
  };
  const embed = await load(EMBED, config, env, async (apiKey) =>
    (await import('@oortmem/embed-voyage')).voyageEmbedder({
      apiKey,
      model: config.embed.model,
      dimension: config.embed.dimension,
    }),
  );
  if ('ok' in embed) out.embed = embed.ok;
  else out.unavailable.embed = embed.error;
  const rerank = await load(RERANK, config, env, async (apiKey) =>
    (await import('@oortmem/rerank-voyage')).voyageReranker({ apiKey, model: config.rerank.model }),
  );
  if ('ok' in rerank) out.rerank = rerank.ok;
  else out.unavailable.rerank = rerank.error;
  const decide = await load(DECIDE, config, env, async (apiKey) =>
    (await import('@oortmem/decide-jev')).jevDecider({ apiKey }),
  );
  if ('ok' in decide) out.decide = decide.ok;
  else out.unavailable.decide = decide.error;
  const write = await load(WRITE, config, env, async (apiKey) =>
    (await import('@oortmem/writer')).anthropicWriter({ apiKey, model: config.writer.model }),
  );
  if ('ok' in write) out.write = write.ok;
  else out.unavailable.write = write.error;
  return out;
};
