import type { Database } from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

/**
 * FTS5 tokenizer. The store indexes pre-tokenised text (core's
 * `tokenizeLexical` joined by spaces), so `-`, `_` and `.` must stay token
 * characters here and case-folding is the only other normalisation.
 */
const TOKENIZE = `unicode61 remove_diacritics 0 tokenchars '-_.'`;

/**
 * Creates every table and index if missing, records `dimension` and the schema
 * version on first open, and refuses a store whose recorded dimension or schema
 * version differs. Runs in one IMMEDIATE transaction so concurrent first opens
 * (hook processes) serialise.
 */
export function applySchema(db: Database, dimension: number): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cold_index (id TEXT PRIMARY KEY, path TEXT NOT NULL);

      -- One column per Memory field except embedding (in memories_vec). rid is the
      -- stable integer key that memories_fts rows share.
      CREATE TABLE IF NOT EXISTS memories (
        rid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        org_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        project_id TEXT,
        scope_extra TEXT,
        type TEXT NOT NULL,
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
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_scope
        ON memories (org_id, customer_id, agent_id, project_id);
      CREATE INDEX IF NOT EXISTS memories_tier ON memories (tier);
      CREATE INDEX IF NOT EXISTS memories_updated_at ON memories (updated_at);

      -- Contentless (content = '', contentless_delete = 1). Nothing syncs it
      -- automatically: the store inserts and deletes every row explicitly, in the
      -- same transaction as the memories write, and keeps rowid = memories.rid.
      -- It indexes core's tokenizeLexical output joined by spaces (so token
      -- boundaries match the in-memory store), and an empty text column for cold
      -- rows so they match lexically only through stub and entities. An external
      -- content table (content = memories) cannot express either.
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        text, stub, entities,
        content = '', contentless_delete = 1,
        tokenize = "${TOKENIZE}"
      );

      -- scope_key partitions by (org, customer, agent); project_key and tier are
      -- metadata columns so KNN filters on them before taking k.
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding int8[${dimension}] distance_metric=cosine,
        scope_key TEXT PARTITION KEY,
        project_key TEXT,
        tier TEXT
      );
    `);

    const get = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?');
    const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');

    const version = get.get('schema_version')?.value;
    if (version === undefined) put.run('schema_version', String(SCHEMA_VERSION));
    else if (version !== String(SCHEMA_VERSION)) {
      throw new Error(
        `sqlite store: schema version ${version} is not supported (expected ${SCHEMA_VERSION})`,
      );
    }

    const stored = get.get('dimension')?.value;
    if (stored === undefined) put.run('dimension', String(dimension));
    else if (stored !== String(dimension)) {
      throw new Error(
        `sqlite store: the store was created with dimension ${stored}, opened with dimension ${dimension}`,
      );
    }
  }).immediate();
}
