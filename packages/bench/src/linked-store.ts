/**
 * Link-shaped latency stores at 100k and 1M memories (CON-146, design section 11), built once and
 * cached on disk, because a million memories take long to generate and seed.
 *
 * A cached store lives in `<cacheDir>/linked-<count>-s<seed>-g<generator>/` with a `manifest.json`
 * written last: a directory without one is a build that did not finish, and is rebuilt. The
 * manifest names the generator version, count and seed (a mismatch rebuilds from scratch) and the
 * store schema version and links capability the warm-up ran with (a mismatch re-runs only the
 * warm-up, on the store the new code has migrated).
 *
 * The warm-up. `pnpm bench` measures on a `frozen()` store whose `recordAccess` does nothing, so
 * nothing a measured recall does can change the store under the next one, and a learned
 * `recalledWith` pair could never form there. So the warm-up runs first, on the unwrapped store,
 * with access recording live and (once `recall.links` exists) links on: its recalls record
 * accesses and, with CON-150, learn pairs. Only then is the store frozen for measurement. The
 * warm-up questions are drawn separately from the measured ones.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { recall, resolveConfig, type MemoryStore, type ResolvedConfig } from '@oortmem/core';
import { openSqliteStore, SCHEMA_VERSION, sqliteVectorIndex } from '@oortmem/store-sqlite';
import { fakeEmbedder } from './fake-embed.js';
import { EMBEDDING_DIMENSION, GENERATOR_NOW } from './generate.js';
import {
  LINKED_GENERATOR_VERSION,
  linkedBatches,
  linkedQuery,
  reservoir,
  type LinkedStats,
} from './generate-linked.js';
import { linksOverride, linksSupported } from './links.js';
import { createRng } from './prng.js';
import { ALL_GRANT, ALL_SCOPE } from './seed.js';
import { fileBytes } from './stats.js';

/** The default cache: `packages/bench/.cache/` (gitignored). */
export const DEFAULT_CACHE_DIR = fileURLToPath(new URL('../.cache/', import.meta.url));

/** Measured queries kept per store; runs draw their samples from these. */
const QUERY_POOL = 2000;
/** Warm-up recalls (design section 11: enough co-recalls for pairs to exist). */
export const DEFAULT_WARM_UP = 500;

export interface WarmUpRecord {
  queries: number;
  ms: number;
  /** `recordAccess` calls the warm-up made, and the ids they recorded. */
  accessCalls: number;
  accessIds: number;
  /** Learned `recalledWith` pair rows after the warm-up; null when the store has no link table. */
  pairs: number | null;
  /** Whether recall followed and learned links during the warm-up (`recall.links` existed). */
  links: boolean;
  schemaVersion: number;
}

export interface LinkedManifest {
  generator: number;
  count: number;
  seed: number;
  builtAt: string;
  buildMs: number;
  stats: LinkedStats;
  warmUp: WarmUpRecord;
}

export interface LinkedStore {
  dir: string;
  dbPath: string;
  store: MemoryStore;
  manifest: LinkedManifest;
  /** Measured query texts, disjoint from the warm-up's. */
  queries: string[];
  /** The dense index the store searches (`binary` past 100,000 vectors, as `auto` builds it). */
  vectorIndex: ReturnType<typeof sqliteVectorIndex>;
  /** SQLite file plus WAL, in bytes. */
  bytes: number;
  /** True when this call built the store (or re-ran its warm-up) rather than reuse it. */
  built: boolean;
  close(): Promise<void>;
}

export interface OpenLinkedOptions {
  count: number;
  seed?: number;
  cacheDir?: string;
  /** Delete any cached store and build it again. */
  rebuild?: boolean;
  warmUp?: number;
  log?: (message: string) => void;
}

export const storeDirName = (count: number, seed: number): string =>
  `linked-${count}-s${seed}-g${LINKED_GENERATOR_VERSION}`;

function readManifest(dir: string): LinkedManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as LinkedManifest;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const open = (dir: string): Promise<MemoryStore> =>
  openSqliteStore({
    path: path.join(dir, 'oort.sqlite'),
    coldDir: path.join(dir, 'cold'),
    dimension: EMBEDDING_DIMENSION,
    log: () => {},
  });

/** The config the bench recalls with: defaults, from an empty home inside the cache. */
export function benchConfig(dir: string): ResolvedConfig {
  return resolveConfig(dir, { OORT_HOME: dir }, { projectConfig: false });
}

/** Learned pair rows, when the store has a link table (schema version 8, CON-148). */
function countPairs(dbPath: string): number | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const table = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_links'",
      )
      .get();
    if (table === undefined) return null;
    return (
      db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM memory_links WHERE kind = 'recalledWith'",
        )
        .get()?.n ?? 0
    );
  } finally {
    db.close();
  }
}

/**
 * Runs the warm-up on the live (unfrozen) store: `queries` recalls on the fast path, access
 * recording on, links on when this build has them.
 */
