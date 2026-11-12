import type { Database } from 'better-sqlite3';
import {
  checkPlace,
  hasSegmentedScript,
  lexicalIcuVersion,
  LEXICAL_VERSION,
  nodeKey,
  placeBox,
  tokenizerForVersion,
  type NodeRef,
} from '@oortmem/core';
import { BINARY_AUTO_THRESHOLD, binaryCode, bitWidth } from './binary.js';
import {
  buildRabitqIndex,
  dropRabitqIndex,
  hasRabitqIndex,
  rabitqNeedsRecentre,
} from './rabitq-store.js';

/**
 * 1: the Phase 1 store, one (org, customer, agent) scope per memory.
 * 2: levels (CON-61). Every memory has an address (`level` plus the fields
 *    that level has) and an author; Phase 1 memories become the owner's
 *    Planet, written by the agent that was their `agent_id`.
 * 3: judgment memory (CON-71). One nullable column, `judgment`, holds a `judgment` memory's
 *    decision as JSON; every other row has NULL. Additive: nothing else changes.
 * 4: tokeniser v2 (CON-110). The lexical index is `memories_fts2` (`FTS_TABLE`, renamed from
 *    `memories_fts`), declared with `FTS_TOKENIZE`, and holds core's
 *    version 2 tokens (CJK bigrams, Thai words, combining marks kept, Latin accents folded).
 *    `meta` records `lexical_version` and the ICU version the index was built with. The
 *    migration rebuilds the index from stored text; nothing else changes.
 * 5: spatial memory (CON-84). Two nullable columns, `place` (a memory's place as JSON) and
 *    `place_node` (its `nodeId`), and the R*Tree `memories_place` (`PLACE_TABLE`): one row per
 *    memory with coordinates, keyed by `rid`. Additive: no row, index or vector is rewritten.
 * 6: binary vector index (CON-17). Three triggers on `memories` call `oort_writer_v6()`
 *    (`WRITER_GUARD`), which only this version's connections define, so a writer that predates
 *    it fails loudly instead of leaving the index behind. The binary index itself,
 *    `memories_vec_bit` (`BIT_TABLE`), is built from the int8 vectors when the store asks for it
 *    (`vectorIndex`) and dropped again by `vectorIndex: 'int8'`. Additive: no row, vector or
 *    index of version 5 is rewritten.
 * 7: RaBitQ vector index (CON-25). The guard triggers call `oort_writer_v7()` instead, so a
 *    writer that predates it (which would not keep the index in step) fails loudly. The index
 *    itself, `memories_rq` and its three companion tables (`rabitq-store.ts`), is built from the
 *    int8 vectors when the store asks for it (`vectorIndex: 'rabitq'`) and dropped again by
 *    `int8` or `binary`. Additive: no row, vector or index of version 6 is rewritten.
 */
export const SCHEMA_VERSION = 7;

/**
 * The binary index (schema version 6): one row per searchable (hot or warm) vector, with its
 * 1-bit code (`binaryCode`), its int8 vector for rescoring as an auxiliary column, and the int8
 * index's partition and filter columns. A dense query scans only the codes; it reads `rescore`
 * for its oversampled candidates alone, one row lookup each (design §3).
 */
export const BIT_TABLE = 'memories_vec_bit';

/**
 * The SQL function every write to `memories` calls through the guard triggers. A connection
 * defines it with `defineWriterGuard`; one that does not (an Oort that predates version 7) gets
 * `no such function: oort_writer_v7` and writes nothing.
 */
export const WRITER_GUARD = 'oort_writer_v7';

/** The version 6 guard's function, which a downgrade to version 6 puts back. */
const WRITER_GUARD_V6 = 'oort_writer_v6';

const GUARD_TRIGGERS = ['insert', 'update', 'delete'] as const;

/** Defines `WRITER_GUARD` on a connection, so its writes pass the guard triggers. */
export function defineWriterGuard(db: Database): void {
  db.function(WRITER_GUARD, { deterministic: true }, () => 1);
}

/** Creates the guard triggers on `memories` (idempotent), calling `fn`. */
function createWriterGuard(db: Database, fn = WRITER_GUARD): void {
  for (const op of GUARD_TRIGGERS) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS memories_writer_guard_${op}
      BEFORE ${op.toUpperCase()} ON memories BEGIN SELECT ${fn}(); END`);
  }
}

function dropWriterGuard(db: Database): void {
  for (const op of GUARD_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS memories_writer_guard_${op}`);
}

function bitTable(dimension: number): string {
  return `CREATE VIRTUAL TABLE ${BIT_TABLE} USING vec0(
        id TEXT PRIMARY KEY,
        embedding bit[${bitWidth(dimension)}],
        node_key TEXT PARTITION KEY,
        project_key TEXT,
        author_key TEXT,
        +rescore BLOB
      )`;
}

/** Whether the store has the binary index. */
export function hasBinaryIndex(db: Database): boolean {
  return exists(db, BIT_TABLE);
}

/** How many vectors a dense query searches: those of hot and warm memories. */
export function searchableVectors(db: Database): number {
  return (
    db
      .prepare<[], { n: number }>(
        `SELECT count(*) AS n FROM memories m
         WHERE m.tier != 'cold' AND EXISTS (SELECT 1 FROM memories_vec_rowids r WHERE r.id = m.id)`,
      )
      .get()?.n ?? 0
  );
}

/**
 * Creates the binary index and fills it from the int8 vectors of every hot and warm memory,
 * inside the caller's transaction. Paged by rid: better-sqlite3 cannot write while a statement
 * iterates. Says how many vectors it indexes first, as the lexical rebuild does.
 */
