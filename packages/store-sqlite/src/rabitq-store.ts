/**
 * The RaBitQ index in SQLite (schema version 7, CON-25): its tables, its build and drop, the
 * writes that keep it in step with the int8 vectors, and the in-memory engine a searching process
 * loads from it and keeps current. Design: `docs/design/2026-11-12-rabitq-index.md`.
 *
 * Tables (they exist only while the store has the index, `vectorIndex: 'rabitq'`):
 *
 * - `memories_rq`: one row per hot or warm memory with a vector, keyed by `memories.rid`: the
 *   int8 index's partition and filter keys, the code, the three factors, and `seq`, the change
 *   number of its last write.
 * - `memories_rq_vec`: the int8 vector of each, read only to rescore candidates (a point read
 *   into `memories_vec` reads a whole sqlite-vec chunk; design §3).
 * - `memories_rq_gone`: the row ids removed, with their change numbers, so another process's
 *   engine can drop them. Integers only; kept for the last `RQ_GONE_WINDOW` changes.
 * - `memories_rq_meta`: the change counter (`seq`), the oldest change still in
 *   `memories_rq_gone` (`floor`), the build's `generation` and the `centroid`.
 */
import { randomBytes } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import { BINARY_OVERSAMPLE, bitWidth } from './binary.js';
import {
  createRabitqEngine,
  rabitqEncode,
  rabitqQuery,
  rotatedCentroid,
  RABITQ_EPSILON,
  RABITQ_FACTORS,
  type RabitqEngine,
  type RabitqEngineChoice,
} from './rabitq.js';

export const RQ_TABLE = 'memories_rq';
export const RQ_VEC_TABLE = 'memories_rq_vec';
export const RQ_GONE_TABLE = 'memories_rq_gone';
export const RQ_META_TABLE = 'memories_rq_meta';

/**
 * How many changes `memories_rq_gone` remembers. A process whose engine is further behind than
 * that reloads it whole instead of applying the removals one by one.
 */
export const RQ_GONE_WINDOW = 100_000;

