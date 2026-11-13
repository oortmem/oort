import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Statement } from 'better-sqlite3';
import {
  appendAccess,
  assertGrant,
  canonicalMemory,
  checkPlace,
  cursorKey,
  ABOUT_PER_ENTITY,
  aboutWeight,
  combineWeights,
  entityKeys,
  EPISODE_PER_SEED,
  EPISODE_RAW_SCAN,
  EPISODE_REACH,
  episodeSession,
  episodeWeight,
  EXPLICIT_PER_SEED,
  EXPLICIT_RAW_SCAN,
  F_MAX_DEFAULT,
  NEIGHBOUR_KINDS,
  rawScanLimit,
  frameOf,
  hasSpatialFilter,
  nearBox,
  placeBox,
  placeDistance,
  GrantError,
  grantReads,
  grantWrites,
  inLinkIndexes,
  isCurrent,
  isZeroVector,
  nodeKey,
  nodeOf,
  resolveAddressing,
  sameRecordAddress,
  scopeOf,
  lexicalIcuVersion,
  tokenizeLexical,
  type AccessLog,
  type Address,
  type Author,
  type Grant,
  type GuardedWriteResult,
  type Hit,
  type Judgment,
  type Level,
  type LinkOptions,
  type LinkResult,
  type LinksOf,
  type Neighbour,
  type NeighbourOptions,
  type NeighboursResult,
  type StoredLink,
  type UnlinkResult,
  type Memory,
  type MemorySource,
  type MemoryStore,
  type NodePattern,
  type Place,
  type Provenance,
  type SpatialFilter,
  type Tier,
} from '@oortmem/core';
import {
  chmodIfExists,
  openBlobDir,
  prepareDbDir,
  withCleanupFailures,
  withPrivateUmask,
} from './blobs.js';
import { ColdBlobCorruptError, createColdCodec } from './cold.js';
import { backupDatabase, sweepStaleCopies } from './backup.js';
import { BINARY_OVERSAMPLE, binaryCode } from './binary.js';
import type { RabitqEngineChoice } from './rabitq.js';
import {
  continueRabitqBuild,
  RabitqReader,
  rabitqBuilding,
  rabitqBuiltFrom,
  rabitqNeedsRecentre,
  rabitqVectors,
  rabitqWriter,
  startRabitqBuild,
  RQ_VEC_TABLE,
  hasRabitqIndex,
  type RescoredRow,
} from './rabitq-store.js';
import {
  ERASE_AUTO_MAX_BYTES,
  eraseOldText,
  markOldTextErased,
  oldTextErased,
  storeBytes,
  zeroVectorCount,
} from './erase.js';
import {
  applySchema,
  assertMigratable,
  binaryIndexPlan,
  BIT_TABLE,
  defineWriterGuard,
  downgradeSchema,
  ENTITY_TABLE,
  FTS_TABLE,
  NODE_TABLE,
  LINK_TABLE,
  linkRowsError,
  linkRowsKept,
  nodeIdOf,
  nodeKeyOfColumns,
  hasBinaryIndex,
  lexicalIndexState,
  judgmentCount,
  migrationBlockers,
  PLACE_TABLE,
  placeCount,
  rabitqIndexPlan,
  schemaVersionOf,
  searchableVectors,
  SCHEMA_VERSION,
  StoreMigrationRequiredError,
  VECTOR_INDEXES,
  type VectorIndex,
} from './schema.js';

export {
  BIT_TABLE,
  FTS_TABLE,
  FTS_TOKENIZE,
  FTS_TOKENIZE_V1,
  SCHEMA_VERSION,
  StoreMigrationRequiredError,
  WRITER_GUARD,
  VECTOR_INDEXES,
  type VectorIndex,
} from './schema.js';
export {
  RABITQ_EPSILON,
  RABITQ_QUERY_BITS,
  loadNativeRabitq,
  nativePlatformTag,
  TsRabitqIndex,
  type RabitqEngine,
  type RabitqEngineChoice,
} from './rabitq.js';
export { RQ_TABLE, RQ_VEC_TABLE, RQ_GONE_TABLE, RQ_META_TABLE } from './rabitq-store.js';
export { BINARY_AUTO_THRESHOLD, BINARY_OVERSAMPLE } from './binary.js';
export { ERASE_AUTO_MAX_BYTES } from './erase.js';
export { BACKUPS_KEPT, listBackups, type BackupKind } from './backup.js';
export {
  readEmbedderBinding,
  reembedSqliteStore,
  writeEmbedderBinding,
  type EmbedderBinding,
  type ReembedOptions,
  type ReembedResult,
} from './embedder.js';

export {
  ColdBlobCorruptError,
  createColdCodec,
  type ColdCodec,
  type ColdCodecOptions,
} from './cold.js';

export interface SqliteStoreOptions {
  /**
   * The SQLite database file. A missing directory is created owner-only; an
   * existing one is left as is (with a warning when group or others can read it).
   */
  path: string;
  /** Directory for cold blobs; created owner-only, or tightened to 0700. */
  coldDir: string;
  /** Embedding dimension. Fixed at first open; a later open with another value is refused. */
  dimension: number;
  /**
   * ACT-R decay used when folding access logs in `recordAccess`; pass the same
   * `d` the engine's activation uses. Defaults to 0.5.
   */
  d?: number;
  /** Clock for `list`'s validity filter; defaults to `new Date()`. */
  now?: () => Date;
  /**
   * How long a write (and the open, which checks the schema in a write
   * transaction) waits for another connection's write lock before failing
   * with `SQLITE_BUSY`. Defaults to 5000. The wait is synchronous and blocks
   * the event loop, so latency-bound callers (hooks) pass a short one.
   */
  busyTimeoutMs?: number;
  /**
   * false: never migrate. Opening a store at an older schema version then
   * rejects with `StoreMigrationRequiredError` and changes nothing. For
   * latency-bound callers (hooks), which must not hold the store for a
   * migration. Default true: an older store is copied to
   * `<path>.pre-v<version>.<UTC time>` (see `listBackups`) and then migrated in
   * one transaction; if the copy fails, the open fails and nothing changes. A
   * version 4 store is migrated without a copy (version 5 only adds).
   */
  migrate?: boolean;
  /**
   * One-line maintenance notices (orphan sweeps, permissions, corrupt cold
   * blobs). They carry counts, directory paths or memory ids, never memory
   * content. Defaults to stderr.
   */
  log?: (message: string) => void;
  /**
   * The runtime's ICU version, for the lexical index's drift guard. Default
   * `lexicalIcuVersion()` (`process.versions.icu`); for runtimes that report it some other way.
   */
  icu?: string;
  /**
   * How dense search scans the hot and warm vectors (0.9.0 or newer; design
   * `docs/design/2026-11-11-binary-quantization.md`):
   *
   * - `auto` (default): an exact int8 scan, until the store holds `binaryAutoThreshold`
   *   searchable vectors; from then on the binary index, which an open that may migrate builds
   *   once and keeps.
   * - `binary`: the binary index from the start: 1-bit codes are scanned, and the
   *   `BINARY_OVERSAMPLE` × k nearest are rescored with their int8 vectors.
   * - `rabitq` (CON-25, design `docs/design/2026-11-12-rabitq-index.md`): the RaBitQ index from
   *   the start: 1-bit codes with per-vector error bounds, scanned in memory against a 4-bit
   *   query (natively when the prebuilt binary loads, else in TypeScript), and only the
   *   candidates whose bound reaches the k-th exact score are rescored with their int8 vectors.
   * - `int8`: always the exact int8 scan; an open that may migrate drops either index.
   *
   * An open that may migrate keeps one index at most: `binary` drops a RaBitQ index and `rabitq`
   * a binary one; `auto` keeps a RaBitQ index and never builds one. Scores are int8 cosine
   * similarities whichever answers. An open with `migrate: false` never builds or drops an index;
   * it searches with whatever the store has.
   */
  vectorIndex?: VectorIndex;
  /** `vectorIndex: 'auto'` builds the binary index at this many searchable vectors (default 100,000). */
  binaryAutoThreshold?: number;
  /**
   * The one-time erase of text deleted by Oort 0.9.0 or older (CON-140; `erase.ts`): `auto` (default) runs
   * it on an open that may migrate when the file is at most `ERASE_AUTO_MAX_BYTES`; `now` runs it
   * whatever the size (`oort doctor --vacuum`). An open with `migrate: false` never runs it.
   */
  eraseOldText?: 'auto' | 'now';
  /**
   * Which engine searches a RaBitQ index: `auto` (default) the native one when its prebuilt
   * binary loads on this platform, else the TypeScript one (same results, slower; logged once);
   * `native` fails the first dense search without it; `typescript` never loads it.
   */
  rabitqEngine?: RabitqEngineChoice;
  /**
   * Called once per dense query pattern with which index answered and, for the binary and
   * RaBitQ indexes, how many int8 vectors were read to rescore candidates. For benchmarks.
   */
  onDenseStats?: (stats: DenseStats) => void;
  /**
   * The most vectors this handle loads into a RaBitQ engine. Past it, the handle's dense search
   * scans the int8 vectors exactly instead (a store with a RaBitQ index has no binary one). For
   * short-lived processes, the in-process hooks: loading a million codes takes seconds and a few
   * hundred MB, which a long-lived process pays once. Default: no limit.
   */
  rabitqMaxLoad?: number;
  /**
   * How often a handle whose RaBitQ engine is loaded brings it up to date with other processes'
   * writes without waiting for a dense query, so a forget elsewhere leaves its memory too
   * (default 30,000 ms).
   */
  rabitqRefreshMs?: number;
  /**
   * The most RaBitQ build batches (`RABITQ_BUILD_BATCH` vectors each) this open commits when it
   * finds a build under way, before it returns. Long-lived processes that a host starts with a
   * deadline (the MCP server, the SDK) pass a small number, and the rest is left to the next
   * `oort` command or `oort reindex`; dense search scans int8 meanwhile. Default: finish it.
   */
  rabitqBuildBatches?: number;
  /** Called after each refresh of a loaded RaBitQ engine with its size. For tests and monitoring. */
  onRabitqRefresh?: (stats: { vectors: number }) => void;
}

/** What one dense query pattern cost (`onDenseStats`). */
export interface DenseStats {
  index: 'int8' | 'binary' | 'rabitq';
  /** RaBitQ: candidates whose bound reached the k-th; binary: the oversampled KNN's k. */
  candidates: number;
  /** int8 vectors read to rescore (0 for the exact scan). */
  reads: number;
  /** RaBitQ only: the read budget stopped the rescoring before the error bound did. */
  capped?: boolean;
}

/**
 * How long an open that rebuilds the lexical index (a migration) waits for another connection's
 * write lock, whatever `busyTimeoutMs` says: it runs once, and failing it would only repeat it.
 */
export const MIGRATION_BUSY_TIMEOUT_MS = 60_000;

/**
 * Switches a connection to WAL, waiting up to `timeoutMs` for other connections. Two processes
 * opening a brand-new database at once (a hook and the daemon on first run) both need every
 * other connection out to switch it, and SQLite reports SQLITE_BUSY for that at once, without
 * the busy timeout, since waiting could deadlock. So this retries, backing off up to 100 ms. A
 * database already in WAL switches without a lock, on the first try.
 */