export function buildBinaryIndex(
  db: Database,
  dimension: number,
  log?: (message: string) => void,
): number {
  const n = searchableVectors(db);
  db.exec(bitTable(dimension));
  if (n > 0) log?.(`Building the binary vector index (${n} ${n === 1 ? 'vector' : 'vectors'})…`);
  const page = db.prepare<
    [number],
    {
      rid: number;
      id: string;
      embedding: Buffer;
      node_key: string;
      project_key: string;
      author_key: string;
    }
  >(
    `SELECT m.rid AS rid, v.id AS id, v.embedding AS embedding, v.node_key AS node_key,
            v.project_key AS project_key, v.author_key AS author_key
     FROM memories m CROSS JOIN memories_vec v ON v.id = m.id
     WHERE m.rid > ? AND m.tier != 'cold' ORDER BY m.rid LIMIT 1000`,
  );
  const insert = db.prepare<[string, Buffer, string, string, string, Buffer]>(
    `INSERT INTO ${BIT_TABLE} (id, embedding, node_key, project_key, author_key, rescore)
     VALUES (?, vec_bit(?), ?, ?, ?, ?)`,
  );
  let done = 0;
  let after = -Infinity;
  for (;;) {
    const rows = page.all(after);
    if (rows.length === 0) break;
    for (const r of rows) {
      const v = new Int8Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength);
      insert.run(r.id, binaryCode(v), r.node_key, r.project_key, r.author_key, r.embedding);
      done++;
      after = r.rid;
    }
  }
  return done;
}

/** Drops the binary index; the int8 index alone answers dense queries again. */
export function dropBinaryIndex(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS ${BIT_TABLE}`);
}

/**
 * Which dense index a store uses: `auto` builds the binary one at `BINARY_AUTO_THRESHOLD`;
 * `rabitq` the RaBitQ one (CON-25).
 */
export type VectorIndex = 'auto' | 'int8' | 'binary' | 'rabitq';

/** The values `vectorIndex` takes. */
export const VECTOR_INDEXES: readonly VectorIndex[] = ['auto', 'int8', 'binary', 'rabitq'];

/**
 * What a migrating open does to the binary index for `want`: build it (`binary`, or `auto` with
 * at least `threshold` searchable vectors and no RaBitQ index), drop it (`int8`, `rabitq`), or
 * nothing. `auto` never drops an index it built: a store that shrinks below the threshold keeps it.
 */
export function binaryIndexPlan(
  db: Database,
  want: VectorIndex,
  threshold = BINARY_AUTO_THRESHOLD,
): 'build' | 'drop' | 'keep' {
  const has = hasBinaryIndex(db);
  if (want === 'int8' || want === 'rabitq') return has ? 'drop' : 'keep';
  if (has) return 'keep';
  if (want === 'binary') return 'build';
  if (hasRabitqIndex(db)) return 'keep';
  // `max(rid)` bounds the count from above in one index lookup; most stores stop there.
  const rows = db.prepare<[], { n: number | null }>('SELECT max(rid) AS n FROM memories').get();
  if ((rows?.n ?? 0) < threshold) return 'keep';
  return searchableVectors(db) >= threshold ? 'build' : 'keep';
}

/**
 * What a migrating open does to the RaBitQ index for `want`: build it (`rabitq`), drop it (`int8`,
 * `binary`), rebuild it with a new centroid once the store has outgrown the old one
 * (`rabitqNeedsRecentre`), or nothing (`auto` keeps one that exists and never builds one).
 */
export function rabitqIndexPlan(
  db: Database,
  want: VectorIndex,
): 'build' | 'rebuild' | 'drop' | 'keep' {
  const has = hasRabitqIndex(db);
  if (want === 'int8' || want === 'binary') return has ? 'drop' : 'keep';
  if (!has) return want === 'rabitq' ? 'build' : 'keep';
  return rabitqNeedsRecentre(db) ? 'rebuild' : 'keep';
}

/**
 * The spatial index (schema version 5): the box each memory with coordinates covers, keyed by the
 * memory's `rid`, with `map_key` (`[mapId, frame]`) as an auxiliary column. A pose without z
 * spans all of z. R*Tree stores 32-bit floats rounded outward, so a box query never misses a
 * match; the store checks the exact distance afterwards.
 */
export const PLACE_TABLE = 'memories_place';

function placeTable(): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${PLACE_TABLE} USING rtree(
        rid, min_x, max_x, min_y, max_y, min_z, max_z, +map_key TEXT
      )`;
}

/**
 * Creates the spatial index and fills it from the stored places: a version 5 store whose index
 * went missing gets back every memory with coordinates, not an empty index that `near` would
 * read as "nothing here". Each place is checked with core's `checkPlace`, as a write is: one that
 * does not parse or does not check (a crafted or damaged copy, say a negative size) is left out,
 * so `near` never finds it, instead of failing the open. Their number is logged.
 */