const exists = (db: Database, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
  undefined;

/** Whether the store has the RaBitQ index. */
export function hasRabitqIndex(db: Database): boolean {
  return exists(db, RQ_META_TABLE);
}

/** How many vectors the RaBitQ index holds. */
export function rabitqVectors(db: Database): number {
  return db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${RQ_TABLE}`).get()?.n ?? 0;
}

/**
 * The index's centroid is the mean of the vectors it was built from. A store that has grown
 * `RABITQ_RECENTRE_GROWTH` times since (and holds at least `RABITQ_RECENTRE_FROM` vectors) has
 * it rebuilt, with a new centroid, by the next open that may migrate: a store created empty with
 * `vectorIndex: 'rabitq'` would otherwise keep the zero centroid, and looser bounds, for good.
 * Geometric, so the rebuilds of a growing store cost a constant number of passes per vector.
 */
export const RABITQ_RECENTRE_FROM = 1_000;
export const RABITQ_RECENTRE_GROWTH = 4;

/** Whether the index has outgrown its centroid (see `RABITQ_RECENTRE_GROWTH`). */
export function rabitqNeedsRecentre(db: Database): boolean {
  const built = Number(
    db
      .prepare<[], { value: number }>(
        `SELECT value FROM ${RQ_META_TABLE} WHERE key = 'built_from'`,
      )
      .get()?.value ?? 0,
  );
  const due = Math.max(RABITQ_RECENTRE_FROM, RABITQ_RECENTRE_GROWTH * built);
  // `max(rid)` bounds the count from above in one lookup; most opens stop there.
  const top = db.prepare<[], { n: number | null }>(`SELECT max(rid) AS n FROM ${RQ_TABLE}`).get();
  if ((top?.n ?? 0) < due) return false;
  return rabitqVectors(db) >= due;
}

/** Drops the RaBitQ index's tables (inside the caller's transaction). */
export function dropRabitqIndex(db: Database): void {
  for (const t of [RQ_META_TABLE, RQ_GONE_TABLE, RQ_VEC_TABLE, RQ_TABLE]) {
    db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
}

function createTables(db: Database): void {
  db.exec(`
    CREATE TABLE ${RQ_TABLE} (
      rid INTEGER PRIMARY KEY,
      seq INTEGER NOT NULL,
      node_key TEXT NOT NULL,
      project_key TEXT NOT NULL,
      author_key TEXT NOT NULL,
      code BLOB NOT NULL,
      factors BLOB NOT NULL
    );
    CREATE INDEX ${RQ_TABLE}_by_seq ON ${RQ_TABLE} (seq);
    CREATE TABLE ${RQ_VEC_TABLE} (rid INTEGER PRIMARY KEY, embedding BLOB NOT NULL);
    CREATE TABLE ${RQ_GONE_TABLE} (seq INTEGER PRIMARY KEY, rid INTEGER NOT NULL);
    CREATE TABLE ${RQ_META_TABLE} (key TEXT PRIMARY KEY, value);
  `);
}

const toInt8 = (b: Buffer): Int8Array => new Int8Array(b.buffer, b.byteOffset, b.byteLength);
const factorBytes = (f: Float32Array): Buffer => Buffer.from(f.buffer, f.byteOffset, f.byteLength);

/** The rows a build reads: every hot and warm memory's int8 vector and keys, by rid. */
function pageOfVectors(db: Database) {
  return db.prepare<
    [number],
    { rid: number; embedding: Buffer; node_key: string; project_key: string; author_key: string }
  >(
    `SELECT m.rid AS rid, v.embedding AS embedding, v.node_key AS node_key,
            v.project_key AS project_key, v.author_key AS author_key
     FROM memories m CROSS JOIN memories_vec v ON v.id = m.id
     WHERE m.rid > ? AND m.tier != 'cold' ORDER BY m.rid LIMIT 1000`,
  );
}

/**
 * Creates the RaBitQ index and fills it from the int8 vectors of every hot and warm memory,
 * inside the caller's transaction (a migration's). Two passes over the vectors: the first for
 * the centroid (their mean), the second to encode them. Says how many it indexes first.
 */
export function buildRabitqIndex(
  db: Database,
  dimension: number,
  log?: (message: string) => void,
): number {
  const page = pageOfVectors(db);
  const sum = new Float64Array(dimension);
  let n = 0;
  for (let after = -Infinity; ; ) {
    const rows = page.all(after);
    if (rows.length === 0) break;
    for (const r of rows) {
      const v = toInt8(r.embedding);
      for (let i = 0; i < dimension; i++) sum[i] = (sum[i] as number) + (v[i] as number);
      n++;
      after = r.rid;
    }
  }
  createTables(db);
  if (n > 0) log?.(`Building the RaBitQ vector index (${n} ${n === 1 ? 'vector' : 'vectors'})…`);
  const centroid = n === 0 ? undefined : sum.map((x) => x / n);
  const meta = db.prepare(`INSERT INTO ${RQ_META_TABLE} (key, value) VALUES (?, ?)`);
  meta.run('generation', randomBytes(8).toString('hex'));
  meta.run('seq', 0);
  meta.run('floor', 0);
  meta.run('width', bitWidth(dimension));
  meta.run('built_from', n);
  if (centroid !== undefined) {
    meta.run('centroid', Buffer.from(centroid.buffer, centroid.byteOffset, centroid.byteLength));
  }
  const rc = rotatedCentroid(centroid, dimension);
  const put = db.prepare<[number, string, string, string, Buffer, Buffer]>(
    `INSERT INTO ${RQ_TABLE} (rid, seq, node_key, project_key, author_key, code, factors)
     VALUES (?, 0, ?, ?, ?, ?, ?)`,
  );
  const putVec = db.prepare<[number, Buffer]>(
    `INSERT INTO ${RQ_VEC_TABLE} (rid, embedding) VALUES (?, ?)`,
  );
  let done = 0;
  for (let after = -Infinity; ; ) {
    const rows = page.all(after);
    if (rows.length === 0) break;
    for (const r of rows) {
      const { code, factors } = rabitqEncode(toInt8(r.embedding), rc);
      put.run(r.rid, r.node_key, r.project_key, r.author_key, code, factorBytes(factors));
      putVec.run(r.rid, r.embedding);
      done++;
      after = r.rid;
    }
  }
  return done;
}

/** The centroid a build stored, as float64s, or undefined (an index built empty). */
function readCentroid(db: Database): Float64Array | undefined {
  const row = db
    .prepare<[], { value: Buffer }>(`SELECT value FROM ${RQ_META_TABLE} WHERE key = 'centroid'`)
    .get();
  if (row === undefined) return undefined;
  const b = Buffer.from(row.value); // aligned copy
  return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8);
}

const metaNumber = (db: Database, key: string): number =>
  Number(
    db
      .prepare<[string], { value: number }>(`SELECT value FROM ${RQ_META_TABLE} WHERE key = ?`)
      .get(key)?.value ?? 0,
  );

/**
 * The writes that keep the RaBitQ index in step, for one connection. Each call checks that the
 * index exists (another process may build or drop it while this one is open) and runs inside the
 * caller's write transaction.
 */
export function rabitqWriter(db: Database, dimension: number) {
  const tableExists = db.prepare<[string], { x: number }>(
    "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  let st:
    | {
        generation: Statement<[], { value: string }>;
        bump: Statement<[], { value: number }>;
        put: Statement<[number, number, string, string, string, Buffer, Buffer]>;
        putVec: Statement<[number, Buffer]>;
        del: Statement<[number], { rid: number }>;
        delVec: Statement<[number]>;
        gone: Statement<[number, number]>;
        prune: Statement<[number]>;
        floor: Statement<[number]>;
        vecRow: Statement<
          [string],
          { embedding: Buffer; node_key: string; project_key: string; author_key: string; tier: string }
        >;
      }
    | undefined;
  let centroidFor: { generation: string; rc: Float64Array } | undefined;

  function statements(): typeof st {
    if (tableExists.get(RQ_META_TABLE) === undefined) {
      st = undefined;
      return undefined;
    }
    st ??= {
      generation: db.prepare(`SELECT value FROM ${RQ_META_TABLE} WHERE key = 'generation'`),
      bump: db.prepare(
        `UPDATE ${RQ_META_TABLE} SET value = value + 1 WHERE key = 'seq' RETURNING value`,
      ),
      put: db.prepare(
        `INSERT INTO ${RQ_TABLE} (rid, seq, node_key, project_key, author_key, code, factors)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (rid) DO UPDATE SET seq = excluded.seq, node_key = excluded.node_key,
           project_key = excluded.project_key, author_key = excluded.author_key,
           code = excluded.code, factors = excluded.factors`,
      ),
      putVec: db.prepare(
        `INSERT INTO ${RQ_VEC_TABLE} (rid, embedding) VALUES (?, ?)
         ON CONFLICT (rid) DO UPDATE SET embedding = excluded.embedding`,
      ),
      del: db.prepare(`DELETE FROM ${RQ_TABLE} WHERE rid = ? RETURNING rid`),
      delVec: db.prepare(`DELETE FROM ${RQ_VEC_TABLE} WHERE rid = ?`),
      gone: db.prepare(`INSERT INTO ${RQ_GONE_TABLE} (seq, rid) VALUES (?, ?)`),
      prune: db.prepare(`DELETE FROM ${RQ_GONE_TABLE} WHERE seq <= ?`),
      floor: db.prepare(
        `UPDATE ${RQ_META_TABLE} SET value = max(value, ?) WHERE key = 'floor'`,
      ),
      vecRow: db.prepare(
        `SELECT embedding, node_key, project_key, author_key, tier FROM memories_vec WHERE id = ?`,
      ),
    };
    return st;
  }

  function rcOf(s: NonNullable<typeof st>): Float64Array {
    const generation = s.generation.get()?.value ?? '';
    if (centroidFor?.generation !== generation) {
      centroidFor = { generation, rc: rotatedCentroid(readCentroid(db), dimension) };
    }
    return centroidFor.rc;
  }

  const nextSeq = (s: NonNullable<typeof st>): number => Number(s.bump.get()?.value);

  function remove(s: NonNullable<typeof st>, rid: number): void {
    s.delVec.run(rid);
    if (s.del.get(rid) === undefined) return;
    const seq = nextSeq(s);
    s.gone.run(seq, rid);
    if (seq > RQ_GONE_WINDOW) {
      s.prune.run(seq - RQ_GONE_WINDOW);
      s.floor.run(seq - RQ_GONE_WINDOW);
    }
  }

  return {
    /** Whether the store has the index (checked on every call). */
    present(): boolean {
      return statements() !== undefined;
    },

    /**
     * Makes memory `rid`'s row match: present with this vector and keys while `searchable`,
     * absent otherwise.
     */
    put(
      rid: number,
      embedding: Buffer | undefined,
      keys: { node: string; project: string; author: string },
      searchable: boolean,
    ): void {
      const s = statements();
      if (s === undefined) return;
      if (embedding === undefined || !searchable) {
        remove(s, rid);
        return;
      }
      const { code, factors } = rabitqEncode(toInt8(embedding), rcOf(s));
      s.put.run(rid, nextSeq(s), keys.node, keys.project, keys.author, code, factorBytes(factors));
      s.putVec.run(rid, embedding);
    },

    /** Removes memory `rid`'s row (forget, cold). */
    remove(rid: number): void {
      const s = statements();
      if (s !== undefined) remove(s, rid);
    },

    /** Makes memory `rid`'s row match its int8 row in `memories_vec` (a tier change). */
    sync(rid: number, id: string): void {
      const s = statements();
      if (s === undefined) return;
      const row = s.vecRow.get(id);
      if (row === undefined || row.tier === 'cold') {
        remove(s, rid);
        return;
      }
      this.put(
        rid,
        row.embedding,
        { node: row.node_key, project: row.project_key, author: row.author_key },
        true,
      );
    },
  };
}

export type RabitqWriter = ReturnType<typeof rabitqWriter>;

/** One rescored row, as the store's dense statements return them. */
export interface RescoredRow {
  id: string;
  distance: number;
  tier: string;
  updated_at: string;
}

/** What `RabitqReader.search` reports about one pattern's query (`onDenseStats`). */
export interface RabitqSearchStats {
  candidates: number;
  reads: number;
  /** The read budget (`RABITQ_MAX_READS_PER_K` x k) stopped the rescoring before the bound did. */
  capped: boolean;
}

/**
 * At most this many rescoring reads per result: the binary index's oversampling, so the RaBitQ
 * index never reads more than it does. The bound alone needs more only where the k-th score sits
 * in a flat stretch of near-equal scores (measured: 20,000 vectors in 2,000 small clusters, where
 * the 50th hit is any of thousands of unrelated vectors); there the candidates are taken in
 * order of their upper bound, which still holds the top of the list (design §4).
 */
export const RABITQ_MAX_READS_PER_K = BINARY_OVERSAMPLE;

/**
 * Batches of candidates rescored after the first `k`: small, so few more are read than the
 * one-at-a-time stop would read.
 */
const RESCORE_BATCH = 16;
/** Float32 distances against float64 bounds: a candidate this close to the k-th is rescored. */
const SLACK = 1e-6;

/** The k-th exact cosine so far, less the slack (minus infinity before k rows). */
const kthNow = (top: RescoredRow[], k: number): number =>
  top.length >= k ? 1 - (top[k - 1] as RescoredRow).distance - SLACK : -Infinity;

const order = (x: RescoredRow, y: RescoredRow): number =>
  x.distance - y.distance ||
  (x.updated_at < y.updated_at ? 1 : x.updated_at > y.updated_at ? -1 : 0) ||
  (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * A process's in-memory copy of the RaBitQ index and its search. Loaded on the first search,
 * then brought up to date before each search (and after each write this process commits) from
 * the change numbers: the rows written since, and the removals since (`memories_rq_gone`). A
 * new build (another `generation`), or a gap longer than `memories_rq_gone` remembers, reloads it
 * whole.
 */
export class RabitqReader {
  private engine: RabitqEngine | undefined;
  kind: 'native' | 'typescript' | undefined;
  fallback: string | undefined;
  private generation = '';
  private seq = -1;
  private rc: Float64Array = new Float64Array(0);
  private readonly keys = [new Map<string, number>(), new Map<string, number>(), new Map<string, number>()];
  private stmts:
    | {
        meta: Statement<[], { key: string; value: unknown }>;
        all: Statement<[], unknown[]>;
        since: Statement<[number], unknown[]>;
        gone: Statement<[number], { rid: number }>;
      }
    | undefined;

  constructor(
    private readonly db: Database,
    private readonly dimension: number,
    private readonly choice: RabitqEngineChoice,
    private readonly log: (message: string) => void,
  ) {}

  /** Prepared on first use: the tables exist only while the store has the index. */
  private get st(): NonNullable<RabitqReader['stmts']> {
    const cols = 'rid, node_key, project_key, author_key, code, factors';
    this.stmts ??= {
      meta: this.db.prepare(
        `SELECT key, value FROM ${RQ_META_TABLE} WHERE key IN ('generation', 'seq', 'floor')`,
      ),
      all: this.db.prepare<[], unknown[]>(`SELECT ${cols} FROM ${RQ_TABLE}`).raw(true),
      since: this.db
        .prepare<[number], unknown[]>(`SELECT ${cols} FROM ${RQ_TABLE} WHERE seq > ?`)
        .raw(true),
      gone: this.db.prepare(`SELECT rid FROM ${RQ_GONE_TABLE} WHERE seq > ?`),
    };
    return this.stmts;
  }

  private intern(kind: 0 | 1 | 2, key: string): number {
    const m = this.keys[kind] as Map<string, number>;
    let n = m.get(key);
    if (n === undefined) {
      n = m.size;
      m.set(key, n);
    }
    return n;
  }

  /** Feeds rows (`rid, node_key, project_key, author_key, code, factors`) to the engine. */
  private feed(rows: Iterable<unknown[]>): void {
    const engine = this.engine as RabitqEngine;
    const bytes = bitWidth(this.dimension) / 8;
    const B = 4096;
    const rids = new Uint32Array(B);
    const nodes = new Uint32Array(B);
    const projects = new Uint32Array(B);
    const authors = new Uint32Array(B);
    const codes = Buffer.alloc(B * bytes);
    const factors = new Float32Array(B * RABITQ_FACTORS);
    const fb = Buffer.from(factors.buffer);
    let n = 0;
    const flush = () => {
      if (n === 0) return;
      engine.upsert(
        rids.subarray(0, n),
        nodes.subarray(0, n),
        projects.subarray(0, n),
        authors.subarray(0, n),
        codes.subarray(0, n * bytes),
        factors.subarray(0, n * RABITQ_FACTORS),
      );
      n = 0;
    };
    for (const r of rows) {
      const rid = r[0] as number;
      if (!Number.isInteger(rid) || rid < 0 || rid > 0xffffffff) {
        throw new Error(`rabitq: row id ${rid} does not fit the index`);
      }
      rids[n] = rid;
      nodes[n] = this.intern(0, r[1] as string);
      projects[n] = this.intern(1, r[2] as string);
      authors[n] = this.intern(2, r[3] as string);
      (r[4] as Buffer).copy(codes, n * bytes);
      (r[5] as Buffer).copy(fb, n * RABITQ_FACTORS * 4);
      if (++n === B) flush();
    }
    flush();
    // Scrub the staging buffers: they held codes.
    codes.fill(0);
    factors.fill(0);
  }

  /** Brings the engine up to date. Call inside a read transaction (one snapshot). */
  refresh(): void {
    const meta = new Map(this.st.meta.all().map((r) => [r.key, r.value]));
    const generation = String(meta.get('generation') ?? '');
    const seq = Number(meta.get('seq') ?? 0);
    const floor = Number(meta.get('floor') ?? 0);
    if (this.engine !== undefined && generation === this.generation && seq === this.seq) return;
    if (this.engine === undefined) {
      const made = createRabitqEngine(bitWidth(this.dimension), this.choice);
      this.engine = made.engine;
      this.kind = made.kind;
      this.fallback = made.fallback;
      if (made.fallback !== undefined) {
        this.log(
          `oort store: the native RaBitQ engine is unavailable (${made.fallback}); dense search uses the TypeScript engine`,
        );
      }
    }
    if (generation !== this.generation || this.seq < floor || seq < this.seq) {
      this.engine.clear();
      this.rc = rotatedCentroid(readCentroid(this.db), this.dimension);
      this.feed(this.st.all.iterate());
    } else {
      const gone = this.st.gone.all(this.seq).map((r) => r.rid);
      if (gone.length > 0) this.engine.remove(Uint32Array.from(gone));
      this.feed(this.st.since.iterate(this.seq));
    }
    this.generation = generation;
    this.seq = seq;
  }

  /** Drops the in-memory copy, zeroing it (the index was dropped, or the store closes). */
  release(): void {
    this.engine?.clear();
    this.engine = undefined;
    this.generation = '';
    this.seq = -1;
    for (const m of this.keys) m.clear();
    this.stmts = undefined;
  }

  /** How many vectors the engine holds and the bytes it uses (after a refresh). */
  stats(): { vectors: number; heapBytes: number } {
    return { vectors: this.engine?.size ?? 0, heapBytes: this.engine?.heapBytes() ?? 0 };
  }

  /**
   * The best `k` rows for one pattern: the engine's candidates (in `node`, in `projects` when
   * given, by `author` when given, with a row id in `allow` when given), rescored by `rescore`
   * (which applies every filter again and returns only rows that pass), best upper bound first,
   * until the next upper bound is below the k-th exact cosine. Call after `refresh`, in the same
   * transaction.
   */
  search(
    v: Int8Array,
    k: number,
    filter: {
      node: string;
      projects?: readonly string[];
      author?: string;
      allow?: readonly number[];
    },
    rescore: (rids: number[]) => RescoredRow[],
    stats?: (s: RabitqSearchStats) => void,
  ): RescoredRow[] {
    const engine = this.engine;
    if (engine === undefined || k <= 0) return [];
    const [nodes, projectKeys, authors] = this.keys as [
      Map<string, number>,
      Map<string, number>,
      Map<string, number>,
    ];
    const node = nodes.get(filter.node);
    const author = filter.author === undefined ? null : authors.get(filter.author);
    const projects =
      filter.projects === undefined
        ? null
        : Uint32Array.from(
            filter.projects.flatMap((p) => {
              const n = projectKeys.get(p);
              return n === undefined ? [] : [n];
            }),
          );
    if (node === undefined || author === undefined || projects?.length === 0) {
      stats?.({ candidates: 0, reads: 0, capped: false });
      return [];
    }
    const { query, cq } = rabitqQuery(v, this.rc);
    const allow = filter.allow === undefined ? null : Uint32Array.from(filter.allow);
    const c = engine.search(query, cq, k, RABITQ_EPSILON, node, projects, author, allow);
    let top: RescoredRow[] = [];
    let reads = 0;
    let i = 0;
    const budget = Math.max(k, RABITQ_MAX_READS_PER_K * k);
    while (i < c.rids.length && reads < budget) {
      const full = top.length >= k;
      const kth = kthNow(top, k);
      if ((c.upper[i] as number) < kth) break;
      const size = Math.min(full ? RESCORE_BATCH : k - top.length, budget - reads);
      const batch: number[] = [];
      while (i < c.rids.length && batch.length < size && (c.upper[i] as number) >= kth) {
        batch.push(c.rids[i] as number);
        i++;
      }
      reads += batch.length;
      top = [...top, ...rescore(batch)].sort(order).slice(0, k);
    }
    stats?.({
      candidates: c.rids.length,
      reads,
      capped: reads >= budget && i < c.rids.length && (c.upper[i] as number) >= kthNow(top, k),
    });
    return top;
  }
}
