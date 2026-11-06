import type { Database } from 'better-sqlite3';
import {
  hasSegmentedScript,
  lexicalIcuVersion,
  LEXICAL_VERSION,
  nodeKey,
  tokenizerForVersion,
  type NodeRef,
} from '@oortmem/core';

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
 */
export const SCHEMA_VERSION = 4;

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
 * is the same table plus `judgment` (`withJudgment`), which a new store gets directly.
 */
function memoriesV2(table: string, withJudgment = false): string {
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
        ${BODY_COLUMNS},${withJudgment ? '\n        judgment TEXT,' : ''}
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
  put.run('lexical_icu', icu);
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

/** Whether any memory's indexed text is in a dictionary-segmented script. Read only when needed. */
function holdsSegmentedText(db: Database): boolean {
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
 * - `record-icu`: nothing to rebuild, but the recorded ICU version is older (or unknown). An
 *   index recorded by a newer ICU is left as it is.
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
  const recorded = get.get('lexical_icu')?.value;
  const now = icuMajor(icu);
  if (now === undefined) return holdsSegmentedText(db) ? 'unknown-icu' : 'current';
  if (recorded === icu) return 'current';
  const was = icuMajor(recorded);
  // Built by a newer ICU (another Node on this machine): leave it, and its record, alone.
  if (was !== undefined && now < was) return 'current';
  if (was !== undefined && now > was && holdsSegmentedText(db)) return 'rebuild';
  return 'record-icu';
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
      db.exec(memoriesV2('memories', true));
      db.exec(INDEXES_V2);
    } else if (version === '1') {
      if (opts.migrate === false) throw new StoreMigrationRequiredError(db.name, 1);
      assertMigratable(db);
      rebuilding();
      migrateV1toV2(db, dimension);
      migrateV2toV3(db);
      migrateV3toV4(db);
    } else if (version === '2') {
      if (opts.migrate === false) throw new StoreMigrationRequiredError(db.name, 2);
      rebuilding();
      migrateV2toV3(db);
      migrateV3toV4(db);
    } else if (version === '3') {
      if (opts.migrate === false) throw new StoreMigrationRequiredError(db.name, 3);
      rebuilding();
      migrateV3toV4(db);
    } else if (version === String(SCHEMA_VERSION)) {
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
  }).immediate();
}

/**
 * Takes a store's database back to schema version `to`: 1 for running Oort 0.2.x against it
 * again (the default), 2 for Oort 0.3 to 0.5, 3 for Oort before tokeniser v2. Refuses, changing
 * nothing, when the store holds anything that version cannot represent (see `migrateV2toV1` and
 * `migrateV3toV2`). Leaving version 4 rebuilds the lexical index with tokeniser v1. No other
 * connection may have the store open. Opening a store never does this: migrations only roll
 * forward.
 */
export function downgradeSchema(db: Database, to: 1 | 2 | 3 = 1): void {
  db.transaction(() => {
    const get = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?');
    let version = Number(get.get('schema_version')?.value);
    if (version <= to && version >= 1) return;
    if (version !== 2 && version !== 3 && version !== 4) {
      throw new Error(
        `sqlite store: cannot downgrade schema version ${Number.isNaN(version) ? 'unknown' : version}`,
      );
    }
    if (version === 4) {
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