function rebuildPlaceIndex(db: Database, log: ((message: string) => void) | undefined): void {
  db.exec(placeTable());
  const insert = db.prepare(
    `INSERT INTO ${PLACE_TABLE} (rid, min_x, max_x, min_y, max_y, min_z, max_z, map_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const rows = db
    .prepare<[], { rid: number; place: string }>(
      'SELECT rid, place FROM memories WHERE place IS NOT NULL',
    )
    .all(); // read first: better-sqlite3 cannot write while a statement iterates
  let skipped = 0;
  for (const { rid, place } of rows) {
    let b: ReturnType<typeof placeBox>;
    try {
      b = placeBox(checkPlace(JSON.parse(place)));
    } catch {
      skipped++;
      continue;
    }
    if (b !== undefined) {
      insert.run(rid, b.minX, b.maxX, b.minY, b.maxY, b.minZ, b.maxZ, b.mapKey);
    }
  }
  if (skipped > 0) {
    log?.(
      `sqlite store: ${skipped} stored ${skipped === 1 ? 'place' : 'places'} failed the place check and ${skipped === 1 ? 'is' : 'are'} not searchable by near`,
    );
  }
}

/**
 * FTS5 tokenizer. The store indexes pre-tokenised text (core's `tokenizeLexical` joined by
 * spaces), so `-`, `_` and `.` must stay token characters here and case-folding is the only other
 * normalisation. `M*` keeps combining marks inside tokens, as core's tokeniser v2 does: without it
 * FTS5 would split `हिंदी` or `ใช้` again at their vowel signs. Oort Cloud declares the same string.
 */
export const FTS_TOKENIZE = `unicode61 remove_diacritics 0 categories 'L* N* Co M*' tokenchars '-_.'`;

/** The declaration of schema versions 1 to 3, for tokeniser v1's index. */
export const FTS_TOKENIZE_V1 = `unicode61 remove_diacritics 0 tokenchars '-_.'`;

/**
 * The lexical index's table at schema version 4. It has a new name so that an older Oort still
 * running against the store (an MCP server or daemon started before the upgrade) fails loudly on
 * its next write, `no such table: memories_fts`, instead of indexing tokeniser v1's tokens where
 * no version 2 query would find them.
 */
export const FTS_TABLE = 'memories_fts2';
/** The table of schema versions 1 to 3. */
export const FTS_TABLE_V1 = 'memories_fts';

/** Which address fields each level has; anything else is NULL. Mirrors core's `Address` union. */
const LEVEL_CHECK = `CHECK (
  coalesce(length(org_id), 0) > 0 AND coalesce(length(author_agent_id), 0) > 0 AND (
    (level = 'user' AND coalesce(length(customer_id), 0) > 0
      AND agent_id IS NULL AND hive_id IS NULL AND run_id IS NULL)
    OR (level = 'agent' AND coalesce(length(agent_id), 0) > 0
      AND customer_id IS NULL AND hive_id IS NULL AND run_id IS NULL)
    OR (level = 'agent-user' AND coalesce(length(agent_id), 0) > 0 AND coalesce(length(customer_id), 0) > 0
      AND hive_id IS NULL AND run_id IS NULL)
    OR (level = 'run' AND coalesce(length(agent_id), 0) > 0 AND coalesce(length(run_id), 0) > 0
      AND (customer_id IS NULL OR length(customer_id) > 0) AND hive_id IS NULL)
    OR (level = 'hive' AND coalesce(length(hive_id), 0) > 0
      AND customer_id IS NULL AND agent_id IS NULL AND run_id IS NULL)
  ))`;

/** The memory columns after the address, the same in both versions. */
const BODY_COLUMNS = `type TEXT NOT NULL,
        text TEXT NOT NULL,
        stub TEXT NOT NULL,
        entities TEXT NOT NULL,
        salience REAL NOT NULL,
        pinned INTEGER NOT NULL,
        tier TEXT NOT NULL,
        access_log TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        expired_at TEXT,
        end_reason TEXT,
        last_confirmed_at TEXT,
        supersedes TEXT,
        superseded_by TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL`;

const BODY = [
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
].join(', ');

/**
 * Version 2 `memories`: one column per Memory field except embedding (in memories_vec). Version 3
 * is the same table plus `judgment` (`withJudgment`), version 5 also `place` and `place_node`
 * (`withPlace`); a new store gets both directly.
 */
function memoriesV2(table: string, withJudgment = false, withPlace = false): string {
  return `CREATE TABLE ${table} (
        rid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        level TEXT NOT NULL,
        org_id TEXT NOT NULL,
        customer_id TEXT,
        agent_id TEXT,
        hive_id TEXT,
        run_id TEXT,
        project_id TEXT,
        scope_extra TEXT,
        author_agent_id TEXT NOT NULL,
        author_account_ref TEXT,
        provenance TEXT,
        ${BODY_COLUMNS},${withJudgment ? '\n        judgment TEXT,' : ''}${withPlace ? '\n        place TEXT,\n        place_node TEXT,' : ''}
        ${LEVEL_CHECK}
      )`;
}

function memoriesV1(table: string): string {
  return `CREATE TABLE ${table} (
        rid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        org_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        project_id TEXT,
        scope_extra TEXT,
        ${BODY_COLUMNS}
      )`;
}

const INDEXES_V2 = `
  CREATE INDEX IF NOT EXISTS memories_node
    ON memories (org_id, level, customer_id, agent_id, hive_id, run_id, project_id);
  CREATE INDEX IF NOT EXISTS memories_tier ON memories (tier);
  CREATE INDEX IF NOT EXISTS memories_updated_at ON memories (updated_at);`;

const INDEXES_V1 = `
  CREATE INDEX IF NOT EXISTS memories_scope
    ON memories (org_id, customer_id, agent_id, project_id);
  CREATE INDEX IF NOT EXISTS memories_tier ON memories (tier);
  CREATE INDEX IF NOT EXISTS memories_updated_at ON memories (updated_at);`;

/**
 * Version 2: `node_key` partitions by node (core's `nodeKey`, a JSON tuple
 * compared whole); `project_key`, `author_key` and `tier` are metadata
 * columns, so KNN filters on them before taking k.
 */
function vecV2(dimension: number): string {
  return `CREATE VIRTUAL TABLE memories_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding int8[${dimension}] distance_metric=cosine,
        node_key TEXT PARTITION KEY,
        project_key TEXT,
        author_key TEXT,
        tier TEXT
      )`;
}

/** Version 1: `scope_key` partitions by (org, customer, agent). */
function vecV1(dimension: number): string {
  return `CREATE VIRTUAL TABLE memories_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding int8[${dimension}] distance_metric=cosine,
        scope_key TEXT PARTITION KEY,
        project_key TEXT,
        tier TEXT
      )`;
}

const exists = (db: Database, name: string): boolean =>
  db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined;

/** The vec0 partition of a Planet memory (the only level a version 1 store holds). */
export function planetNodeKey(orgId: string, customerId: string): string {
  const node: NodeRef = { level: 'user', orgId, customerId };
  return nodeKey(node);
}

/** The vec0 partition of a version 1 store: (org, customer, agent). */
function scopeKeyV1(orgId: string, customerId: string, agentId: string): string {
  return JSON.stringify([orgId, customerId, agentId]);
}

/**
 * Every vec row with its memory's address, in the order vec0 scans them
 * (chunk, then offset, from its `_rowids` shadow table when present), so a
 * rebuilt partition keeps the old order and KNN ties break as before.
 */
function vecRows(db: Database, authorColumn: 'agent_id' | 'author_agent_id') {
  const order = exists(db, 'memories_vec_rowids')
    ? `LEFT JOIN memories_vec_rowids r ON r.id = v.id ORDER BY r.chunk_id, r.chunk_offset, m.rid`
    : 'ORDER BY m.rid';
  return db
    .prepare<
      [],
      {
        id: string;
        embedding: Buffer;
        project_key: string;
        tier: string;
        org_id: string;
        customer_id: string;
        author: string;
      }
    >(
      `SELECT v.id AS id, v.embedding AS embedding, v.project_key AS project_key, v.tier AS tier,
              m.org_id AS org_id, m.customer_id AS customer_id, m.${authorColumn} AS author
       FROM memories_vec v JOIN memories m ON m.id = v.id
       ${order}`,
    )
    .all();
}

/**
 * Version 1 to 2, inside the caller's transaction: rebuilds `memories` with
 * the address columns (every row becomes the owner's Planet; `agent_id` moves
 * to `author_agent_id`), keeping every `rid` so the FTS rows still match, and
 * rebuilds `memories_vec` partitioned by node. Cursors, the FTS index and the
 * cold index are untouched.
 */
export function migrateV1toV2(db: Database, dimension: number): void {
  db.exec(memoriesV2('memories_v2'));
  db.exec(`INSERT INTO memories_v2 (rid, id, level, org_id, customer_id, agent_id, hive_id, run_id,
             project_id, scope_extra, author_agent_id, author_account_ref, provenance, ${BODY})
           SELECT rid, id, 'user', org_id, customer_id, NULL, NULL, NULL,
             project_id, scope_extra, agent_id, NULL, NULL, ${BODY}
           FROM memories ORDER BY rid`);
  const vec = vecRows(db, 'agent_id');
  db.exec('DROP TABLE memories');
  db.exec('ALTER TABLE memories_v2 RENAME TO memories');
  db.exec(INDEXES_V2);
  db.exec('DROP TABLE memories_vec');
  db.exec(vecV2(dimension));
  const insert = db.prepare<[string, Buffer, string, string, string, string]>(
    `INSERT INTO memories_vec (id, embedding, node_key, project_key, author_key, tier)
     VALUES (?, vec_int8(?), ?, ?, ?, ?)`,
  );
  for (const r of vec) {
    // A version 1 row's agent_id is its author.
    insert.run(
      r.id,
      r.embedding,
      planetNodeKey(r.org_id, r.customer_id),
      r.project_key,
      r.author,
      r.tier,
    );
  }
}

/**
 * Drops the lexical index and creates it again for tokeniser `version`: `memories_fts` with v1's
 * declaration for 1, `memories_fts2` (`FTS_TABLE`) with `FTS_TOKENIZE` for 2. Indexes every memory
 * again from its stored text, inside the caller's transaction: no vendor call, no vector touched.
 * A row's FTS rowid is its `rid`; a cold row indexes only its stub and entities, as the store
 * writes them. Records the tokeniser and ICU versions in `meta` (version 2), or removes them
 * (version 1, which older Oort versions do not know).
 *
 * BM25's row and token totals start again from the live rows. A long-lived contentless-delete
 * index never subtracts a rewritten row from them, so lexical scores shift once at the rebuild,
 * by the history the old index carried. That is accepted: carrying the history over would grow
 * without bound with every past rewrite.
 */
export function rebuildFts(db: Database, version: 1 | 2, icu = lexicalIcuVersion()): number {
  const tokenize = tokenizerForVersion(version);
  const indexed = (text: string): string => tokenize(text).join(' ');
  const table = version === 1 ? FTS_TABLE_V1 : FTS_TABLE;
  db.exec(`DROP TABLE IF EXISTS ${FTS_TABLE_V1}`);
  db.exec(`DROP TABLE IF EXISTS ${FTS_TABLE}`);
  db.exec(ftsTable(version === 1 ? FTS_TOKENIZE_V1 : FTS_TOKENIZE, table));
  const insert = db.prepare<[number, string, string, string]>(
    `INSERT INTO ${table} (rowid, text, stub, entities) VALUES (?, ?, ?, ?)`,
  );
  // Paged by rid: better-sqlite3 cannot write while a statement is still iterating.
  const page = db.prepare<
    [number],
    { rid: number; tier: string; text: string; stub: string; entities: string }
  >('SELECT rid, tier, text, stub, entities FROM memories WHERE rid > ? ORDER BY rid LIMIT 1000');
  let n = 0;
  let after = -Infinity;
  for (;;) {
    const rows = page.all(after);
    if (rows.length === 0) break;
    for (const r of rows) {
      const entities = JSON.parse(r.entities) as string[];
      insert.run(
        r.rid,
        r.tier === 'cold' ? '' : indexed(r.text),
        indexed(r.stub),
        indexed(entities.join(' ')),
      );
      n++;
      after = r.rid;
    }
  }
  // One segment: the rebuild leaves the index as compact as a fresh one, and merges nothing later.
  db.exec(`INSERT INTO ${table} (${table}) VALUES ('optimize')`);
  if (version === 2) recordLexical(db, icu);
  else db.exec("DELETE FROM meta WHERE key IN ('lexical_version', 'lexical_icu')");
  return n;
}

function recordLexical(db: Database, icu = lexicalIcuVersion()): void {
  const put = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  );
  put.run('lexical_version', String(LEXICAL_VERSION));
  // The major only: Node versions that share it segment alike, and do not rewrite it in turn.
  put.run('lexical_icu', icuMajor(icu)?.toString() ?? '');
}

/**
 * Contentless (content = '', contentless_delete = 1). Nothing syncs it automatically: the store
 * inserts and deletes every row explicitly, in the same transaction as the memories write, and
 * keeps rowid = memories.rid. It indexes core's tokenizeLexical output joined by spaces (so token
 * boundaries match the in-memory store), and an empty text column for cold rows so they match
 * lexically only through stub and entities. An external content table (content = memories)
 * cannot express either.
 */
function ftsTable(tokenize: string, table: string): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(
        text, stub, entities,
        content = '', contentless_delete = 1,
        tokenize = "${tokenize}"
      )`;
}