function enableWal(conn: Database.Database, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    let mode: unknown;
    try {
      mode = conn.pragma('journal_mode = WAL', { simple: true });
    } catch (e) {
      if (
        !String((e as { code?: unknown }).code).startsWith('SQLITE_BUSY') ||
        Date.now() >= deadline
      ) {
        throw e;
      }
    }
    if (mode === 'wal') return;
    if (mode !== undefined && Date.now() >= deadline) {
      throw new Error(
        `sqlite store: could not switch ${conn.name} to WAL (it stayed ${String(mode)})`,
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  }
}

/** The copy taken before migrating a store from each older schema version. */
const BACKUP_BEFORE = { 1: 'pre-v2', 2: 'pre-v3', 3: 'pre-v4', 4: 'pre-v5' } as const;

/** sqlite-vec's upper bound on `k` in a KNN query. */
const MAX_KNN = 4096;

interface MemoryRow {
  rid: number;
  id: string;
  level: Level;
  org_id: string;
  customer_id: string | null;
  agent_id: string | null;
  hive_id: string | null;
  run_id: string | null;
  project_id: string | null;
  scope_extra: string | null;
  author_agent_id: string;
  author_account_ref: string | null;
  provenance: string | null;
  type: Memory['type'];
  text: string;
  stub: string;
  entities: string;
  salience: number;
  pinned: number;
  tier: Tier;
  access_log: string;
  valid_from: string;
  valid_to: string | null;
  expired_at: string | null;
  end_reason: Memory['endReason'];
  last_confirmed_at: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  /** The `judgment` record as JSON (schema version 3, CON-71); NULL for every other memory. */
  judgment: string | null;
  /** The memory's place as JSON (schema version 5, CON-84); NULL when it has none. */
  place: string | null;
  /** The place's `nodeId`, for `within`; NULL when it has none. */
  place_node: string | null;
  /** `source.sessionId` (schema version 8, CON-148); NULL without one, and at level `hive`. */
  session_id?: string | null;
  /** The memory's place in its session; NULL with no `session_id`. */
  episode_seq?: number | null;
}

type RowParams = Omit<MemoryRow, 'rid'>;

/** An FTS5 query matching any token, each quoted as a phrase so no input is parsed as syntax. */
function matchQuery(q: string): string | null {
  const unique = [...new Set(tokenizeLexical(q))];
  if (unique.length === 0) return null;
  return unique.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
}

function indexed(text: string): string {
  return tokenizeLexical(text).join(' ');
}

/** vec0 metadata cannot be NULL, so global (no project) gets its own key. */
function projectKey(projectId: string | null | undefined): string {
  return projectId === null || projectId === undefined ? 'g' : `p:${projectId}`;
}

function toBytes(v: Int8Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** The address columns of `a`: each level fills only its own fields (the table's CHECK). */
function addressColumns(a: Address) {
  const x = a as Partial<Record<'customerId' | 'agentId' | 'hiveId' | 'runId', string>>;
  return {
    level: a.level,
    org_id: a.orgId,
    customer_id: x.customerId ?? null,
    agent_id: x.agentId ?? null,
    hive_id: x.hiveId ?? null,
    run_id: x.runId ?? null,
  };
}

/** `m` (as `canonicalMemory` returns it) as a row, at `address`, written by `author`. */
function toRow(m: Memory, address: Address, author: Author): RowParams {
  const { orgId: _o, customerId: _c, agentId: _a, projectId: _p, ...extra } = m.scope;
  return {
    id: m.id,
    ...addressColumns(address),
    project_id: address.projectId ?? null,
    scope_extra: Object.keys(extra).length === 0 ? null : JSON.stringify(extra),
    author_agent_id: author.agentId,
    author_account_ref: author.accountRef ?? null,
    provenance:
      m.provenance === undefined || m.provenance === null ? null : JSON.stringify(m.provenance),
    type: m.type,
    text: m.text,
    stub: m.stub,
    entities: JSON.stringify(m.entities),
    salience: m.salience,
    pinned: m.pinned ? 1 : 0,
    tier: m.tier,
    access_log: JSON.stringify(m.accessLog),
    valid_from: m.validFrom,
    valid_to: m.validTo,
    expired_at: m.expiredAt,
    end_reason: m.endReason,
    last_confirmed_at: m.lastConfirmedAt,
    supersedes: m.supersedes,
    superseded_by: m.supersededBy,
    source: JSON.stringify(m.source),
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    judgment: m.judgment === undefined ? null : JSON.stringify(m.judgment),
    place: m.place === undefined ? null : JSON.stringify(m.place),
    place_node: m.place?.nodeId ?? null,
  };
}

function addressOfRow(r: MemoryRow): Address {
  const a: Record<string, string> = { level: r.level, orgId: r.org_id };
  if (r.customer_id !== null) a['customerId'] = r.customer_id;
  if (r.agent_id !== null) a['agentId'] = r.agent_id;
  if (r.hive_id !== null) a['hiveId'] = r.hive_id;
  if (r.run_id !== null) a['runId'] = r.run_id;
  if (r.project_id !== null) a['projectId'] = r.project_id;
  return a as unknown as Address;
}

/** The record as stores return it: `address`, `author` and `provenance` only where needed. */
function fromRow(r: MemoryRow, embedding: Int8Array | undefined): Memory {
  const address = addressOfRow(r);
  const author: Author =
    r.author_account_ref === null
      ? { agentId: r.author_agent_id }
      : { agentId: r.author_agent_id, accountRef: r.author_account_ref };
  const scope = {
    ...scopeOf(address, author),
    ...(r.scope_extra !== null && (JSON.parse(r.scope_extra) as object)),
  };
  const m: Memory = {
    id: r.id,
    scope,
    ...(address.level !== 'user' && { address }),
    ...((author.accountRef !== undefined || author.agentId !== scope.agentId) && { author }),
    ...(r.provenance !== null && { provenance: JSON.parse(r.provenance) as Provenance }),
    type: r.type,
    text: r.text,
    stub: r.stub,
    entities: JSON.parse(r.entities) as string[],
    salience: r.salience,
    pinned: r.pinned !== 0,
    tier: r.tier,
    accessLog: JSON.parse(r.access_log) as AccessLog,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    expiredAt: r.expired_at,
    endReason: r.end_reason,
    lastConfirmedAt: r.last_confirmed_at,
    supersedes: r.supersedes,
    supersededBy: r.superseded_by,
    source: JSON.parse(r.source) as MemorySource,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.judgment !== null) m.judgment = JSON.parse(r.judgment) as Judgment;
  if (r.place !== null) {
    // Checked as a write is: a place from a crafted or damaged copy reads back as none.
    try {
      m.place = checkPlace(JSON.parse(r.place));
    } catch {
      /* dropped */
    }
  }
  if (embedding !== undefined) m.embedding = embedding;
  return m;
}

const COLUMNS: (keyof RowParams)[] = [
  'id',
  'level',
  'org_id',
  'customer_id',
  'agent_id',
  'hive_id',
  'run_id',
  'project_id',
  'scope_extra',
  'author_agent_id',
  'author_account_ref',
  'provenance',
  'type',
  'text',
  'stub',
  'entities',
  'salience',
  'pinned',
  'tier',
  'access_log',
  'valid_from',
  'valid_to',
  'expired_at',
  'end_reason',
  'last_confirmed_at',
  'supersedes',
  'superseded_by',
  'source',
  'created_at',
  'updated_at',
  'judgment',
  'place',
  'place_node',
];

/**
 * The spatial filter (CON-84) over `memories` aliased `a`, bound with `spatialParams`. `within`
 * matches whole segments (`instr`, no wildcards); `near` takes the R*Tree's candidate boxes, then
 * the exact distance from the stored place (`oort_place_distance`).
 */
function spatialSql(f: SpatialFilter, a: string): string {
  const parts: string[] = [];
  if (f.within !== undefined) {
    parts.push(`instr('/' || ${a}.place_node || '/', '/' || @within || '/') > 0`);
  }
  if (f.near !== undefined) {
    parts.push(`${a}.rid IN (SELECT rid FROM ${PLACE_TABLE}
        WHERE max_x >= @minX AND min_x <= @maxX AND max_y >= @minY AND min_y <= @maxY
          AND max_z >= @minZ AND min_z <= @maxZ AND map_key = @mapKey)
      AND oort_place_distance(${a}.place, @nearMap, @nearFrame, @nearX, @nearY, @nearZ) <= @radius`);
  }
  return parts.join(' AND ');
}

/** The statement-cache key of a spatial filter's shape. */
const spatialShape = (f: SpatialFilter | undefined): string =>
  f === undefined ? '' : `:${f.within !== undefined ? 'w' : ''}${f.near !== undefined ? 'n' : ''}`;

function spatialParams(f: SpatialFilter): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  if (f.within !== undefined) out['within'] = f.within;
  const n = f.near;
  if (n !== undefined) {
    const b = nearBox(n);
    Object.assign(out, {
      minX: b.minX,
      maxX: b.maxX,
      minY: b.minY,
      maxY: b.maxY,
      minZ: b.minZ,
      maxZ: b.maxZ,
      mapKey: b.mapKey,
      nearMap: n.mapId,
      nearFrame: frameOf(n),
      nearX: n.pose.x,
      nearY: n.pose.y,
      nearZ: n.pose.z ?? null,
      radius: n.radius,
    });
  }
  return out;
}

/**
 * The predicate for pattern `i` of a grant side over `memories` aliased `m`:
 * the node matches column by column (`IS`, so an absent field matches only
 * NULL), then the project list, then the author when the pattern names one.
 * Bound with `patternParams`.
 */
function patternSql(i: number): string {
  return `(m.level = @l${i} AND m.org_id = @o${i} AND m.customer_id IS @c${i}
    AND m.agent_id IS @a${i} AND m.hive_id IS @h${i} AND m.run_id IS @r${i}
    AND (@all${i} OR m.project_id IN (SELECT value FROM json_each(@p${i}))
      OR (@g${i} AND m.project_id IS NULL))
    AND (@au${i} IS NULL OR m.author_agent_id = @au${i}))`;
}

/** A grant side of `n` patterns as one predicate (any pattern covers). */
function grantSql(n: number): string {
  return `(${Array.from({ length: n }, (_, i) => patternSql(i)).join(' OR ')})`;
}

function patternParams(p: NodePattern, i: number): Record<string, string | number | null> {
  const ids = p.projectIds === 'all' ? [] : p.projectIds;
  const node = addressColumns(p.node as Address);
  return {
    [`l${i}`]: node.level,
    [`o${i}`]: node.org_id,
    [`c${i}`]: node.customer_id,
    [`a${i}`]: node.agent_id,
    [`h${i}`]: node.hive_id,
    [`r${i}`]: node.run_id,
    [`all${i}`]: p.projectIds === 'all' ? 1 : 0,
    [`p${i}`]: JSON.stringify(ids.filter((x): x is string => x !== null)),
    [`g${i}`]: p.projectIds === 'all' || ids.includes(null) ? 1 : 0,
    [`au${i}`]: p.authorAgentId ?? null,
  };
}

function grantParams(patterns: readonly NodePattern[]): Record<string, string | number | null> {
  return Object.assign({}, ...patterns.map((p, i) => patternParams(p, i)));
}

/** Patterns that can match something (a project list that is not empty). */
function live(patterns: readonly NodePattern[]): NodePattern[] {
  return patterns.filter((p) => p.projectIds === 'all' || p.projectIds.length > 0);
}

/**
 * Which dense index the store at `dbPath` searches with, and how many vectors it searches (the
 * hot and warm memories' vectors), read without changing it: undefined when there is no store yet.
 */
export function sqliteVectorIndex(dbPath: string):
  | {
      index: 'int8' | 'binary' | 'rabitq';
      vectors: number;
      /** RaBitQ: a build is under way (the next `oort` command goes on with it). */
      building?: true;
      /** RaBitQ: the store has outgrown the centroid (`oort reindex` recentres it). */
      recentreDue?: true;
      /** With `recentreDue`: how many vectors the index was built from. */
      builtFrom?: number;
    }
  | undefined {
  if (!fs.existsSync(dbPath)) return undefined;
  const db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
  try {
    if (schemaVersionOf(db) === undefined) return undefined;
    if (hasRabitqIndex(db)) {
      const building = rabitqBuilding(db);
      return {
        index: 'rabitq',
        vectors: rabitqVectors(db),
        ...(building && { building: true as const }),
        ...(!building &&
          rabitqNeedsRecentre(db) && {
            recentreDue: true as const,
            builtFrom: rabitqBuiltFrom(db),
          }),
      };
    }
    if (!hasBinaryIndex(db)) return { index: 'int8', vectors: searchableVectors(db) };
    const n = db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${BIT_TABLE}_rowids`).get();
    return { index: 'binary', vectors: n?.n ?? 0 };
  } finally {
    db.close();
  }
}

/**
 * Whether the store at `dbPath` has had the one-time erase of text deleted by Oort 0.9.0 or older
 * (CON-140), its size, and how many all-zero vectors it holds (CON-141), read without changing
 * it: undefined when there is no store yet.
 */
export function sqliteEraseState(
  dbPath: string,
): { erased: boolean; bytes: number; zeroVectors: number } | undefined {
  if (!fs.existsSync(dbPath)) return undefined;
  const db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
  try {
    if (schemaVersionOf(db) === undefined) return undefined;
    sqliteVec.load(db);
    const dim = db
      .prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'dimension'")
      .get();
    return {
      erased: oldTextErased(db),
      bytes: storeBytes(path.resolve(dbPath)),
      zeroVectors: dim === undefined ? 0 : zeroVectorCount(db, Number(dim.value)),
    };
  } finally {
    db.close();
  }
}

/**
 * Runs the one-time erase of text deleted by Oort 0.9.0 or older on the store at `dbPath` now, whatever
 * its size (`oort doctor --vacuum`; CON-140). The store must be at the current schema version
 * (open it once first). False when another process holds it and `VACUUM` cannot run.
 */
export function vacuumSqliteStore(opts: { path: string; now?: Date }): boolean {
  const dbPath = path.resolve(opts.path);
  const db = withPrivateUmask(() => new Database(dbPath, { fileMustExist: true }));
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('secure_delete = ON');
    db.pragma('journal_size_limit = 0');
    sqliteVec.load(db);
    defineWriterGuard(db);
    if (schemaVersionOf(db) !== SCHEMA_VERSION) {
      throw new StoreMigrationRequiredError(dbPath, schemaVersionOf(db) ?? 0);
    }
    const dim = db
      .prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'dimension'")
      .get();
    return eraseOldText(db, Number(dim?.value ?? 0), opts.now ?? new Date());
  } finally {
    db.close();
  }
}

/**
 * Rebuilds the store's RaBitQ index from its int8 vectors with a new centroid (`oort reindex`):
 * for a store that has outgrown the centroid it was built with (`sqliteVectorIndex` says
 * `recentreDue`), whose looser bounds mean more rescoring reads. No open does this by itself: it
 * reads every vector. It first opens the store as any `oort` command does (migrating it, and
 * finishing a build under way), then starts the build again and runs it in committed batches;
 * other processes keep working meanwhile (their dense search scans int8 until it is done), and a
 * stopped run is finished by the next `oort` command. A store without a RaBitQ index is left as
 * it is (`rebuilt: false`).
 */
export async function reindexSqliteStore(opts: {
  path: string;
  coldDir: string;
  dimension: number;
  vectorIndex?: VectorIndex;
  log?: (message: string) => void;
  onProgress?: (p: { done: number; total: number }) => void;
}): Promise<{ index: 'int8' | 'binary' | 'rabitq'; vectors: number; rebuilt: boolean }> {
  // A build that was stopped (or left to the CLI by an MCP server) is finished by the open
  // below, with the centroid it started with: that is the rebuild, not a reason for another.
  const stopped = fs.existsSync(opts.path) && sqliteVectorIndex(opts.path)?.building === true;
  await (
    await openSqliteStore({
      path: opts.path,
      coldDir: opts.coldDir,
      dimension: opts.dimension,
      ...(opts.vectorIndex !== undefined && { vectorIndex: opts.vectorIndex }),
      ...(opts.log !== undefined && { log: opts.log }),
    })
  ).close();
  const db = new Database(path.resolve(opts.path), { fileMustExist: true });
  let rebuilt = false;
  try {
    db.pragma(`busy_timeout = ${MIGRATION_BUSY_TIMEOUT_MS}`);
    sqliteVec.load(db);
    defineWriterGuard(db);
    if (stopped && hasRabitqIndex(db)) {
      rebuilt = true;
    } else if (hasRabitqIndex(db)) {
      db.transaction(() => startRabitqBuild(db, opts.dimension)).immediate();
      continueRabitqBuild(db, opts.dimension, {
        ...(opts.log !== undefined && { log: opts.log }),
        ...(opts.onProgress !== undefined && { onProgress: opts.onProgress }),
      });
      rebuilt = true;
    }
  } finally {
    db.close();
  }
  const v = sqliteVectorIndex(opts.path) ?? { index: 'int8' as const, vectors: 0 };
  return { index: v.index, vectors: v.vectors, rebuilt };
}

/**
 * The schema version of the store at `dbPath`, read without changing it:
 * undefined when there is no store (or an empty one) yet.
 */
export function sqliteSchemaVersion(dbPath: string): number | undefined {
  if (!fs.existsSync(dbPath)) return undefined;
  const db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
  try {
    return schemaVersionOf(db);
  } finally {
    db.close();
  }
}

/**
 * Takes the store at `path` back to schema version `to`: 1 (the default) so Oort 0.2.x can open
 * it again, 2 for Oort 0.3 to 0.5, 3 for Oort before tokeniser v2 (CON-110; the lexical index
 * is rebuilt with tokeniser v1), 4 for Oort before spatial memory (0.8.x), 5 for Oort before
 * the binary vector index (the binary index and the writer guard are dropped; the int8 vectors
 * were never moved), 6 for Oort before the RaBitQ index (it is dropped, and the version 6
 * writer guard put back), or 7 for Oort before memory links (the link schema is dropped, and the
 * version 7 guard put back). First copies it to `<path>.pre-downgrade.<UTC time>` (the three
 * newest such copies are kept). Refuses, changing nothing, when it holds memories that version
 * cannot represent: for 1, any level but Planet, an author with an account, provenance or a
 * judgment; for 2, a judgment; below 5, a place; below 8, an explicit, distilledFrom or blocked
 * link (learned `recalledWith` links are dropped). No other Oort process (hooks, the MCP server,
 * a drain) may have the store open while it runs: one would migrate it straight back, or fail on
 * the changed schema.
 */
export function downgradeSqliteStore(opts: {
  path: string;
  to?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /**
   * Delete every memory link and block (schema version 8) instead of refusing while any
   * explicit, distilledFrom or blocked row exists. The copy taken first still holds them.
   */
  dropLinks?: boolean;
}): void {
  const to = opts.to ?? 1;
  const dbPath = path.resolve(opts.path);
  const db = withPrivateUmask(() => new Database(dbPath, { fileMustExist: true }));
  try {
    sqliteVec.load(db);
    const version = schemaVersionOf(db);
    if (version === undefined || version <= to || version > SCHEMA_VERSION) {
      downgradeSchema(db, to); // at or below `to` already: nothing to do; anything else: refused
      return;
    }
    const links = opts.dropLinks === true ? 0 : linkRowsKept(db);
    if (links > 0) throw linkRowsError(links, to);
    const places = to < 5 ? placeCount(db) : 0;
    if (places > 0) {
      throw new Error(
        `sqlite store: ${places} ${places === 1 ? 'memory has a place' : 'memories have a place'}; schema version ${to} cannot hold them`,
      );
    }
    if (to === 1) {
      const blocked = migrationBlockers(db);
      if (blocked > 0) {
        throw new Error(
          `sqlite store: ${blocked} memories are not plain Planet memories; schema version 1 cannot hold them`,
        );
      }
    } else if (to === 2) {
      const n = judgmentCount(db);
      if (n > 0) {
        throw new Error(
          `sqlite store: ${n} ${n === 1 ? 'memory is a judgment' : 'memories are judgments'}; schema version 2 cannot hold them`,
        );
      }
    }
    withPrivateUmask(() => backupDatabase(db, dbPath, 'pre-downgrade'));
    downgradeSchema(db, to, { dropLinks: opts.dropLinks === true });
  } finally {
    db.close();
  }
}

/**
 * Opens (creating if needed) a SQLite-backed `MemoryStore`: rows in `memories`,
 * lexical search through FTS5, dense search through sqlite-vec (int8, cosine),
 * cold copies as zstd blobs under `coldDir`. Safe to open from several
 * processes at once (WAL, a busy timeout (5 s by default), IMMEDIATE write
 * transactions).
 * Every method is async per the contract; the work underneath is synchronous.
 */
/** Each open handle's RaBitQ refresh, keyed weakly by the handle (`weakInterval`). */
const TICKS = new WeakMap<object, () => void>();

/** Releases a handle's RaBitQ engine once the handle has been collected without `close()`. */
const DROPPED = new FinalizationRegistry<() => void>((release) => release());

/**
 * Runs `target`'s refresh (`TICKS`) every `ms`, holding `target` only weakly, and stops once it
 * has been collected: an SDK handle dropped without `close()` is not kept alive, with its engine,
 * by its own timer. Module-level, so the callback closes over nothing of the store's.
 */
function weakInterval(target: object, ms: number): ReturnType<typeof setInterval> {
  const ref = new WeakRef(target);
  const timer = setInterval(() => {
    const t = ref.deref();
    if (t === undefined) clearInterval(timer);
    else TICKS.get(t)?.();
  }, ms);
  timer.unref();
  return timer;
}

export async function openSqliteStore(opts: SqliteStoreOptions): Promise<MemoryStore> {
  const { dimension } = opts;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new RangeError(`sqlite store: dimension must be a positive integer, got ${dimension}`);
  }
  const busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError(
      `sqlite store: busyTimeoutMs must be a non-negative integer, got ${busyTimeoutMs}`,
    );
  }
  const d = opts.d ?? 0.5;
  const clock = opts.now ?? (() => new Date());
  const log = opts.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const icu = opts.icu ?? lexicalIcuVersion();
  const vectorIndex: VectorIndex = opts.vectorIndex ?? 'auto';
  if (!VECTOR_INDEXES.includes(vectorIndex)) {
    throw new RangeError(
      `sqlite store: vectorIndex must be auto, int8, binary or rabitq, got ${String(vectorIndex)}`,
    );
  }
  const rabitqEngine = opts.rabitqEngine ?? 'auto';
  if (!['auto', 'native', 'typescript'].includes(rabitqEngine)) {
    throw new RangeError(
      `sqlite store: rabitqEngine must be auto, native or typescript, got ${String(rabitqEngine)}`,
    );
  }
  const threshold = opts.binaryAutoThreshold;
  if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 0)) {
    throw new RangeError(
      `sqlite store: binaryAutoThreshold must be a non-negative integer, got ${threshold}`,
    );
  }
  const dbPath = path.resolve(opts.path);
  const coldDir = path.resolve(opts.coldDir);
  prepareDbDir(path.dirname(dbPath), log);
  const swept = sweepStaleCopies(dbPath);
  if (swept > 0) log(`oort store: removed ${swept} temporary copy file(s) a stopped backup left`);
  const blobs = openBlobDir(coldDir, log);
  if (!fs.existsSync(dbPath)) fs.closeSync(fs.openSync(dbPath, 'a', 0o600));

  let created = false;
  const db = withPrivateUmask(() => {
    const conn = new Database(dbPath);
    try {
      conn.pragma(`busy_timeout = ${busyTimeoutMs}`);
      enableWal(conn, busyTimeoutMs);
      conn.pragma('foreign_keys = ON');
      // A deleted or rewritten row is overwritten with zeros, not left in a free page (CON-140).
      conn.pragma('secure_delete = ON');
      // A WAL reset by a checkpoint is cut to nothing, not left holding old frames (CON-140).
      conn.pragma('journal_size_limit = 0');
      sqliteVec.load(conn);
      defineWriterGuard(conn);
      const from = schemaVersionOf(conn);
      created = from === undefined;
      if (from !== undefined && from >= 1 && from < SCHEMA_VERSION) {
        // Checked and copied before the migration's transaction starts; a failed
        // copy fails the open and the store stays as it was.
        if (opts.migrate === false) throw new StoreMigrationRequiredError(dbPath, from);
        if (from === 1) assertMigratable(conn);
        // Versions 5 to 6 and 6 to 7 are additive (triggers, and an index built from the int8
        // vectors) and go back down without loss: no copy of every memory, which `forget` would
        // never reach.
        if (from <= 4) backupDatabase(conn, dbPath, BACKUP_BEFORE[from as 1 | 2 | 3 | 4]);
      }
      // Every migration from version 3 or older, a stale lexical index and a binary index to
      // build rebuild something (applySchema says so): wait as long as another process holds the
      // lock rather than fail and repeat the migration later.
      // Every migration now fills the link schema from the stored rows (version 8) too.
      const rebuilds =
        opts.migrate !== false &&
        from !== undefined &&
        (from < SCHEMA_VERSION ||
          (from <= SCHEMA_VERSION &&
            (lexicalIndexState(conn, icu) === 'rebuild' ||
              binaryIndexPlan(conn, vectorIndex, opts.binaryAutoThreshold) === 'build' ||
              rabitqIndexPlan(conn, vectorIndex) === 'build' ||
              (from === SCHEMA_VERSION && rabitqBuilding(conn)))));
      if (rebuilds) {
        conn.pragma(`busy_timeout = ${Math.max(busyTimeoutMs, MIGRATION_BUSY_TIMEOUT_MS)}`);
      }
      applySchema(conn, dimension, {
        migrate: opts.migrate !== false,
        log,
        icu,
        vectorIndex,
        ...(opts.binaryAutoThreshold !== undefined && {
          binaryAutoThreshold: opts.binaryAutoThreshold,
        }),
      });
      // A RaBitQ index being built (started just now, or by an open that stopped): go on with it,
      // one committed batch at a time, so other writers wait one batch at most and a stopped
      // build keeps its progress. Hooks (`migrate: false`) leave it to the next `oort` command.
      if (opts.migrate !== false && rabitqBuilding(conn)) {
        continueRabitqBuild(conn, dimension, {
          log,
          ...(opts.rabitqBuildBatches !== undefined && { maxBatches: opts.rabitqBuildBatches }),
        });
      }
      if (rebuilds) conn.pragma(`busy_timeout = ${busyTimeoutMs}`);
      return conn;
    } catch (e) {
      conn.close();
      throw e;
    }
  });
  try {
    // CON-140: a store this version created never held text deleted without `secure_delete`.
    if (!oldTextErased(db)) {
      if (created) markOldTextErased(db, clock());
      else if (
        opts.migrate !== false &&
        (opts.eraseOldText === 'now' || storeBytes(dbPath) <= ERASE_AUTO_MAX_BYTES) &&
        !eraseOldText(db, dimension, clock())
      ) {
        log(
          'oort store: another process has the store open, so text deleted by Oort 0.9.0 or older stays until the next open',
        );
      }
    }
    if (process.platform !== 'win32') {
      for (const suffix of ['', '-wal', '-shm']) chmodIfExists(`${dbPath}${suffix}`, 0o600);
    }
    blobs.sweep(
      new Set(
        db
          .prepare<[], { path: string }>('SELECT path FROM cold_index')
          .all()
          .map((r) => r.path),
      ),
    );
  } catch (e) {
    db.close();
    throw e;
  }

  const codec = createColdCodec({ dimension });

  // The exact `near` check (CON-84): the distance from a query point to a stored place's region,
  // or NULL when they cannot be compared (no coordinates, another map or frame).
  db.function(
    'oort_place_distance',
    { deterministic: true },
    (place: unknown, mapId: unknown, frame: unknown, x: unknown, y: unknown, z: unknown) => {
      if (typeof place !== 'string') return null;
      let stored: Place;
      try {
        stored = checkPlace(JSON.parse(place));
      } catch {
        return null; // a damaged or unchecked place is near nothing; it never fails the recall
      }
      const d = placeDistance(stored, {
        mapId: String(mapId),
        frame: String(frame),
        pose: { x: Number(x), y: Number(y), ...(typeof z === 'number' && { z }) },
        radius: 0,
      });
      return d ?? null;
    },
  );

  type Params = Record<string, unknown>;

  const q = {
    upsertRow: db.prepare<[RowParams], { rid: number }>(
      `INSERT INTO memories (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})
       ON CONFLICT (id) DO UPDATE SET ${COLUMNS.filter((c) => c !== 'id')
         .map((c) => `${c} = excluded.${c}`)
         .join(', ')}
       RETURNING rid`,
    ),
    getRow: db.prepare<[string], MemoryRow>('SELECT * FROM memories WHERE id = ?'),
    deleteRow: db.prepare<[string], { rid: number }>(
      'DELETE FROM memories WHERE id = ? RETURNING rid',
    ),
    setTierRow: db.prepare<[Tier, string], Pick<MemoryRow, 'rid' | 'text' | 'stub' | 'entities'>>(
      'UPDATE memories SET tier = ? WHERE id = ? RETURNING rid, text, stub, entities',
    ),
    // Guarded writes: each applies only while the row matches the caller's snapshot.
    setTierIfUnchanged: db.prepare<
      [{ id: string; tier: Tier; updatedAt: string; was: Tier }],
      Pick<MemoryRow, 'rid' | 'text' | 'stub' | 'entities'>
    >(
      `UPDATE memories SET tier = @tier
       WHERE id = @id AND updated_at = @updatedAt AND tier = @was
       RETURNING rid, text, stub, entities`,
    ),
    expireIfUnchanged: db.prepare<
      [{ id: string; at: string; updatedAt: string; was: Tier }],
      { rid: number }
    >(
      `UPDATE memories SET expired_at = @at, end_reason = COALESCE(end_reason, 'expired')
       WHERE id = @id AND updated_at = @updatedAt AND tier = @was AND expired_at IS NULL
       RETURNING rid`,
    ),
    setAccess: db.prepare<[string, string]>('UPDATE memories SET access_log = ? WHERE id = ?'),
    placeDelete: db.prepare<[number]>(`DELETE FROM ${PLACE_TABLE} WHERE rid = ?`),
    placeInsert: db.prepare<[number, number, number, number, number, number, number, string]>(
      `INSERT INTO ${PLACE_TABLE} (rid, min_x, max_x, min_y, max_y, min_z, max_z, map_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    ftsDelete: db.prepare<[number]>(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`),
    ftsOptimize: db.prepare(`INSERT INTO ${FTS_TABLE} (${FTS_TABLE}) VALUES ('optimize')`),
    ftsInsert: db.prepare<[number, string, string, string]>(
      `INSERT INTO ${FTS_TABLE} (rowid, text, stub, entities) VALUES (?, ?, ?, ?)`,
    ),
    vecGet: db.prepare<[string], { embedding: Buffer }>(
      'SELECT embedding FROM memories_vec WHERE id = ?',
    ),
    vecDelete: db.prepare<[string]>('DELETE FROM memories_vec WHERE id = ?'),
    vecInsert: db.prepare<[string, Buffer, string, string, string, Tier]>(
      `INSERT INTO memories_vec (id, embedding, node_key, project_key, author_key, tier)
       VALUES (?, vec_int8(?), ?, ?, ?, ?)`,
    ),
    vecSetTier: db.prepare<[Tier, string]>('UPDATE memories_vec SET tier = ? WHERE id = ?'),
    coldPath: db.prepare<[string], { path: string }>('SELECT path FROM cold_index WHERE id = ?'),
    coldInsert: db.prepare<[string, string]>(
      `INSERT INTO cold_index (id, path) VALUES (?, ?)
       ON CONFLICT (id) DO UPDATE SET path = excluded.path`,
    ),
    coldDelete: db.prepare<[string], { path: string }>(
      'DELETE FROM cold_index WHERE id = ? RETURNING path',
    ),
    getCursor: db.prepare<[string], { value: string }>('SELECT value FROM cursors WHERE key = ?'),
    setCursor: db.prepare<[string, string]>(
      `INSERT INTO cursors (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ),
    // Memory relationships (schema version 8, CON-148).
    entityDelete: db.prepare<[number]>(`DELETE FROM ${ENTITY_TABLE} WHERE memory_rid = ?`),
    entityInsert: db.prepare<[number, string, number]>(
      `INSERT OR IGNORE INTO ${ENTITY_TABLE} (node_id, entity_key, memory_rid) VALUES (?, ?, ?)`,
    ),
    setEpisode: db.prepare<[string | null, number | null, number]>(
      'UPDATE memories SET session_id = ?, episode_seq = ? WHERE rid = ?',
    ),
    /** The position of another fact of the same turn in the same node and session. */
    turnSeq: db.prepare<[Params], { seq: number }>(
      `SELECT episode_seq AS seq FROM memories
       WHERE session_id = @session AND rid != @rid AND episode_seq IS NOT NULL
         AND level = @level AND org_id = @org AND customer_id IS @customer AND agent_id IS @agent
         AND hive_id IS @hive AND run_id IS @run
         AND json_type(source, '$.turnRef') = 'text' AND json_extract(source, '$.turnRef') = @turn
       LIMIT 1`,
    ),
    /** The next position in a node's session. */
    nextSeq: db.prepare<[Params], { seq: number }>(
      `SELECT coalesce(max(episode_seq), 0) + 1 AS seq FROM memories
       WHERE session_id = @session AND rid != @rid
         AND level = @level AND org_id = @org AND customer_id IS @customer AND agent_id IS @agent
         AND hive_id IS @hive AND run_id IS @run`,
    ),
    nodeHasMemory: db.prepare<[Params], { x: number }>(
      `SELECT 1 AS x FROM memories
       WHERE level = @level AND org_id = @org AND customer_id IS @customer AND agent_id IS @agent
         AND hive_id IS @hive AND run_id IS @run LIMIT 1`,
    ),
    nodeDelete: db.prepare<[string]>(`DELETE FROM ${NODE_TABLE} WHERE node_key = ?`),
    linkGet: db.prepare<[string, number, number], { asserted_by: 'user' | 'agent' | null }>(
      `SELECT asserted_by FROM ${LINK_TABLE} WHERE kind = ? AND a_rid = ? AND b_rid = ?`,
    ),
    linkDelete: db.prepare<[string, number, number]>(
      `DELETE FROM ${LINK_TABLE} WHERE kind = ? AND a_rid = ? AND b_rid = ?`,
    ),
    linkInsert: db.prepare<
      [
        {
          kind: string;
          node: number;
          a: number;
          b: number;
          by: 'user' | 'agent';
          agent: string;
          at: string;
        },
      ]
    >(
      `INSERT INTO ${LINK_TABLE} (kind, node_id, a_rid, b_rid, asserted_by, agent_id, created_at)
       VALUES (@kind, @node, @a, @b, @by, @agent, @at)
       ON CONFLICT (kind, a_rid, b_rid) DO NOTHING`,
    ),
    linkAssertUser: db.prepare<[string, number, number]>(
      `UPDATE ${LINK_TABLE} SET asserted_by = 'user', agent_id = ?
       WHERE kind = 'explicit' AND a_rid = ? AND b_rid = ?`,
    ),
    /** Whether two memories share an entity in the index (an `about` pair). */
    sharesEntity: db.prepare<[number, number], { x: number }>(
      `SELECT 1 AS x FROM ${ENTITY_TABLE} e
       JOIN ${ENTITY_TABLE} f ON f.node_id = e.node_id AND f.entity_key = e.entity_key
         AND f.memory_rid = ?
       WHERE e.memory_rid = ? LIMIT 1`,
    ),
    /** Whether two memories (of one node) share a session (an `episode` pair). */
    sharesSession: db.prepare<[number, number], { x: number }>(
      `SELECT 1 AS x FROM memories a JOIN memories b ON b.rid = ?
       WHERE a.rid = ? AND a.session_id IS NOT NULL AND a.session_id = b.session_id`,
    ),
  };

  /**
   * Statements whose grant predicate depends on how many patterns a grant
   * side has: prepared once per (kind, count) and reused.
   */
  const prepared = new Map<string, Statement>();
  function cached<P extends unknown[], R>(key: string, sql: () => string): Statement<P, R> {
    let st = prepared.get(key);
    if (st === undefined) {
      st = db.prepare(sql());
      prepared.set(key, st);
    }
    return st as unknown as Statement<P, R>;
  }

  /** The one way a by-id read or change finds its row: inside the grant or not at all. */
  const getScoped = (n: number) =>
    cached<[Params], MemoryRow>(
      `get:${n}`,
      () => `SELECT * FROM memories m WHERE m.id = @id AND ${grantSql(n)}`,
    );
  const listScoped = (n: number) =>
    cached<[Params], MemoryRow>(
      `list:${n}`,
      () => `SELECT * FROM memories m WHERE ${grantSql(n)} AND (@tier IS NULL OR m.tier = @tier)
         AND (@pinned IS NULL OR m.pinned = @pinned)
       ORDER BY m.rid`,
    );
  /** With a spatial filter (CON-84), its predicate joins the grant's; without one, as before. */
  const lexicalScoped = (n: number, f?: SpatialFilter) =>
    cached<[Params], { id: string; tier: Tier; rank: number }>(
      `lexical:${n}${spatialShape(f)}`,
      () => `SELECT m.id AS id, m.tier AS tier, bm25(${FTS_TABLE}) AS rank
       FROM ${FTS_TABLE} CROSS JOIN memories m ON m.rid = ${FTS_TABLE}.rowid
       WHERE ${FTS_TABLE} MATCH @match AND ${grantSql(n)}${f === undefined ? '' : ` AND ${spatialSql(f, 'm')}`}
       ORDER BY rank, m.updated_at DESC, m.id
       LIMIT @k`,
    );
  /**
   * KNN for one pattern: filtered inside vec0 by the node's partition, the
   * project list (unless every project) and the author (when the pattern names
   * one) before k is taken, then by the pattern again on the joined row. The
   * KNN is materialised and joined first (`CROSS JOIN` fixes the order):
   * otherwise the planner may drive from the `memories` index and rerun the
   * KNN once per row. A spatial filter (CON-84) is one more constraint inside the KNN, so k is
   * taken after it: `id IN` the memories that pass it.
   */
  const densePattern = (allProjects: boolean, byAuthor: boolean, f?: SpatialFilter) =>
    cached<[Params], { id: string; distance: number; tier: Tier; updated_at: string }>(
      `dense:${allProjects}:${byAuthor}${spatialShape(f)}`,
      () => `WITH knn AS MATERIALIZED (
         SELECT id, distance FROM memories_vec
         WHERE embedding MATCH vec_int8(@v) AND k = @k AND node_key = @nodeKey
           ${allProjects ? '' : 'AND project_key IN (SELECT value FROM json_each(@projectKeys))'}
           ${byAuthor ? 'AND author_key = @author' : ''}
           AND tier != 'cold'
           ${f === undefined ? '' : `AND id IN (SELECT s.id FROM memories s WHERE ${spatialSql(f, 's')})`}
       )
       SELECT knn.id AS id, knn.distance AS distance, m.tier AS tier, m.updated_at AS updated_at
       FROM knn CROSS JOIN memories m ON m.id = knn.id
       WHERE m.tier != 'cold' AND knn.distance IS NOT NULL AND ${grantSql(1)}
       ORDER BY knn.distance, m.updated_at DESC, m.id`,
    );

  /**
   * The binary index's statements, or undefined while the store has none. Checked on every use:
   * another process may build or drop the index while this one is open (`vectorIndex`).
   */
  const bitTableExists = db.prepare<[string], { x: number }>(
    "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  let bitStatements:
    | {
        remove: Statement<[string]>;
        insert: Statement<[string, Buffer, string, string, string, Buffer]>;
        vecRow: Statement<
          [string],
          {
            embedding: Buffer;
            node_key: string;
            project_key: string;
            author_key: string;
            tier: Tier;
          }
        >;
      }
    | undefined;
  function bit(): typeof bitStatements {
    if (bitTableExists.get(BIT_TABLE) === undefined) {
      bitStatements = undefined;
      return undefined;
    }
    bitStatements ??= {
      remove: db.prepare(`DELETE FROM ${BIT_TABLE} WHERE id = ?`),
      insert: db.prepare(
        `INSERT INTO ${BIT_TABLE} (id, embedding, node_key, project_key, author_key, rescore)
         VALUES (?, vec_bit(?), ?, ?, ?, ?)`,
      ),
      vecRow: db.prepare(
        `SELECT embedding, node_key, project_key, author_key, tier FROM memories_vec WHERE id = ?`,
      ),
    };
    return bitStatements;
  }

  /**
   * Makes the binary index's row for `id` match its int8 row: present, with the same vector and
   * partition, while the memory has a vector and is not cold; absent otherwise. Call inside the
   * transaction that changed the int8 row.
   */
  function syncBinary(id: string): void {
    const b = bit();
    if (b === undefined) return;
    b.remove.run(id);
    const row = b.vecRow.get(id);
    if (row === undefined || row.tier === 'cold') return;
    const e = row.embedding;
    const v = new Int8Array(e.buffer, e.byteOffset, e.byteLength);
    b.insert.run(id, binaryCode(v), row.node_key, row.project_key, row.author_key, e);
  }

  /**
   * KNN for one pattern over the binary index: the `BINARY_OVERSAMPLE` × k nearest codes by
   * Hamming distance (filtered inside vec0 exactly as `densePattern` is, the spatial filter
   * included, so the candidates are taken after it), each rescored with its
   * int8 vector, then the k best by int8 cosine distance. The rescoring vectors are read only for
   * the candidates, one row lookup each.
   */
  const binaryPattern = (allProjects: boolean, byAuthor: boolean, f?: SpatialFilter) =>
    cached<
      [Params],
      { id: string; distance: number; tier: Tier; updated_at: string; rescored: number }
    >(
      `binary:${allProjects}:${byAuthor}${spatialShape(f)}`,
      () => `WITH knn AS MATERIALIZED (
         SELECT id, rescore FROM ${BIT_TABLE}
         WHERE embedding MATCH vec_bit(@code) AND k = @candidates AND node_key = @nodeKey
           ${allProjects ? '' : 'AND project_key IN (SELECT value FROM json_each(@projectKeys))'}
           ${byAuthor ? 'AND author_key = @author' : ''}
           ${f === undefined ? '' : `AND id IN (SELECT s.id FROM memories s WHERE ${spatialSql(f, 's')})`}
       ), scored AS MATERIALIZED (
         SELECT id, vec_distance_cosine(vec_int8(rescore), vec_int8(@v)) AS distance FROM knn
       )
       SELECT scored.id AS id, scored.distance AS distance, m.tier AS tier,
              m.updated_at AS updated_at, (SELECT count(*) FROM knn) AS rescored
       FROM scored CROSS JOIN memories m ON m.id = scored.id
       WHERE m.tier != 'cold' AND scored.distance IS NOT NULL AND ${grantSql(1)}
       ORDER BY scored.distance, m.updated_at DESC, m.id
       LIMIT @k`,
    );

  /** The RaBitQ index's writes (CON-25), and this process's in-memory copy of it. */
  const rq = rabitqWriter(db, dimension);
  // A missing native engine is said once per process, by opens that may migrate (`oort`
  // commands, the MCP server, the SDK): the hooks run once per prompt and stay quiet; `oort
  // doctor` says it there.
  const rqReader = new RabitqReader(
    db,
    dimension,
    rabitqEngine,
    opts.migrate === false ? () => {} : log,
  );

  /**
   * Rescores RaBitQ candidates for one pattern: each candidate's int8 vector (one primary-key
   * read each) against the query, keeping only rows that pass every filter the int8 path applies
   * (tier, the grant pattern, the spatial filter).
   */
  const rabitqRescore = (f?: SpatialFilter) =>
    cached<[Params], RescoredRow>(
      `rabitq:${spatialShape(f)}`,
      () => `SELECT m.id AS id, vec_distance_cosine(vec_int8(r.embedding), vec_int8(@v)) AS distance,
              m.tier AS tier, m.updated_at AS updated_at
       FROM json_each(@rids) j CROSS JOIN ${RQ_VEC_TABLE} r ON r.rid = j.value
         CROSS JOIN memories m ON m.rid = r.rid
       WHERE m.tier != 'cold' AND ${grantSql(1)}${f === undefined ? '' : ` AND ${spatialSql(f, 'm')}`}`,
    );
  /** The memories a spatial filter admits (CON-84), for the RaBitQ engine's allowlist. */
  const spatialRids = (f: SpatialFilter) =>
    cached<[Params], { rid: number }>(
      `spatial-rids${spatialShape(f)}`,
      () => `SELECT m.rid AS rid FROM memories m WHERE ${spatialSql(f, 'm')}`,
    );

  const rabitqMaxLoad = opts.rabitqMaxLoad;
  /**
   * The handle this function returns, held weakly. No closure here names the handle itself:
   * closures of one scope share their captured variables, so one that did would let the timer's
   * refresh keep a dropped handle alive.
   */
  let selfRef: WeakRef<MemoryStore> | undefined;
  /** Whether this handle stays off the RaBitQ engine (`rabitqMaxLoad`), decided once. */
  let rqTooBig: boolean | undefined;
  let rqTimer: ReturnType<typeof setInterval> | undefined;
  const stopRqTimer = () => {
    if (rqTimer !== undefined) clearInterval(rqTimer);
    rqTimer = undefined;
  };

  /**
   * Brings this process's RaBitQ engine up to date and says whether searches may use it: false
   * (and the engine dropped) when the index is gone or still being built, or when it holds more
   * vectors than this handle may load.
   */
  const rqRefresh = db.transaction((): boolean => {
    if (!rq.ready()) {
      rqReader.release();
      stopRqTimer();
      return false;
    }
    if (!rqReader.loaded && rabitqMaxLoad !== undefined) {
      rqTooBig ??= rabitqVectors(db) > rabitqMaxLoad;
      if (rqTooBig) return false;
    }
    rqReader.refresh();
    opts.onRabitqRefresh?.({ vectors: rqReader.stats().vectors });
    // Loaded: other processes' forgets reach it on a timer too, not only on the next search.
    // It holds the handle weakly: a handle dropped without close() is still collected.
    const self = selfRef?.deref();
    if (self !== undefined) rqTimer ??= weakInterval(self, opts.rabitqRefreshMs ?? 30_000);
    return true;
  });

  /** After a committed write: the engine, if loaded, takes this process's changes at once. */
  function rqAfterWrite(): void {
    if (rqReader.loaded) rqRefresh();
  }

  /**
   * One dense query per pattern: over the RaBitQ index when there is one and it is wanted, else
   * over the binary index when there is one and it is wanted, else the exact int8 scan.
   */
  const denseRuns = db.transaction(
    (patterns: NodePattern[], v: Int8Array, kk: number, f: SpatialFilter | undefined) => {
      const stats = opts.onDenseStats;
      if (vectorIndex !== 'int8' && rqRefresh()) {
        const allow =
          f === undefined
            ? undefined
            : spatialRids(f)
                .all(spatialParams(f))
                .map((r) => r.rid);
        return patterns.map((p) => {
          const params = { ...patternParams(p, 0), ...(f !== undefined && spatialParams(f)) };
          const bytes = toBytes(v);
          return rqReader.search(
            v,
            kk,
            {
              node: nodeKey(p.node),
              ...(p.projectIds !== 'all' && {
                projects: (p.projectIds as (string | null)[]).map(projectKey),
              }),
              ...(p.authorAgentId !== undefined && { author: p.authorAgentId }),
              ...(allow !== undefined && { allow }),
            },
            (rids) => rabitqRescore(f).all({ ...params, v: bytes, rids: JSON.stringify(rids) }),
            stats && ((s) => stats({ index: 'rabitq', ...s })),
          ) as { id: string; distance: number; tier: Tier; updated_at: string }[];
        });
      }
      const binary = vectorIndex !== 'int8' && bit() !== undefined;
      const code = binary ? binaryCode(v) : undefined;
      return patterns.map((p) => {
        const all = p.projectIds === 'all';
        const params = {
          ...patternParams(p, 0),
          ...(f !== undefined && spatialParams(f)),
          v: toBytes(v),
          k: kk,
          nodeKey: nodeKey(p.node),
          ...(!all && {
            projectKeys: JSON.stringify((p.projectIds as (string | null)[]).map(projectKey)),
          }),
          ...(p.authorAgentId !== undefined && { author: p.authorAgentId }),
        };
        const byAuthor = p.authorAgentId !== undefined;
        if (code === undefined) {
          stats?.({ index: 'int8', candidates: 0, reads: 0 });
          return densePattern(all, byAuthor, f).all(params);
        }
        const candidates = Math.min(kk * BINARY_OVERSAMPLE, MAX_KNN);
        const rows = binaryPattern(all, byAuthor, f).all({ ...params, code, candidates });
        stats?.({ index: 'binary', candidates, reads: rows[0]?.rescored ?? 0 });
        return rows;
      });
    },
  );

  let closed = false;

  function open(): void {
    if (closed) throw new Error('sqlite store is closed');
  }

  function checkDimension(v: Int8Array, what: string): void {
    if (v.length !== dimension) {
      throw new RangeError(
        `${what}: vector has ${v.length} dimensions, store dimension is ${dimension}`,
      );
    }
  }

  function embeddingOf(id: string): Int8Array | undefined {
    const row = q.vecGet.get(id);
    if (row === undefined) return undefined;
    const b = row.embedding;
    return Int8Array.from(new Int8Array(b.buffer, b.byteOffset, b.byteLength));
  }

  /** The FTS row for a memory; cold rows index stub and entities only. */
  function writeFts(rid: number, tier: Tier, text: string, stub: string, entities: string[]) {
    q.ftsDelete.run(rid);
    q.ftsInsert.run(
      rid,
      tier === 'cold' ? '' : indexed(text),
      indexed(stub),
      indexed(entities.join(' ')),
    );
  }

  /**
   * The entity index rows and the episode position of the memory at `rid` (CON-148), after its
   * row was written. Entity rows are rewritten on every write, and exist only while the memory is
   * current (`inLinkIndexes`). The episode position is given once: a rewrite in the same session
   * keeps it; a new memory gets its turn's (another fact with the same `turnRef`) or the next one.
   */
  function writeLinkIndexes(
    rid: number,
    m: Memory,
    address: Address,
    existing: MemoryRow | undefined,
  ): void {
    q.entityDelete.run(rid);
    const cols = addressColumns(address);
    if (inLinkIndexes(m)) {
      const keys = entityKeys(m.entities);
      if (keys.length > 0) {
        const node = nodeIdOf(db, nodeKeyOfColumns(cols));
        for (const k of keys) q.entityInsert.run(node, k, rid);
      }
    }
    const session = episodeSession(m) ?? null;
    if (session === null) {
      if (existing?.session_id != null) q.setEpisode.run(null, null, rid);
      return;
    }
    if (existing?.session_id === session && existing.episode_seq != null) return;
    const where = {
      session,
      rid,
      level: cols.level,
      org: cols.org_id,
      customer: cols.customer_id,
      agent: cols.agent_id,
      hive: cols.hive_id,
      run: cols.run_id,
    };
    const turn = m.source.turnRef;
    const seq =
      (typeof turn === 'string' ? q.turnSeq.get({ ...where, turn })?.seq : undefined) ??
      q.nextSeq.get(where)?.seq ??
      1;
    q.setEpisode.run(session, seq, rid);
  }

  /**
   * Writes one memory's row, FTS row and vec row. Call inside a transaction.
   * Returns the blob to unlink after commit when a non-cold write dropped the cold copy.
   */
  function writeMemory(grant: Grant, input: Memory): string[] {
    if (input.embedding !== undefined) checkDimension(input.embedding, `upsert ${input.id}`);
    // Inside the transaction, so a rejection rolls back the whole batch.
    const m = canonicalMemory(input);
    if (m.place !== undefined) m.place = checkPlace(m.place);
    else delete m.place;
    const { address, author } = resolveAddressing(m);
    if (!grantWrites(grant, m)) throw new GrantError();
    const existing = q.getRow.get(m.id);
    if (existing !== undefined && !sameRecordAddress(fromRow(existing, undefined), m)) {
      throw new GrantError();
    }
    const row = q.upsertRow.get(toRow(m, address, author));
    if (row === undefined) throw new Error(`upsert ${m.id}: no row returned`);
    writeFts(row.rid, m.tier, m.text, m.stub, m.entities);
    writeLinkIndexes(row.rid, m, address, existing);
    q.placeDelete.run(row.rid);
    const box = placeBox(m.place);
    if (box !== undefined) {
      q.placeInsert.run(
        row.rid,
        box.minX,
        box.maxX,
        box.minY,
        box.maxY,
        box.minZ,
        box.maxZ,
        box.mapKey,
      );
    }
    q.vecDelete.run(m.id);
    const b = bit();
    b?.remove.run(m.id);
    const keys = {
      node: nodeKey(nodeOf(address)),
      project: projectKey(address.projectId),
      author: author.agentId,
    };
    // A zero vector has no direction (cosine is NaN): it is not kept (CON-141).
    const kept = m.embedding !== undefined && !isZeroVector(m.embedding) ? m.embedding : undefined;
    const bytes = kept === undefined ? undefined : toBytes(kept);
    if (kept !== undefined && bytes !== undefined) {
      q.vecInsert.run(m.id, bytes, keys.node, keys.project, keys.author, m.tier);
      if (b !== undefined && m.tier !== 'cold') {
        b.insert.run(m.id, binaryCode(kept), keys.node, keys.project, keys.author, bytes);
      }
    }
    rq.put(row.rid, bytes, keys, m.tier !== 'cold');
    if (m.tier === 'cold') return [];
    const dropped = q.coldDelete.get(m.id);
    return dropped === undefined ? [] : [dropped.path];
  }

  /**
   * Unlinks blobs no committed row references any more. The commit landed, so
   * an unlink failure must not fail the call; what is left is unreferenced and
   * the next open's sweep removes it.
   */
  function removeAfterCommit(files: string[]): void {
    const failures = blobs.removeAll(files);
    if (failures.length > 0) {
      log(
        `oort store: could not remove ${failures.length} unreferenced cold blob(s); the next open sweeps them`,
      );
    }
  }

  const writeAll = db.transaction((grant: Grant, ms: Memory[]) =>
    ms.flatMap((m) => writeMemory(grant, m)),
  );

  /** `writeAll` for the writes whose row still matches its snapshot; the rest are skipped. */
  const writeIfUnchanged = db.transaction(
    (grant: Grant, writes: { next: Memory; was: Pick<Memory, 'id' | 'updatedAt' | 'tier'> }[]) => {
      const skipped: string[] = [];
      const files: string[] = [];
      for (const { next, was } of writes) {
        // Out of the grant reads as missing: skipped, never a GrantError.
        const row = scopedRow(grant.writeNodes, was.id);
        if (
          row === undefined ||
          next.id !== was.id ||
          row.updated_at !== was.updatedAt ||
          row.tier !== was.tier
        ) {
          skipped.push(was.id);
          continue;
        }
        files.push(...writeMemory(grant, next));
      }
      return { skipped, files };
    },
  );

  function upsertMany(grant: Grant, ms: Memory[]): void {
    // The rows are gone once the transaction commits; only then unlink exactly
    // the blob each one named (unique per coldPut, so never another write's).
    removeAfterCommit(writeAll.immediate(grant, ms));
    rqAfterWrite();
  }

  /** The row for `id` if a pattern of `side` covers it; unknown and out-of-grant read the same. */
  function scopedRow(side: readonly NodePattern[], id: string): MemoryRow | undefined {
    const patterns = live(side);
    if (patterns.length === 0) return undefined;
    return getScoped(patterns.length).get({ ...grantParams(patterns), id });
  }

  const forgetTx = db.transaction((grant: Grant, id: string): string | undefined => {
    const scoped = scopedRow(grant.writeNodes, id);
    if (scoped === undefined) return undefined;
    const row = q.deleteRow.get(id);
    if (row !== undefined) {
      // Its links, blocks and entity rows went with it (ON DELETE CASCADE). The node's own row
      // names an org, customer, agent or run: it goes with the node's last memory (CON-148).
      const left = q.nodeHasMemory.get({
        level: scoped.level,
        org: scoped.org_id,
        customer: scoped.customer_id,
        agent: scoped.agent_id,
        hive: scoped.hive_id,
        run: scoped.run_id,
      });
      if (left === undefined) q.nodeDelete.run(nodeKeyOfColumns(scoped));
      q.ftsDelete.run(row.rid);
      q.placeDelete.run(row.rid);
      rq.remove(row.rid);
      // A contentless FTS5 delete only marks the row deleted: its terms stay in the index's
      // segments until they merge. Merging them all drops them now (CON-140); with
      // `secure_delete` the pages they leave are zeroed. Rows rewritten earlier (`upsert`) are
      // purged here too.
      q.ftsOptimize.run();
    }
    q.vecDelete.run(id);
    bit()?.remove.run(id);
    return q.coldDelete.get(id)?.path;
  });

  /**
   * Copies the WAL into the database and truncates it (CON-140): the WAL still holds the pages
   * as they were before a forget, until a later write happens to overwrite them. Never waits: a
   * reader in another process (the MCP server, a hook) keeps it from finishing, and then this
   * says so (`log`) and a later checkpoint resets it. True when the WAL is empty.
   */
  function truncateWal(): boolean {
    db.pragma('busy_timeout = 0');
    try {
      const r = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
      if (r[0]?.busy === 0) return true;
    } catch {
      // Busy or locked: as below.
    } finally {
      db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    }
    log(
      'oort store: another process is reading the store, so its write-ahead log keeps the old pages until the next checkpoint',
    );
    return false;
  }

  const recordAccessTx = db.transaction((grant: Grant, ids: string[], at: Date) => {
    for (const id of ids) {
      const row = scopedRow(grant.readNodes, id);
      if (row === undefined) continue;
      const log = appendAccess(JSON.parse(row.access_log) as AccessLog, at, { d });
      q.setAccess.run(JSON.stringify(log), id);
    }
  });

  /** Rewrites the derived rows (vec tier metadata, FTS) after a tier change. */
  function afterTierChange(
    id: string,
    tier: Tier,
    row: Pick<MemoryRow, 'rid' | 'text' | 'stub' | 'entities'>,
  ): void {
    q.vecSetTier.run(tier, id);
    syncBinary(id);
    rq.sync(row.rid, id);
    writeFts(row.rid, tier, row.text, row.stub, JSON.parse(row.entities) as string[]);
  }

  const setTierTx = db.transaction(
    (
      grant: Grant,
      id: string,
      tier: Tier,
      snapshot?: Pick<Memory, 'updatedAt' | 'tier'>,
    ): boolean => {
      if (scopedRow(grant.writeNodes, id) === undefined) return false;
      const row =
        snapshot === undefined
          ? q.setTierRow.get(tier, id)
          : q.setTierIfUnchanged.get({
              id,
              tier,
              updatedAt: snapshot.updatedAt,
              was: snapshot.tier,
            });
      if (row === undefined) return false;
      afterTierChange(id, tier, row);
      return true;
    },
  );

  /** An expired memory leaves the entity index in the same transaction (CON-148). */
  const expireManyTx = db.transaction((grant: Grant, ms: Memory[], at: string): string[] =>
    ms
      .filter((m) => {
        if (scopedRow(grant.writeNodes, m.id) === undefined) return true;
        const row = q.expireIfUnchanged.get({ id: m.id, at, updatedAt: m.updatedAt, was: m.tier });
        if (row === undefined) return true;
        q.entityDelete.run(row.rid);
        return false;
      })
      .map((m) => m.id),
  );

  /**
   * The rows `link` and `unlink` join: both inside `grant.write`, distinct, in one node that is
   * not at level `hive`, ordered `a < b`. Undefined for anything else, as for a missing id.
   */
  function linkablePair(
    grant: Grant,
    x: string,
    y: string,
  ): { a: number; b: number; node: string } | undefined {
    if (x === y) return undefined;
    const rx = scopedRow(grant.writeNodes, x);
    const ry = scopedRow(grant.writeNodes, y);
    if (rx === undefined || ry === undefined) return undefined;
    if (rx.level === 'hive' || ry.level === 'hive') return undefined;
    const node = nodeKeyOfColumns(rx);
    if (node !== nodeKeyOfColumns(ry)) return undefined;
    const [a, b] = rx.rid < ry.rid ? [rx.rid, ry.rid] : [ry.rid, rx.rid];
    return { a, b, node };
  }

  const linkTx = db.transaction(
    (grant: Grant, x: string, y: string, o: LinkOptions): LinkResult | null => {
      const p = linkablePair(grant, x, y);
      if (p === undefined) return null;
      // Only a `user` link removes a block a `user` unlink wrote.
      if (o.assertedBy !== 'user' && q.linkGet.get('blocked', p.a, p.b)?.asserted_by === 'user') {
        return {
          linked: false,
          unblocked: false,
          assertedBy: 'agent',
          refused: 'asserted-by-user',
        };
      }
      const unblocked = q.linkDelete.run('blocked', p.a, p.b).changes > 0;
      const was = q.linkGet.get('explicit', p.a, p.b);
      if (was !== undefined) {
        const stronger = o.assertedBy === 'user' && was.asserted_by !== 'user';
        if (stronger) q.linkAssertUser.run(grant.principal.agentId, p.a, p.b);
        return {
          linked: stronger,
          unblocked,
          assertedBy: stronger ? 'user' : (was.asserted_by ?? 'agent'),
        };
      }
      q.linkInsert.run({
        kind: 'explicit',
        node: nodeIdOf(db, p.node),
        a: p.a,
        b: p.b,
        by: o.assertedBy,
        agent: grant.principal.agentId,
        at: (o.at ?? clock()).toISOString(),
      });
      return { linked: true, unblocked, assertedBy: o.assertedBy };
    },
  );

  /** The memories, then their links, in one transaction (an import). Nested calls are savepoints. */
  const writeLinked = db.transaction(
    (
      grant: Grant,
      ms: Memory[],
      pairs: readonly (readonly [string, string])[],
      o: LinkOptions,
    ): { files: string[]; linked: number } => {
      const files = ms.flatMap((m) => writeMemory(grant, m));
      let linked = 0;
      for (const [x, y] of pairs) if (linkTx(grant, x, y, o)?.linked === true) linked++;
      return { files, linked };
    },
  );

  const unlinkTx = db.transaction(
    (grant: Grant, x: string, y: string, o: LinkOptions): UnlinkResult | null => {
      const p = linkablePair(grant, x, y);
      if (p === undefined) return null;
      // Only a `user` unlink removes a `user` link: otherwise an agent could unlink it and link
      // it again as its own.
      if (o.assertedBy !== 'user' && q.linkGet.get('explicit', p.a, p.b)?.asserted_by === 'user') {
        return { removed: false, blocked: false, refused: 'asserted-by-user' };
      }
      const removed =
        q.linkDelete.run('explicit', p.a, p.b).changes +
          q.linkDelete.run('recalledWith', p.a, p.b).changes >
        0;
      const related =
        q.sharesEntity.get(p.b, p.a) !== undefined || q.sharesSession.get(p.b, p.a) !== undefined;
      if (removed && !related) return { removed, blocked: false };
      q.linkInsert.run({
        kind: 'blocked',
        node: nodeIdOf(db, p.node),
        a: p.a,
        b: p.b,
        by: o.assertedBy,
        agent: grant.principal.agentId,
        at: (o.at ?? clock()).toISOString(),
      });
      return { removed, blocked: true };
    },
  );

  /**
   * Every link and block row of the memory at `@rid`, with the other end's id and whether a
   * pattern of the reader's grant covers it (`grantSql` over the other end, aliased `m`).
   */
  const linksScoped = (n: number) =>
    cached<
      [Params],
      {
        kind: StoredLink['kind'] | 'blocked';
        a_rid: number;
        asserted_by: 'user' | 'agent' | null;
        created_at: string;
        id: string;
        readable: number;
      }
    >(
      `links:${n}`,
      () => `SELECT l.kind AS kind, l.a_rid AS a_rid, l.asserted_by AS asserted_by,
              l.created_at AS created_at, m.id AS id, ${grantSql(n)} AS readable
       FROM ${LINK_TABLE} l
         CROSS JOIN memories m ON m.rid = (CASE WHEN l.a_rid = @rid THEN l.b_rid ELSE l.a_rid END)
       WHERE l.a_rid = @rid OR l.b_rid = @rid
       ORDER BY l.created_at, l.kind, m.rid`,
    );

  function linksOfRow(grant: Grant, id: string): LinksOf | null {
    const row = scopedRow(grant.readNodes, id);
    if (row === undefined) return null;
    const patterns = live(grant.readNodes);
    const out: LinksOf = { links: [], blocked: [], hidden: 0 };
    for (const r of linksScoped(patterns.length).all({ ...grantParams(patterns), rid: row.rid })) {
      const seen = r.readable !== 0;
      if (r.kind === 'blocked') {
        if (seen) out.blocked.push(r.id);
      } else if (!seen) {
        out.hidden++;
      } else {
        out.links.push({
          kind: r.kind,
          id: r.id,
          direction: r.kind === 'distilledFrom' ? (r.a_rid === row.rid ? 'out' : 'in') : 'both',
          ...(r.kind === 'explicit' && { assertedBy: r.asserted_by ?? 'agent' }),
          createdAt: r.created_at,
        });
      }
    }
    return out;
  }

  /** One candidate neighbour: its row id, node and whether the reader's grant and place admit it. */
  interface NeighbourRow {
    rid: number;
    id: string;
    level: string;
    org_id: string;
    customer_id: string | null;
    agent_id: string | null;
    hive_id: string | null;
    run_id: string | null;
    expired_at: string | null;
    superseded_by: string | null;
    episode_seq: number | null;
    asserted_by?: 'user' | 'agent' | null;
    readable: number;
    inplace: number | null;
  }
  /** The columns of a `NeighbourRow`, over `memories` aliased `m` (the grant and place as flags). */
  const neighbourCols = (n: number, f: SpatialFilter | undefined): string =>
    `m.rid AS rid, m.id AS id, m.level AS level, m.org_id AS org_id,
     m.customer_id AS customer_id, m.agent_id AS agent_id, m.hive_id AS hive_id,
     m.run_id AS run_id, m.expired_at AS expired_at, m.superseded_by AS superseded_by,
     m.episode_seq AS episode_seq, ${grantSql(n)} AS readable,
     ${f === undefined ? '1' : `(${spatialSql(f, 'm')})`} AS inplace`;
  /**
   * The explicit links of the memory at `@rid` that the grant reads, newest other end first: two
   * index ranges, read only when `explicitRaw` is within its bound.
   */
  const explicitEnds = (n: number, f: SpatialFilter | undefined) =>
    cached<[Params], NeighbourRow>(
      `nb-explicit:${n}${spatialShape(f)}`,
      () => `SELECT ${neighbourCols(n, f)}, l.asserted_by AS asserted_by
       FROM (SELECT b_rid AS other, asserted_by FROM ${LINK_TABLE}
               WHERE kind = 'explicit' AND a_rid = @rid
             UNION ALL
             SELECT a_rid AS other, asserted_by FROM ${LINK_TABLE}
               WHERE b_rid = @rid AND kind = 'explicit') l
         CROSS JOIN memories m ON m.rid = l.other
       WHERE ${grantSql(n)}
       ORDER BY l.other DESC`,
    );
  /** The memories of the seed's node and session within the reach: one index range. */
  const episodeNear = (n: number, f: SpatialFilter | undefined) =>
    cached<[Params], NeighbourRow>(
      `nb-episode:${n}${spatialShape(f)}`,
      () => `SELECT ${neighbourCols(n, f)} FROM memories m
       WHERE m.session_id = @session AND m.episode_seq BETWEEN @lo AND @hi AND m.rid != @rid
         AND m.level = @level AND m.org_id = @org AND m.customer_id IS @customer
         AND m.agent_id IS @agent AND m.hive_id IS @hive AND m.run_id IS @run
         AND ${grantSql(n)}
       ORDER BY abs(m.episode_seq - @seq), m.rid DESC`,
    );
  /**
   * The memories of one entity in one node that the grant reads, newest first, at most `@cap`
   * (`fMax`: that many is a hub already). The grant is applied before the limit, so the fan and
   * the neighbours depend only on rows the reader may read.
   */
  const entityFan = (n: number, f: SpatialFilter | undefined) =>
    cached<[Params], NeighbourRow>(
      `nb-about:${n}${spatialShape(f)}`,
      () => `SELECT ${neighbourCols(n, f)}
       FROM ${ENTITY_TABLE} e CROSS JOIN memories m ON m.rid = e.memory_rid
       WHERE e.node_id = @node AND e.entity_key = @key AND ${grantSql(n)}
       ORDER BY e.memory_rid DESC LIMIT @cap`,
    );
  /**
   * The work bounds, whatever the grant (core's `rawScanLimit`): how many rows a read would
   * touch, counted up to `@cap`. A read past its bound is not made. Each count stays inside the
   * seed's own node (a link row joins two memories of one node; the entity index is keyed by
   * node; the episode count names the node's columns), so a row in another node never counts.
   */
  const explicitRaw = db.prepare<[Params], { n: number }>(
    `SELECT (SELECT count(*) FROM (SELECT 1 FROM ${LINK_TABLE}
               WHERE kind = 'explicit' AND a_rid = @rid LIMIT @cap))
          + (SELECT count(*) FROM (SELECT 1 FROM ${LINK_TABLE}
               WHERE b_rid = @rid AND kind = 'explicit' LIMIT @cap)) AS n`,
  );
  const episodeRaw = db.prepare<[Params], { n: number }>(
    `SELECT count(*) AS n FROM (SELECT 1 FROM memories
       WHERE session_id = @session AND episode_seq BETWEEN @lo AND @hi AND rid != @rid
         AND level = @level AND org_id = @org AND customer_id IS @customer
         AND agent_id IS @agent AND hive_id IS @hive AND run_id IS @run
       LIMIT @cap)`,
  );
  const entityRaw = db.prepare<[Params], { n: number }>(
    `SELECT count(*) AS n FROM (SELECT 1 FROM ${ENTITY_TABLE}
       WHERE node_id = @node AND entity_key = @key LIMIT @cap)`,
  );
  const nodeIdRead = db.prepare<[string], { node_id: number }>(
    `SELECT node_id FROM ${NODE_TABLE} WHERE node_key = ?`,
  );

  /**
   * One hop from the seeds (CON-149), as ids. Every read is one bounded index range: per seed for
   * `explicit` and `episode`, per seed entity for `about`. The same rules, bounds and order as
   * core's in-memory store, which `linksConformance` holds both to.
   */
  function neighboursOf(grant: Grant, seedIds: string[], o: NeighbourOptions): NeighboursResult {
    const patterns = live(grant.readNodes);
    if (patterns.length === 0) return { neighbours: [] };
    const fMax = o.fMax ?? F_MAX_DEFAULT;
    const now = o.clock ?? (() => performance.now());
    const start = now();
    const budget = o.budgetMs ?? 0;
    const late = () => budget > 0 && now() - start >= budget;
    const f = hasSpatialFilter(o.spatial) ? o.spatial : undefined;
    const n = patterns.length;
    const bound = { ...grantParams(patterns), ...(f !== undefined && spatialParams(f)) };
    const seeds = [...new Set(seedIds)]
      .map((id) => scopedRow(grant.readNodes, id))
      .filter((r): r is MemoryRow => r !== undefined && r.level !== 'hive')
      .map((r) => ({ row: r, node: nodeKeyOfColumns(r) }));
    /** What a link may bring in from `seed`: readable, in its node, in place, not blocked. */
    const admits = (seed: (typeof seeds)[number], r: NeighbourRow): boolean => {
      if (r.rid === seed.row.rid || r.readable === 0 || r.inplace !== 1) return false;
      if (r.level === 'hive' || nodeKeyOfColumns(r) !== seed.node) return false;
      if (o.currentOnly === true && (r.expired_at !== null || r.superseded_by !== null))
        return false;
      const [a, b] = seed.row.rid < r.rid ? [seed.row.rid, r.rid] : [r.rid, seed.row.rid];
      return q.linkGet.get('blocked', a, b) === undefined;
    };
    const out: Neighbour[] = [];
    let skipped = false;
    let budgetPassed = false;
    /** Whether a read would touch more than `bound` index rows: then it is skipped, and said. */
    const tooLarge = (st: Statement<[Params], { n: number }>, p: Params, bound: number) => {
      if ((st.get({ ...p, cap: bound + 1 })?.n ?? 0) <= bound) return false;
      skipped = true;
      return true;
    };
    gather: for (const kind of NEIGHBOUR_KINDS) {
      if (!o.kinds.includes(kind)) continue;
      if (late()) {
        skipped = true;
        break;
      }
      for (const seed of seeds) {
        const { row } = seed;
        if (kind === 'explicit') {
          if (tooLarge(explicitRaw, { rid: row.rid }, EXPLICIT_RAW_SCAN)) continue;
          let kept = 0;
          for (const r of explicitEnds(n, f).all({ ...bound, rid: row.rid })) {
            if (o.explicitBy === 'user' && r.asserted_by !== 'user') continue;
            if (!admits(seed, r)) continue;
            out.push({ id: r.id, kind, from: row.id, weight: 1 });
            if (++kept === EXPLICIT_PER_SEED) break;
          }
        } else if (kind === 'episode') {
          const seq = row.episode_seq;
          if (row.session_id == null || seq == null) continue;
          const window = {
            rid: row.rid,
            session: row.session_id,
            lo: seq - EPISODE_REACH,
            hi: seq + EPISODE_REACH,
            level: row.level,
            org: row.org_id,
            customer: row.customer_id,
            agent: row.agent_id,
            hive: row.hive_id,
            run: row.run_id,
          };
          if (tooLarge(episodeRaw, window, EPISODE_RAW_SCAN)) continue;
          const near = episodeNear(n, f)
            .all({ ...bound, ...window, seq })
            .filter((r) => r.episode_seq !== null && admits(seed, r))
            .map((r) => ({ r, delta: (r.episode_seq as number) - seq }))
            .sort((x, y) => Math.abs(x.delta) - Math.abs(y.delta) || y.r.rid - x.r.rid);
          for (const { r, delta } of near.slice(0, EPISODE_PER_SEED)) {
            out.push({ id: r.id, kind, from: row.id, weight: episodeWeight(delta) });
          }
        } else {
          // The entity index holds current memories only: an ended seed has no rows in it.
          if (row.expired_at !== null || row.superseded_by !== null) continue;
          const node = nodeIdRead.get(seed.node)?.node_id;
          if (node === undefined) continue;
          const weights = new Map<string, number[]>();
          for (const key of entityKeys(JSON.parse(row.entities) as string[])) {
            if (late()) {
              skipped = true;
              budgetPassed = true;
              break;
            }
            if (tooLarge(entityRaw, { node, key }, rawScanLimit(fMax))) continue;
            const rows = entityFan(n, f).all({ ...bound, node, key, cap: fMax });
            const w = aboutWeight(rows.length, fMax);
            if (w <= 0) continue;
            let kept = 0;
            for (const r of rows) {
              if (!admits(seed, r)) continue;
              weights.set(r.id, [...(weights.get(r.id) ?? []), w]);
              if (++kept === ABOUT_PER_ENTITY) break;
            }
          }
          for (const [id, ws] of weights) {
            out.push({ id, kind, from: row.id, weight: combineWeights(ws) });
          }
          // What the reads before the budget passed found is kept.
          if (budgetPassed) break gather;
        }
      }
    }
    return { neighbours: out, ...(skipped && { skipped: true as const }) };
  }

  /**
   * Demotes `ms[i]`'s row to cold with `files[i]` as its cold copy, for every i
   * whose row still matches its snapshot, all in one transaction. Only the
   * tier, the derived rows (vec, FTS) and the cold index change. Returns the
   * indices skipped by the guard and the blobs replaced, both to unlink after commit.
   */
  const coldPutManyTx = db.transaction(
    (grant: Grant, ms: Memory[], files: string[]): { skipped: number[]; previous: string[] } => {
      const skipped: number[] = [];
      const previous: string[] = [];
      for (const [i, m] of ms.entries()) {
        if (scopedRow(grant.writeNodes, m.id) === undefined) {
          skipped.push(i);
          continue;
        }
        const row = q.setTierIfUnchanged.get({
          id: m.id,
          tier: 'cold',
          updatedAt: m.updatedAt,
          was: m.tier,
        });
        if (row === undefined) {
          skipped.push(i);
          continue;
        }
        writeFts(row.rid, 'cold', row.text, row.stub, JSON.parse(row.entities) as string[]);
        q.vecDelete.run(m.id);
        bit()?.remove.run(m.id);
        rq.remove(row.rid);
        const old = q.coldPath.get(m.id)?.path;
        if (old !== undefined) previous.push(old);
        q.coldInsert.run(m.id, files[i] as string);
      }
      return { skipped, previous };
    },
  );

  /**
   * Writes new uniquely named blobs, then commits every guarded row change in
   * one IMMEDIATE transaction. Previously committed blobs are untouched until
   * that commit succeeds and removed after; a failed commit removes only the
   * new blobs, and so does a skipped entry once the commit is done.
   */
  async function coldPutMany(grant: Grant, snapshots: Memory[]): Promise<GuardedWriteResult> {
    open();
    assertGrant(grant);
    const skipped: string[] = [];
    const ms: Memory[] = [];
    for (const m of new Map(snapshots.map((x) => [x.id, x])).values()) {
      if (m.embedding !== undefined) checkDimension(m.embedding, `coldPut ${m.id}`);
      // A cold snapshot has no embedding to keep: nothing to write.
      if (m.tier === 'cold') skipped.push(m.id);
      else ms.push(m);
    }
    if (ms.length === 0) return { skipped };
    const files = await blobs.writeMany(ms.map((m) => ({ id: m.id, data: codec.encode(m) })));
    let tx: { skipped: number[]; previous: string[] };
    try {
      tx = coldPutManyTx.immediate(grant, ms, files);
    } catch (e) {
      throw withCleanupFailures(e, blobs.removeAll(files));
    }
    rqAfterWrite();
    for (const i of tx.skipped) skipped.push((ms[i] as Memory).id);
    removeAfterCommit([...tx.skipped.map((k) => files[k] as string), ...tx.previous]);
    return { skipped };
  }

  const handle: MemoryStore = {
    spatial: true,
    links: true,

    async link(grant, a, b, linkOpts) {
      open();
      assertGrant(grant);
      return linkTx.immediate(grant, a, b, linkOpts);
    },

    async unlink(grant, a, b, linkOpts) {
      open();
      assertGrant(grant);
      return unlinkTx.immediate(grant, a, b, linkOpts);
    },

    async linksOf(grant, id) {
      open();
      assertGrant(grant);
      return linksOfRow(grant, id);
    },

    async neighbours(grant, seedIds, neighbourOpts) {
      open();
      assertGrant(grant);
      return neighboursOf(grant, seedIds, neighbourOpts);
    },

    async upsert(grant, m) {
      open();
      assertGrant(grant);
      upsertMany(grant, [m]);
    },

    async upsertMany(grant, ms) {
      open();
      assertGrant(grant);
      upsertMany(grant, ms);
    },

    async upsertManyLinked(grant, ms, pairs, linkOpts) {
      open();
      assertGrant(grant);
      const r = writeLinked.immediate(grant, ms, pairs, linkOpts);
      removeAfterCommit(r.files);
      rqAfterWrite();
      return { linked: r.linked };
    },

    async upsertManyIfUnchanged(grant, writes) {
      open();
      assertGrant(grant);
      const r = writeIfUnchanged.immediate(grant, writes);
      removeAfterCommit(r.files);
      rqAfterWrite();
      return { skipped: r.skipped };
    },

    async get(grant, id) {
      open();
      assertGrant(grant);
      const row = scopedRow(grant.readNodes, id);
      return row === undefined ? null : fromRow(row, embeddingOf(id));
    },

    async forget(grant, id) {
      open();
      assertGrant(grant);
      const file = forgetTx.immediate(grant, id);
      // The engine drops the forgotten vector's code now, not at the next search.
      rqAfterWrite();
      if (file !== undefined) blobs.remove(file);
      truncateWal();
    },

    /** BM25 over normalised tokens, any-token match; `score` is -bm25 (higher is better). */
    async lexical(grant, text, k, searchOpts) {
      open();
      assertGrant(grant);
      const match = matchQuery(text);
      const patterns = live(grant.readNodes);
      if (match === null || k <= 0 || patterns.length === 0) return [];
      const sp = searchOpts?.spatial;
      const f = hasSpatialFilter(sp) ? sp : undefined;
      return lexicalScoped(patterns.length, f)
        .all({
          ...grantParams(patterns),
          ...(f !== undefined && spatialParams(f)),
          match,
          k: Math.floor(k),
        })
        .map((r): Hit => ({ id: r.id, score: -r.rank, tier: r.tier }));
    },

    /**
     * One KNN per read pattern (see `densePattern` and `binaryPattern`), merged best first when a
     * grant has several; `score` is the int8 cosine similarity, whichever index found it.
     */
    async dense(grant, v, k, searchOpts) {
      open();
      assertGrant(grant);
      checkDimension(v, 'dense');
      const patterns = live(grant.readNodes);
      // A zero query has no direction: it matches nothing (CON-141).
      if (k <= 0 || patterns.length === 0 || isZeroVector(v)) return [];
      const kk = Math.min(Math.floor(k), MAX_KNN);
      const sp = searchOpts?.spatial;
      const runs = denseRuns(patterns, v, kk, hasSpatialFilter(sp) ? sp : undefined);
      let rows = runs[0] ?? [];
      if (runs.length > 1) {
        // Patterns may overlap: one row per id, in the order a single query would give.
        const byId = new Map(runs.flat().map((r) => [r.id, r]));
        rows = [...byId.values()]
          .sort(
            (x, y) =>
              x.distance - y.distance ||
              (x.updated_at < y.updated_at ? 1 : x.updated_at > y.updated_at ? -1 : 0) ||
              (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
          )
          .slice(0, kk);
      }
      return rows.map((r): Hit => ({ id: r.id, score: 1 - r.distance, tier: r.tier }));
    },

    async recordAccess(grant, ids, at) {
      open();
      assertGrant(grant);
      recordAccessTx.immediate(grant, ids, at);
    },

    async list(grant, listOpts = {}) {
      open();
      assertGrant(grant);
      const patterns = live(grant.readNodes);
      if (patterns.length === 0) return [];
      const validOnly = listOpts.validOnly ?? true;
      const now = clock();
      // One vec lookup per row: skipped when the caller does not want embeddings.
      const withEmbeddings = listOpts.embeddings !== false;
      return listScoped(patterns.length)
        .all({
          ...grantParams(patterns),
          tier: listOpts.tier ?? null,
          pinned: listOpts.pinned === true ? 1 : null,
        })
        .map((r) => fromRow(r, withEmbeddings ? embeddingOf(r.id) : undefined))
        .filter((m) => !validOnly || isCurrent(m, now))
        .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
    },

    async expireMany(grant, snapshots, at) {
      open();
      assertGrant(grant);
      const ms = [...new Map(snapshots.map((m) => [m.id, m])).values()];
      if (ms.length === 0) return { skipped: [] };
      return { skipped: expireManyTx.immediate(grant, ms, at.toISOString()) };
    },

    coldPut: (grant, m) => coldPutMany(grant, [m]),

    coldPutMany,

    /** A missing or corrupt blob (logged by id) reads as no cold copy. */
    async coldGet(grant, id) {
      open();
      assertGrant(grant);
      if (scopedRow(grant.readNodes, id) === undefined) return null;
      const row = q.coldPath.get(id);
      if (row === undefined) return null;
      const blob = blobs.read(row.path);
      if (blob === null) return null;
      let m: Memory;
      try {
        m = codec.decode(blob);
      } catch (e) {
        if (!(e instanceof ColdBlobCorruptError)) throw e;
        log(`oort store: cold blob for memory ${id} is corrupt; ignoring it`);
        return null;
      }
      // The blob carries its own address; a mismatched one is treated as missing.
      return grantReads(grant, m) ? m : null;
    },

    async setTier(grant, id, tier, snapshot) {
      open();
      assertGrant(grant);
      const changed = setTierTx.immediate(grant, id, tier, snapshot);
      rqAfterWrite();
      return changed;
    },

    async getCursor(grant, key) {
      open();
      assertGrant(grant);
      return q.getCursor.get(cursorKey(grant, key))?.value ?? null;
    },

    async setCursor(grant, key, value) {
      open();
      assertGrant(grant);
      q.setCursor.run(cursorKey(grant, key), value);
    },

    async close() {
      if (closed) return;
      closed = true;
      stopRqTimer();
      rqReader.release();
      db.close();
    },
  };
  TICKS.set(handle, () => {
    try {
      rqRefresh();
    } catch {
      // Busy or closing: the next tick, or the next search, tries again.
    }
  });
  selfRef = new WeakRef(handle);
  // Dropped without close(): its engine (about 110 bytes a vector) is zeroed and freed.
  DROPPED.register(handle, () => {
    stopRqTimer();
    rqReader.release();
  });
  return handle;
}
