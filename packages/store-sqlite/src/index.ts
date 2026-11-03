import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  appendAccess,
  isCurrent,
  tokenizeLexical,
  type AccessLog,
  type Hit,
  type Memory,
  type MemorySource,
  type MemoryStore,
  type Scope,
  type ScopeFilter,
  type Tier,
} from '@oortmem/core';
import { createColdCodec } from './cold.js';
import { applySchema } from './schema.js';

export { createColdCodec, type ColdCodec } from './cold.js';

export interface SqliteStoreOptions {
  /** The SQLite database file; its directory is created if missing. */
  path: string;
  /** Directory for cold blobs (`<id>.zst`); created if missing. */
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
   * One-line maintenance notices (orphan sweeps, tightened permissions). They
   * carry counts only, never paths or memory content. Defaults to stderr.
   */
  log?: (message: string) => void;
}

/** A `.zst.tmp` older than this is a crashed write. */
const STALE_TMP_MS = 60 * 60 * 1000;
/**
 * An unreferenced `.zst` younger than this may belong to another process's
 * `coldPut` that has renamed its blob but not yet committed (it can wait up to
 * the 5 s busy timeout), so the sweep leaves it for a later open.
 */
const ORPHAN_GRACE_MS = 60 * 1000;

/** sqlite-vec's upper bound on `k` in a KNN query. */
const MAX_KNN = 4096;