/** Version 3 to 4, inside the caller's transaction: the lexical index rebuilt with tokeniser v2. */
export function migrateV3toV4(db: Database): void {
  rebuildFts(db, 2);
}

/**
 * A version 4 store whose index is not the version 2 index of its memories: one a pre-release
 * build left under the old name (`memories_fts`), none at all, or an empty `memories_fts2` beside
 * stored memories. Rebuilt on the next migrating open; an open that may not migrate refuses.
 */
export function indexNeedsRepair(db: Database): boolean {
  if (exists(db, FTS_TABLE_V1) || !exists(db, FTS_TABLE)) return true;
  const empty = db.prepare(`SELECT rowid FROM ${FTS_TABLE} LIMIT 1`).get() === undefined;
  return empty && db.prepare('SELECT 1 FROM memories LIMIT 1').get() !== undefined;
}

/** An ICU version's major number, or undefined when it is empty or not a version at all. */
function icuMajor(v: string | undefined): number | undefined {
  const m = /^(\d+)(?:\.\d+)*$/.exec(v ?? '');
  return m === null ? undefined : Number(m[1]);
}

/** Each connection's answer to `holdsSegmentedText`: scanned at most once per open. */
const segmentedSeen = new WeakMap<Database, boolean>();

/**
 * Whether any memory's indexed text is in a dictionary-segmented script. Read only when needed,
 * and at most once per connection: the open's check and its schema transaction share the answer.
 */