export async function warmUpStore(
  store: MemoryStore,
  dbPath: string,
  queries: string[],
  config: ResolvedConfig,
): Promise<WarmUpRecord> {
  const links = linksSupported(config);
  const warmConfig = {
    ...config,
    recall: { ...config.recall, ...(links ? linksOverride('all', config) : {}) },
  } as ResolvedConfig;
  let accessCalls = 0;
  let accessIds = 0;
  // Counted, not stubbed: the warm-up is the one place the bench lets recall write.
  const counting: MemoryStore = {
    ...store,
    recordAccess: async (...args: Parameters<MemoryStore['recordAccess']>) => {
      accessCalls++;
      accessIds += args[1].length;
      return store.recordAccess(...args);
    },
  };
  const embed = fakeEmbedder(EMBEDDING_DIMENSION);
  const t = performance.now();
  for (const text of queries) {
    await recall(
      { text, scope: ALL_SCOPE },
      { store: counting, config: warmConfig, embed, now: GENERATOR_NOW },
    );
  }
  return {
    queries: queries.length,
    ms: performance.now() - t,
    accessCalls,
    accessIds,
    pairs: countPairs(dbPath),
    links,
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * Opens the cached link-shaped store for `(count, seed)`, building it first when there is none
 * (or `rebuild`), and re-running the warm-up when the code's schema version or links capability
 * changed since it last ran.
 */
export async function openLinkedStore(opts: OpenLinkedOptions): Promise<LinkedStore> {
  const seed = opts.seed ?? 42;
  const log = opts.log ?? (() => {});
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const dir = path.join(cacheDir, storeDirName(opts.count, seed));
  const dbPath = path.join(dir, 'oort.sqlite');
  const queriesFile = path.join(dir, 'queries.json');
  const warmCount = opts.warmUp ?? DEFAULT_WARM_UP;
  let manifest = opts.rebuild === true ? undefined : readManifest(dir);
  if (
    manifest !== undefined &&
    (manifest.generator !== LINKED_GENERATOR_VERSION ||
      manifest.count !== opts.count ||
      manifest.seed !== seed)
  ) {
    manifest = undefined;
  }
  let built = false;
  const config = benchConfig(dir);
  if (manifest === undefined) {
    built = true;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    log(`building ${opts.count} link-shaped memories in ${dir} (cached for later runs)`);
    const t = performance.now();
    const sample = reservoir(QUERY_POOL * 2, seed);
    let stats: LinkedStats | undefined;
    let store = await open(dir);
    try {
      let seeded = 0;
      let lastLog = performance.now();
      for (const batch of linkedBatches(opts.count, seed, 1000, { onStats: (s) => (stats = s) })) {
        await store.upsertMany(ALL_GRANT, batch);
        sample.offer(batch);
        seeded += batch.length;
        if (performance.now() - lastLog > 30_000) {
          log(`  seeded ${seeded} of ${opts.count}`);
          lastLog = performance.now();
        }
      }
    } finally {
      await store.close();
    }
    // Queries: the first half of a shuffled sample is measured, the second half warms up.
    const rng = createRng(seed + 7);
    const picked = rng.shuffle(sample.sample());
    const half = Math.min(QUERY_POOL, Math.floor(picked.length / 2));
    const measured = picked.slice(0, half).map((m) => linkedQuery(m, rng));
    const warm = picked.slice(half).map((m) => linkedQuery(m, rng));
    writeJson(queriesFile, { measured, warmUp: warm });
    // Reopened as a person's store would be, so the dense index `auto` builds is in place.
    log('reopening (builds the binary vector index past 100,000 vectors), then the warm-up');
    store = await open(dir);
    try {
      const warmUp = await warmUpStore(store, dbPath, warm.slice(0, warmCount), config);
      manifest = {
        generator: LINKED_GENERATOR_VERSION,
        count: opts.count,
        seed,
        builtAt: new Date().toISOString(),
        buildMs: performance.now() - t,
        stats: stats as LinkedStats,
        warmUp,
      };
    } finally {
      await store.close();
    }
    writeJson(path.join(dir, 'manifest.json'), manifest);
  }
  const { measured, warmUp: warmQueries } = JSON.parse(fs.readFileSync(queriesFile, 'utf8')) as {
    measured: string[];
    warmUp: string[];
  };
  const store = await open(dir);
  const stale =
    manifest.warmUp.schemaVersion !== SCHEMA_VERSION ||
    manifest.warmUp.links !== linksSupported(config);
  if (stale) {
    // The store was opened (and migrated) by newer code: learn again with what it can now do.
    log('schema version or links capability changed since the warm-up: running it again');
    built = true;
    manifest = {
      ...manifest,
      warmUp: await warmUpStore(store, dbPath, warmQueries.slice(0, warmCount), config),
    };
    writeJson(path.join(dir, 'manifest.json'), manifest);
  }
  return {
    dir,
    dbPath,
    store,
    manifest,
    queries: measured,
    vectorIndex: sqliteVectorIndex(dbPath),
    bytes: fileBytes(dbPath) + fileBytes(`${dbPath}-wal`),
    built,
    close: () => store.close(),
  };
}