interface MemoryRow {
  rid: number;
  id: string;
  org_id: string;
  customer_id: string;
  agent_id: string;
  project_id: string | null;
  scope_extra: string | null;
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

/** The vec0 partition for a scope's (org, customer, agent). */
function scopeKey(orgId: string, customerId: string, agentId: string): string {
  return JSON.stringify([orgId, customerId, agentId]);
}

/** vec0 metadata cannot be NULL, so global (no project) gets its own key. */
function projectKey(projectId: string | null | undefined): string {
  return projectId === null || projectId === undefined ? 'g' : `p:${projectId}`;
}

/** Ids that are safe, case-insensitive-unique file names are used as is; anything else is hashed. */
function coldFileName(id: string): string {
  return /^[a-z0-9_-]{1,128}$/.test(id)
    ? `${id}.zst`
    : `~${createHash('sha256').update(id).digest('hex')}.zst`;
}

function toBytes(v: Int8Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function toRow(m: Memory): RowParams {
  const { orgId, customerId, agentId, projectId, ...extra } = m.scope;
  return {
    id: m.id,
    org_id: orgId,
    customer_id: customerId,
    agent_id: agentId,
    project_id: projectId ?? null,
    scope_extra: Object.keys(extra).length === 0 ? null : JSON.stringify(extra),
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
  };
}

function fromRow(r: MemoryRow, embedding: Int8Array | undefined): Memory {
  const scope: Scope = {
    orgId: r.org_id,
    customerId: r.customer_id,
    agentId: r.agent_id,
    ...(r.project_id !== null && { projectId: r.project_id }),
    ...(r.scope_extra !== null && (JSON.parse(r.scope_extra) as object)),
  };
  const m: Memory = {
    id: r.id,
    scope,
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
  if (embedding !== undefined) m.embedding = embedding;
  return m;
}

const COLUMNS: (keyof RowParams)[] = [
  'id',
  'org_id',
  'customer_id',
  'agent_id',
  'project_id',
  'scope_extra',
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
];

/** Scope predicate over `memories` aliased `m`; bound with `scopeParams`. */
const SCOPE_SQL = `m.org_id = @org AND m.customer_id = @customer AND m.agent_id = @agent
  AND (m.project_id IN (SELECT value FROM json_each(@projects)) OR (@global AND m.project_id IS NULL))`;

function scopeParams(s: ScopeFilter) {
  return {
    org: s.orgId,
    customer: s.customerId,
    agent: s.agentId,
    projects: JSON.stringify(s.projectIds.filter((p): p is string => p !== null)),
    global: s.projectIds.includes(null) ? 1 : 0,
  };
}

function unlinkQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** Creates `dir` owner-only, or tightens an existing one; returns true when it had to tighten. */
function ensureOwnerDir(dir: string): boolean {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return false;
  if ((fs.statSync(dir).mode & 0o077) === 0) return false;
  fs.chmodSync(dir, 0o700);
  return true;
}

function chmodIfExists(file: string, mode: number): void {
  try {
    fs.chmodSync(file, mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/**
 * Runs `fn` with umask 077 so files SQLite creates (`-wal`, `-shm`) are
 * owner-only. `process.umask` cannot be set in worker threads; there the
 * explicit chmods after open are the only guard.
 */
function withPrivateUmask<T>(fn: () => T): T {
  let previous: number | undefined;
  try {
    previous = process.umask(0o077);
  } catch {
    previous = undefined;
  }
  try {
    return fn();
  } finally {
    if (previous !== undefined) process.umask(previous);
  }
}

/** Opens a new owner-only file exclusively; a leftover file at `file` is removed and the open retried once. */
function openExclusive(file: string): number {
  try {
    return fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    unlinkQuietly(file);
    return fs.openSync(file, 'wx', 0o600);
  }
}

/** Best-effort fsync of a directory so a rename survives a crash (not supported everywhere). */
function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Windows cannot open directories; the rename is still atomic.
  }
}

/**
 * Writes `data` to `file` atomically: an owner-only temp file ending in
 * `.zst.tmp` (unique per writer, so concurrent `coldPut`s of one id never
 * write into the same temp file), fsync, rename. Readers never see a partial blob.
 */
function writeAtomically(file: string, data: Uint8Array): void {
  const tmp = `${file.slice(0, -'.zst'.length)}.${process.pid}-${randomBytes(4).toString('hex')}.zst.tmp`;
  const fd = openExclusive(tmp);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    unlinkQuietly(tmp);
    throw e;
  }
  fsyncDir(path.dirname(file));
}

/**
 * Removes crash leftovers from `coldDir`: `.zst.tmp` files older than an hour
 * (an interrupted write) and `.zst` blobs no `cold_index` row references (a
 * `coldPut` whose transaction never committed), past a short grace period.
 * Other files are left alone. Logs counts only.
 */
function sweepColdDir(db: Database.Database, coldDir: string, log: (message: string) => void) {
  const referenced = new Set(
    db
      .prepare<[], { path: string }>('SELECT path FROM cold_index')
      .all()
      .map((r) => r.path),
  );
  const now = Date.now();
  let tmps = 0;
  let orphans = 0;
  for (const name of fs.readdirSync(coldDir)) {
    const file = path.join(coldDir, name);
    const isTmp = name.endsWith('.zst.tmp');
    if (!isTmp && (!name.endsWith('.zst') || referenced.has(name))) continue;
    let age: number;
    try {
      age = now - fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (age < (isTmp ? STALE_TMP_MS : ORPHAN_GRACE_MS)) continue;
    unlinkQuietly(file);
    if (isTmp) tmps++;
    else orphans++;
  }
  if (tmps + orphans > 0) {
    log(`oort store: removed ${orphans} orphan cold blob(s) and ${tmps} stale temp file(s)`);
  }
}

/**
 * Opens (creating if needed) a SQLite-backed `MemoryStore`: rows in `memories`,
 * lexical search through FTS5, dense search through sqlite-vec (int8, cosine),
 * cold copies as zstd blobs under `coldDir`. Safe to open from several
 * processes at once (WAL, 5 s busy timeout, IMMEDIATE write transactions).
 * Every method is async per the contract; the work underneath is synchronous.
 */
export async function openSqliteStore(opts: SqliteStoreOptions): Promise<MemoryStore> {
  const { dimension } = opts;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new RangeError(`sqlite store: dimension must be a positive integer, got ${dimension}`);
  }
  const d = opts.d ?? 0.5;
  const clock = opts.now ?? (() => new Date());
  const log = opts.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const dbPath = path.resolve(opts.path);
  const coldDir = path.resolve(opts.coldDir);
  const tightened = [path.dirname(dbPath), coldDir].filter(ensureOwnerDir).length;
  if (tightened > 0) {
    log(
      `oort store: tightened permissions to 0700 on ${tightened} existing director${tightened === 1 ? 'y' : 'ies'}`,
    );
  }
  if (!fs.existsSync(dbPath)) fs.closeSync(fs.openSync(dbPath, 'a', 0o600));

  const db = withPrivateUmask(() => {
    const conn = new Database(dbPath);
    try {
      conn.pragma('busy_timeout = 5000');
      conn.pragma('journal_mode = WAL');
      conn.pragma('foreign_keys = ON');
      sqliteVec.load(conn);
      applySchema(conn, dimension);
      return conn;
    } catch (e) {
      conn.close();
      throw e;
    }
  });
  try {
    if (process.platform !== 'win32') {
      for (const suffix of ['', '-wal', '-shm']) chmodIfExists(`${dbPath}${suffix}`, 0o600);
    }
    sweepColdDir(db, coldDir, log);
  } catch (e) {
    db.close();
    throw e;
  }

  const codec = createColdCodec();

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
    getAccess: db.prepare<[string], { access_log: string }>(
      'SELECT access_log FROM memories WHERE id = ?',
    ),
    setAccess: db.prepare<[string, string]>('UPDATE memories SET access_log = ? WHERE id = ?'),
    list: db.prepare<[ReturnType<typeof scopeParams> & { tier: Tier | null }], MemoryRow>(
      `SELECT * FROM memories m WHERE ${SCOPE_SQL} AND (@tier IS NULL OR m.tier = @tier)
       ORDER BY m.rid`,
    ),
    lexical: db.prepare<
      [ReturnType<typeof scopeParams> & { match: string; k: number }],
      { id: string; tier: Tier; rank: number }
    >(
      `SELECT m.id AS id, m.tier AS tier, bm25(memories_fts) AS rank
       FROM memories_fts JOIN memories m ON m.rid = memories_fts.rowid
       WHERE memories_fts MATCH @match AND ${SCOPE_SQL}
       ORDER BY rank, m.updated_at DESC, m.id
       LIMIT @k`,
    ),
    dense: db.prepare<
      [
        ReturnType<typeof scopeParams> & {
          v: Buffer;
          k: number;
          scopeKey: string;
          projectKeys: string;
        },
      ],
      { id: string; distance: number; tier: Tier }
    >(
      `WITH knn AS (
         SELECT id, distance FROM memories_vec
         WHERE embedding MATCH vec_int8(@v) AND k = @k AND scope_key = @scopeKey
           AND project_key IN (SELECT value FROM json_each(@projectKeys)) AND tier != 'cold'
       )
       SELECT knn.id AS id, knn.distance AS distance, m.tier AS tier
       FROM knn JOIN memories m ON m.id = knn.id
       WHERE m.tier != 'cold' AND ${SCOPE_SQL}
       ORDER BY knn.distance, m.updated_at DESC, m.id`,
    ),
    ftsDelete: db.prepare<[number]>('DELETE FROM memories_fts WHERE rowid = ?'),
    ftsInsert: db.prepare<[number, string, string, string]>(
      'INSERT INTO memories_fts (rowid, text, stub, entities) VALUES (?, ?, ?, ?)',
    ),
    vecGet: db.prepare<[string], { embedding: Buffer }>(
      'SELECT embedding FROM memories_vec WHERE id = ?',
    ),
    vecDelete: db.prepare<[string]>('DELETE FROM memories_vec WHERE id = ?'),
    vecInsert: db.prepare<[string, Buffer, string, string, Tier]>(
      `INSERT INTO memories_vec (id, embedding, scope_key, project_key, tier)
       VALUES (?, vec_int8(?), ?, ?, ?)`,
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
  };

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
   * Writes one memory's row, FTS row and vec row. Call inside a transaction.
   * Returns `[id, blob]` to unlink after commit when a non-cold write dropped the cold copy.
   */
  function writeMemory(m: Memory): [string, string][] {
    if (m.embedding !== undefined) checkDimension(m.embedding, `upsert ${m.id}`);
    const row = q.upsertRow.get(toRow(m));
    if (row === undefined) throw new Error(`upsert ${m.id}: no row returned`);
    writeFts(row.rid, m.tier, m.text, m.stub, m.entities);
    q.vecDelete.run(m.id);
    if (m.embedding !== undefined) {
      const s = m.scope;
      q.vecInsert.run(
        m.id,
        toBytes(m.embedding),
        scopeKey(s.orgId, s.customerId, s.agentId),
        projectKey(s.projectId),
        m.tier,
      );
    }
    if (m.tier === 'cold') return [];
    const dropped = q.coldDelete.get(m.id);
    return dropped === undefined ? [] : [[m.id, dropped.path]];
  }

  const writeAll = db.transaction((ms: Memory[]) => ms.flatMap(writeMemory));

  /**
   * Unlinks a cold blob whose `cold_index` row a committed transaction deleted,
   * unless another process has since re-referenced it with its own `coldPut`.
   */
  function dropBlob(id: string, file: string): void {
    if (q.coldPath.get(id) === undefined) unlinkQuietly(path.join(coldDir, file));
  }

  function upsertMany(ms: Memory[]): void {
    for (const [id, file] of writeAll.immediate(ms)) dropBlob(id, file);
  }

  const forgetTx = db.transaction((id: string): string | undefined => {
    const row = q.deleteRow.get(id);
    if (row !== undefined) q.ftsDelete.run(row.rid);
    q.vecDelete.run(id);
    return q.coldDelete.get(id)?.path;
  });

  const recordAccessTx = db.transaction((ids: string[], at: Date) => {
    for (const id of ids) {
      const row = q.getAccess.get(id);
      if (row === undefined) continue;
      const log = appendAccess(JSON.parse(row.access_log) as AccessLog, at, { d });
      q.setAccess.run(JSON.stringify(log), id);
    }
  });

  const setTierTx = db.transaction((id: string, tier: Tier) => {
    const row = q.setTierRow.get(tier, id);
    if (row === undefined) return;
    q.vecSetTier.run(tier, id);
    writeFts(row.rid, tier, row.text, row.stub, JSON.parse(row.entities) as string[]);
  });

  const coldPutTx = db.transaction((m: Memory, file: string) => {
    const { embedding: _dropped, ...rest } = m;
    writeMemory({ ...rest, tier: 'cold' });
    q.coldInsert.run(m.id, file);
  });

  return {
    async upsert(m) {
      open();
      upsertMany([m]);
    },

    async upsertMany(ms) {
      open();
      upsertMany(ms);
    },

    async get(id) {
      open();
      const row = q.getRow.get(id);
      return row === undefined ? null : fromRow(row, embeddingOf(id));
    },

    async forget(id) {
      open();
      const file = forgetTx.immediate(id);
      if (file !== undefined) dropBlob(id, file);
    },

    /** BM25 over normalised tokens, any-token match; `score` is -bm25 (higher is better). */
    async lexical(text, scope, k) {
      open();
      const match = matchQuery(text);
      if (match === null || k <= 0 || scope.projectIds.length === 0) return [];
      return q.lexical
        .all({ ...scopeParams(scope), match, k: Math.floor(k) })
        .map((r): Hit => ({ id: r.id, score: -r.rank, tier: r.tier }));
    },

    /** KNN filtered inside vec0 by scope partition and project/tier metadata; `score` is cosine similarity. */
    async dense(v, scope, k) {
      open();
      checkDimension(v, 'dense');
      if (k <= 0 || scope.projectIds.length === 0) return [];
      return q.dense
        .all({
          ...scopeParams(scope),
          v: toBytes(v),
          k: Math.min(Math.floor(k), MAX_KNN),
          scopeKey: scopeKey(scope.orgId, scope.customerId, scope.agentId),
          projectKeys: JSON.stringify(scope.projectIds.map(projectKey)),
        })
        .map((r): Hit => ({ id: r.id, score: 1 - r.distance, tier: r.tier }));
    },

    async recordAccess(ids, at) {
      open();
      recordAccessTx.immediate(ids, at);
    },

    async list(scope, listOpts = {}) {
      open();
      if (scope.projectIds.length === 0) return [];
      const validOnly = listOpts.validOnly ?? true;
      const now = clock();
      return q.list
        .all({ ...scopeParams(scope), tier: listOpts.tier ?? null })
        .map((r) => fromRow(r, embeddingOf(r.id)))
        .filter((m) => !validOnly || isCurrent(m, now))
        .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
    },

    async coldPut(m) {
      open();
      const file = coldFileName(m.id);
      const full = path.join(coldDir, file);
      writeAtomically(full, codec.encode(m));
      try {
        coldPutTx.immediate(m, file);
      } catch (e) {
        // Leave the blob only if a committed cold_index row still points at it
        // (an earlier coldPut of this id, or a concurrent one that won).
        if (q.coldPath.get(m.id)?.path !== file) unlinkQuietly(full);
        throw e;
      }
    },

    async coldGet(id) {
      open();
      const row = q.coldPath.get(id);
      if (row === undefined) return null;
      let blob: Buffer;
      try {
        blob = fs.readFileSync(path.join(coldDir, row.path));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
      return codec.decode(blob);
    },

    async setTier(id, tier) {
      open();
      setTierTx.immediate(id, tier);
    },

    async getCursor(key) {
      open();
      return q.getCursor.get(key)?.value ?? null;
    },

    async setCursor(key, value) {
      open();
      q.setCursor.run(key, value);
    },

    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