function holdsSegmentedText(db: Database): boolean {
  const seen = segmentedSeen.get(db);
  if (seen !== undefined) return seen;
  const found = scanSegmentedText(db);
  segmentedSeen.set(db, found);
  return found;
}

function scanSegmentedText(db: Database): boolean {
  db.function('oort_segmented', { deterministic: true }, (t: unknown) =>
    typeof t === 'string' && hasSegmentedScript(t) ? 1 : 0,
  );
  return (
    db
      .prepare(
        `SELECT 1 FROM memories
         WHERE oort_segmented(text) OR oort_segmented(stub) OR oort_segmented(entities) LIMIT 1`,
      )
      .get() !== undefined
  );
}

/**
 * What a version 4 store's lexical index needs on a migrating open (design §5.2):
 *
 * - `rebuild`: it was built by another tokeniser version, or by an older ICU major while the
 *   store holds Thai, Lao, Khmer or Myanmar text (their word breaks come from ICU's
 *   dictionaries; nothing else changes with ICU). Only a newer major counts, so processes on two
 *   Node versions do not rebuild in turn.
 * - `record-icu`: nothing to rebuild, but the recorded ICU major is older (or unknown). An index
 *   recorded by a newer ICU is left as it is. Only the major is recorded.
 * - `unknown-icu`: this runtime reports no usable ICU version and the store holds segmented
 *   text, so drift cannot be checked. Never a rebuild.
 * - `current`: nothing to do.
 */
export function lexicalIndexState(
  db: Database,
  icu: string = lexicalIcuVersion(),
): 'rebuild' | 'record-icu' | 'unknown-icu' | 'current' {
  const get = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?');
  if (get.get('lexical_version')?.value !== String(LEXICAL_VERSION)) return 'rebuild';
  if (indexNeedsRepair(db)) return 'rebuild';
  const now = icuMajor(icu);
  if (now === undefined) return holdsSegmentedText(db) ? 'unknown-icu' : 'current';
  // Recorded as a major (`78`), or as a full version by an earlier build (`78.3`).
  const was = icuMajor(get.get('lexical_icu')?.value);
  if (was === now) return 'current';
  // Built by a newer ICU (another Node on this machine): leave it, and its record, alone.
  if (was !== undefined && now < was) return 'current';
  if (was !== undefined && now > was && holdsSegmentedText(db)) return 'rebuild';
  return 'record-icu';
}

