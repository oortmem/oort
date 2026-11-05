import type { Database } from 'better-sqlite3';
import { nodeKey, type NodeRef } from '@oortmem/core';

/**
 * 1: the Phase 1 store, one (org, customer, agent) scope per memory.
 * 2: levels (CON-61). Every memory has an address (`level` plus the fields
 *    that level has) and an author; Phase 1 memories become the owner's
 *    Planet, written by the agent that was their `agent_id`.
 */
export const SCHEMA_VERSION = 2;

/**
 * FTS5 tokenizer. The store indexes pre-tokenised text (core's
 * `tokenizeLexical` joined by spaces), so `-`, `_` and `.` must stay token
 * characters here and case-folding is the only other normalisation.
 */
const TOKENIZE = `unicode61 remove_diacritics 0 tokenchars '-_.'`;

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

/** Version 2 `memories`: one column per Memory field except embedding (in memories_vec). */
function memoriesV2(table: string): string {
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
        ${BODY_COLUMNS},
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
 * Version 2 back to 1, inside the caller's transaction: the reverse of
 * `migrateV1toV2`. Refuses (throws, so the caller's transaction rolls back) a
 * store holding anything version 1 cannot represent: a memory at another
 * level, an author with an account, or provenance.
 */
/** How many memories version 1 cannot represent (another level, an account, provenance). */
export function migrationBlockers(db: Database): number {
  return (
    db
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) AS n FROM memories
         WHERE level != 'user' OR author_account_ref IS NOT NULL OR provenance IS NOT NULL`,
      )
      .get()?.n ?? 0
  );
}

export function migrateV2toV1(db: Database, dimension: number): void {
  const blocked = migrationBlockers(db);
  if (blocked > 0) {
    throw new Error(
      `sqlite store: ${blocked} memories are not plain Planet memories; schema version 1 cannot hold them`,
    );
  }
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
      `sqlite store: ${path} is at schema version ${from} and must be migrated to ${SCHEMA_VERSION}; open it once without migrate: false (oort doctor does)`,
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
}

/**
 * Creates every table and index of a new store at the current version, and
 * migrates a version 1 store to it (unless `migrate` is false).
 * Records `dimension` on first open and refuses a store whose recorded
 * dimension differs, or whose schema version is unknown. Runs in one
 * IMMEDIATE transaction so concurrent first opens (hook processes) serialise:
 * exactly one of them migrates, the others find version 2.
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
    if (version === undefined && !exists(db, 'memories')) {
      db.exec(memoriesV2('memories'));
      db.exec(INDEXES_V2);
    } else if (version === '1') {
      if (opts.migrate === false) throw new StoreMigrationRequiredError(db.name, 1);
      assertMigratable(db);
      migrateV1toV2(db, dimension);
    } else if (version !== String(SCHEMA_VERSION)) {
      throw new Error(
        `sqlite store: schema version ${version ?? 'unknown'} is not supported (expected ${SCHEMA_VERSION})`,
      );
    }
    put.run('schema_version', String(SCHEMA_VERSION));
    if (stored === undefined) put.run('dimension', String(dimension));

    // Contentless (content = '', contentless_delete = 1). Nothing syncs it
    // automatically: the store inserts and deletes every row explicitly, in the
    // same transaction as the memories write, and keeps rowid = memories.rid.
    // It indexes core's tokenizeLexical output joined by spaces (so token
    // boundaries match the in-memory store), and an empty text column for cold
    // rows so they match lexically only through stub and entities. An external
    // content table (content = memories) cannot express either.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        text, stub, entities,
        content = '', contentless_delete = 1,
        tokenize = "${TOKENIZE}"
      );
    `);
    if (!exists(db, 'memories_vec')) db.exec(vecV2(dimension));
  }).immediate();
}

/**
 * Takes a store's database back to schema version 1, for running an older
 * Oort (0.2.x) against it again. Refuses, changing nothing, when the store
 * holds anything version 1 cannot represent (see `migrateV2toV1`). No other
 * connection may have the store open.
 */
export function downgradeSchema(db: Database): void {
  db.transaction(() => {
    const get = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?');
    const version = get.get('schema_version')?.value;
    if (version === '1') return;
    if (version !== String(SCHEMA_VERSION)) {
      throw new Error(`sqlite store: cannot downgrade schema version ${version ?? 'unknown'}`);
    }
    const dimension = Number(get.get('dimension')?.value);
    migrateV2toV1(db, dimension);
    db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  }).immediate();
}