/**
 * Version 4 to 5, inside the caller's transaction: adds the nullable `place` and `place_node`
 * columns and the empty spatial index. Nothing is rewritten.
 */
export function migrateV4toV5(db: Database): void {
  db.exec('ALTER TABLE memories ADD COLUMN place TEXT');
  db.exec('ALTER TABLE memories ADD COLUMN place_node TEXT');
  db.exec(placeTable());
}

/** How many memories carry a place (schema version 5). */
export function placeCount(db: Database): number {
  if (!hasColumn(db, 'memories', 'place')) return 0;
  return (
    db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM memories WHERE place IS NOT NULL')
      .get()?.n ?? 0
  );
}

/**
 * Version 5 back to 4, inside the caller's transaction: drops the spatial index and the place
 * columns. Refuses (throws) while any memory has a place: version 4 has nowhere to keep it.
 */
export function migrateV5toV4(db: Database): void {
  const n = placeCount(db);
  if (n > 0) {
    throw new Error(
      `sqlite store: ${n} ${n === 1 ? 'memory has a place' : 'memories have a place'}; schema version 4 cannot hold them`,
    );
  }
  db.exec(`DROP TABLE IF EXISTS ${PLACE_TABLE}`);
  db.exec('ALTER TABLE memories DROP COLUMN place_node');
  db.exec('ALTER TABLE memories DROP COLUMN place');
}

/**
 * Version 5 to 6, inside the caller's transaction: the writer guard. Nothing is rewritten; the
 * binary index is built afterwards only when the store asks for it (`binaryIndexPlan`).
 */
export function migrateV5toV6(db: Database): void {
  createWriterGuard(db);
}

/**
 * Version 6 back to 5, inside the caller's transaction: drops the binary index and the writer
 * guard. Version 5 has everything else: the int8 vectors were never moved.
 */
export function migrateV6toV5(db: Database): void {
  dropBinaryIndex(db);
  dropWriterGuard(db);
}

/**
 * Version 6 to 7, inside the caller's transaction: the guard triggers call `oort_writer_v7`.
 * Nothing is rewritten; the RaBitQ index is built afterwards only when the store asks for it
 * (`rabitqIndexPlan`).
 */
export function migrateV6toV7(db: Database): void {
  dropWriterGuard(db);
  createWriterGuard(db);
}

/**
 * Version 7 back to 6, inside the caller's transaction: drops the RaBitQ index and puts the
 * version 6 guard back. The int8 vectors and a binary index are untouched.
 */
export function migrateV7toV6(db: Database): void {
  dropRabitqIndex(db);
  dropWriterGuard(db);
  createWriterGuard(db, WRITER_GUARD_V6);
}

/**
 * Version 2 to 3, inside the caller's transaction: adds the nullable `judgment` column. Every
 * existing row keeps its rid, FTS row and vector; nothing is rewritten.
 */
export function migrateV2toV3(db: Database): void {
  db.exec('ALTER TABLE memories ADD COLUMN judgment TEXT');
}

/**
 * Version 3 back to 2, inside the caller's transaction: drops the `judgment` column. Refuses
 * (throws) while any judgment is stored: version 2 has nowhere to keep it.
 */
export function migrateV3toV2(db: Database): void {
  const n = judgmentCount(db);
  if (n > 0) {
    throw new Error(
      `sqlite store: ${n} ${n === 1 ? 'memory is a judgment' : 'memories are judgments'}; schema version 2 cannot hold them`,
    );
  }
  db.exec('ALTER TABLE memories DROP COLUMN judgment');
}

/** How many judgment memories the store holds (schema version 3). */
export function judgmentCount(db: Database): number {
  return (
    db
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM memories WHERE type = 'judgment' OR judgment IS NOT NULL`,
      )
      .get()?.n ?? 0
  );
}

/**
 * Version 2 back to 1, inside the caller's transaction: the reverse of
 * `migrateV1toV2`. Refuses (throws, so the caller's transaction rolls back) a
 * store holding anything version 1 cannot represent: a memory at another
 * level, an author with an account, or provenance.
 */
/**
 * How many memories version 1 cannot represent (another level, an account, provenance, or a
 * judgment).
 */
export function migrationBlockers(db: Database): number {
  const judgments = hasColumn(db, 'memories', 'judgment') ? ' OR judgment IS NOT NULL' : '';
  return (
    db
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM memories
         WHERE level != 'user' OR author_account_ref IS NOT NULL OR provenance IS NOT NULL
           OR type = 'judgment'${judgments}`,
      )
      .get()?.n ?? 0
  );
}

const hasColumn = (db: Database, table: string, column: string): boolean =>
  db
    .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .some((c) => c.name === column);

export function migrateV2toV1(db: Database, dimension: number): void {
  const blocked = migrationBlockers(db);
  if (blocked > 0) {
    throw new Error(
      `sqlite store: ${blocked} memories are not plain Planet memories; schema version 1 cannot hold them`,
    );
  }
  // The version 1 table is built from named columns: a version 3 store's `judgment` (all NULL,
  // checked above) is simply left behind.
  db.exec(memoriesV1('memories_v1'));
  db.exec(`INSERT INTO memories_v1 (rid, id, org_id, customer_id, agent_id, project_id, scope_extra,
             ${BODY})
           SELECT rid, id, org_id, customer_id, author_agent_id, project_id, scope_extra, ${BODY}
           FROM memories ORDER BY rid`);
  const vec = vecRows(db, 'author_agent_id');
  db.exec('DROP TABLE memories');
  db.exec('ALTER TABLE memories_v1 RENAME TO memories');
  db.exec(INDEXES_V1);
  db.exec('DROP TABLE memories_vec');
  db.exec(vecV1(dimension));
  const insert = db.prepare<[string, Buffer, string, string, string]>(
    `INSERT INTO memories_vec (id, embedding, scope_key, project_key, tier)
     VALUES (?, vec_int8(?), ?, ?, ?)`,
  );
  for (const r of vec) {
    insert.run(
      r.id,
      r.embedding,
      scopeKeyV1(r.org_id, r.customer_id, r.author),
      r.project_key,
      r.tier,
    );
  }
}

/**
 * Raised by an open that may not migrate (`migrate: false`) when the store is
 * at an older schema version. Nothing was changed; any open that may migrate
 * (any `oort` command but the hooks) brings it up to date.
 */
export class StoreMigrationRequiredError extends Error {
  constructor(
    readonly path: string,
    readonly from: number,
  ) {
    super(
      from === SCHEMA_VERSION
        ? `sqlite store: ${path} needs its search index rebuilt; open it once without migrate: false (oort doctor does)`
        : `sqlite store: ${path} is at schema version ${from} and must be migrated to ${SCHEMA_VERSION}; open it once without migrate: false (oort doctor does)`,
    );
    this.name = 'StoreMigrationRequiredError';
  }
}

/** The schema version recorded in `db`, or undefined for a new (empty) database. */
export function schemaVersionOf(db: Database): number | undefined {
  if (!exists(db, 'meta')) return undefined;
  const v = db
    .prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
    .get()?.value;
  return v === undefined ? undefined : Number(v);
}

/**
 * Throws, naming how many, when a version 1 store holds memories with an
 * empty org, customer or agent id. Grants never allowed one, but the 0.1.0
 * store did not check, and there is no owner or author such a row could be
 * given without guessing, so the migration refuses rather than move it.
 */
export function assertMigratable(db: Database): void {
  const bad = db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM memories
       WHERE coalesce(org_id, '') = '' OR coalesce(customer_id, '') = '' OR coalesce(agent_id, '') = ''`,
    )
    .get();
  const n = bad?.n ?? 0;
  if (n > 0) {
    throw new Error(
      `sqlite store: ${n} ${n === 1 ? 'memory has' : 'memories have'} an empty org, customer or agent id, which schema version ${SCHEMA_VERSION} cannot hold; nothing was changed. Export them with Oort 0.2.x (oort export), delete them (DELETE FROM memories WHERE org_id = '' OR customer_id = '' OR agent_id = ''), then open the store again`,
    );
  }
}

export interface ApplySchemaOptions {
  /**
   * false: refuse (`StoreMigrationRequiredError`) instead of migrating an
   * older store. Default true. The caller backs the store up before an open
   * that migrates; `applySchema` never copies anything.
   */
  migrate?: boolean;
  /** One-line notices (the rebuild, an unknown ICU). Default: none. */
  log?: (message: string) => void;
  /** The runtime's ICU version, for the drift guard (default `lexicalIcuVersion()`). */
  icu?: string;
  /** Which dense index the store should have (default `auto`); see `binaryIndexPlan`. */
  vectorIndex?: VectorIndex;
  /** `vectorIndex: 'auto'` builds the binary index at this many vectors (default 100,000). */
  binaryAutoThreshold?: number;
}

/**
 * Creates every table and index of a new store at the current version, and
 * migrates a version 1, 2 or 3 store to it (unless `migrate` is false). A version 4 store whose
 * lexical index is stale (`lexicalIndexState`) has it rebuilt, unless `migrate` is false.
 * Records `dimension` on first open and refuses a store whose recorded
 * dimension differs, or whose schema version is unknown. Runs in one
 * IMMEDIATE transaction so concurrent first opens (hook processes) serialise:
 * exactly one of them migrates, the others find the current version.
 */
export function applySchema(db: Database, dimension: number, opts: ApplySchemaOptions = {}): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cold_index (id TEXT PRIMARY KEY, path TEXT NOT NULL);
    `);
    const get = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?');
    const put = db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    );

    const stored = get.get('dimension')?.value;
    if (stored !== undefined && stored !== String(dimension)) {
      throw new Error(
        `sqlite store: the store was created with dimension ${stored}, opened with dimension ${dimension}`,
      );
    }

    const version = get.get('schema_version')?.value;
    // Said only by the process that rebuilds, inside its transaction: another open that waited
    // for the lock finds the work done and says nothing.
    const rebuilding = (): void => {
      const n = db.prepare<[], { n: number }>('SELECT count(*) AS n FROM memories').get()?.n ?? 0;
      opts.log?.(`Rebuilding the search index (${n} ${n === 1 ? 'memory' : 'memories'})…`);
    };
    const fresh = version === undefined && !exists(db, 'memories');
    if (fresh) {
      db.exec(memoriesV2('memories', true, true));
      db.exec(INDEXES_V2);
    } else if (version === '1') {
      if (opts.migrate === false) throw new StoreMigrationRequiredError(db.name, 1);
      assertMigratable(db);
      rebuilding();
      migrateV1toV2(db, dimension);
      migrateV2toV3(db);
      migrateV3toV4(db);
      migrateV4toV5(db);
      migrateV5toV6(db);
      migrateV6toV7(db);
    } else if (version === '2') {
      if (opts.migrate === false) throw new StoreMigrationRequiredError(db.name, 2);
      rebuilding();
      migrateV2toV3(db);
      migrateV3toV4(db);
      migrateV4toV5(db);
      migrateV5toV6(db);
      migrateV6toV7(db);
    } else if (version === '3') {
      if (opts.migrate === false) throw new StoreMigrationRequiredError(db.name, 3);
      rebuilding();
      migrateV3toV4(db);
      migrateV4toV5(db);
      migrateV5toV6(db);
      migrateV6toV7(db);
    } else if (
      version === '4' ||
      version === '5' ||
      version === '6' ||
      version === String(SCHEMA_VERSION)
    ) {
      // Version 4 to 5 adds columns and an empty index, 5 to 6 and 6 to 7 the writer guard: no
      // rebuild, and no notice.
      if (version === '4' || version === '5' || version === '6') {
        if (opts.migrate === false) throw new StoreMigrationRequiredError(db.name, Number(version));
        if (version === '4') migrateV4toV5(db);
        if (version !== '6') migrateV5toV6(db);
        migrateV6toV7(db);
      }
      // An index to repair is a migration: an open that may not migrate (a hook) refuses, changing
      // nothing, rather than create an empty index that would then look current.
      if (opts.migrate === false && indexNeedsRepair(db)) {
        throw new StoreMigrationRequiredError(db.name, SCHEMA_VERSION);
      }
      // The drift guard needs a write; an open that may not migrate (a hook) leaves it to the next.
      if (opts.migrate !== false) {
        const icu = opts.icu ?? lexicalIcuVersion();
        const state = lexicalIndexState(db, icu);
        if (state === 'rebuild') {
          rebuilding();
          rebuildFts(db, 2, icu);
        } else if (state === 'record-icu') recordLexical(db, icu);
        else if (state === 'unknown-icu') {
          opts.log?.(
            `sqlite store: this runtime reports no usable ICU version (${JSON.stringify(icu)}); Thai, Lao, Khmer and Myanmar words are matched as the index was built`,
          );
        }
      }
    } else {
      throw new Error(
        `sqlite store: schema version ${version ?? 'unknown'} is not supported (expected ${SCHEMA_VERSION})`,
      );
    }
    put.run('schema_version', String(SCHEMA_VERSION));
    if (stored === undefined) put.run('dimension', String(dimension));

    // A new store gets the version 2 index here (see `ftsTable`); a migrated one has it already,
    // and one whose index needs repair was rebuilt above or refused.
    if (fresh) {
      db.exec(ftsTable(FTS_TOKENIZE, FTS_TABLE));
      recordLexical(db, opts.icu ?? lexicalIcuVersion());
    }
    if (!exists(db, 'memories_vec')) db.exec(vecV2(dimension));
    if (!exists(db, PLACE_TABLE)) rebuildPlaceIndex(db, opts.log);
    createWriterGuard(db);
    // The vector indexes are writes: an open that may not migrate (a hook) uses what is there.
    // At most one of them is kept: the one `vectorIndex` asks for (`auto` keeps either).
    if (opts.migrate !== false) {
      const want = opts.vectorIndex ?? 'auto';
      const rq = rabitqIndexPlan(db, want);
      if (rq === 'drop' || rq === 'rebuild') dropRabitqIndex(db);
      const plan = binaryIndexPlan(db, want, opts.binaryAutoThreshold);
      if (plan === 'build') buildBinaryIndex(db, dimension, opts.log);
      else if (plan === 'drop') dropBinaryIndex(db);
      if (rq === 'build' || rq === 'rebuild') buildRabitqIndex(db, dimension, opts.log);
    }
  }).immediate();
}

/**
 * Takes a store's database back to schema version `to`: 1 for running Oort 0.2.x against it
 * again (the default), 2 for Oort 0.3 to 0.5, 3 for Oort before tokeniser v2, 4 for Oort before
 * spatial memory (0.8), 5 for Oort before the binary vector index, 6 for Oort before the RaBitQ
 * index (the RaBitQ index is dropped, a binary index kept). Refuses, changing nothing,
 * when the store holds anything that version cannot represent (see `migrateV2toV1`,
 * `migrateV3toV2` and `migrateV5toV4`). Leaving version 6 drops the binary index and the writer
 * guard; leaving version 4 rebuilds the lexical index with tokeniser v1. No other connection may
 * have the store open. Opening a store never does this: migrations only roll forward.
 */
export function downgradeSchema(db: Database, to: 1 | 2 | 3 | 4 | 5 | 6 = 1): void {
  db.transaction(() => {
    const get = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?');
    let version = Number(get.get('schema_version')?.value);
    if (version <= to && version >= 1) return;
    if (![2, 3, 4, 5, 6, 7].includes(version)) {
      throw new Error(
        `sqlite store: cannot downgrade schema version ${Number.isNaN(version) ? 'unknown' : version}`,
      );
    }
    if (version === 7) {
      migrateV7toV6(db);
      version = 6;
    }
    if (version === 6 && to < 6) {
      migrateV6toV5(db);
      version = 5;
    }
    if (version === 5 && to < 5) {
      migrateV5toV4(db);
      version = 4;
    }
    if (version === 4 && to < 4) {
      rebuildFts(db, 1);
      version = 3;
    }
    // Version 1 is built from named columns (and refuses judgments), so going to 1 needs no
    // separate drop of `judgment` on the way.
    if (version === 3 && to === 2) migrateV3toV2(db);
    if (to === 1) {
      const dimension = Number(get.get('dimension')?.value);
      migrateV2toV1(db, dimension);
    }
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(to), 'schema_version');
  }).immediate();
}
