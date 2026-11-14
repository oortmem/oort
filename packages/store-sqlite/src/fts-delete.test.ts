/**
 * Schema version 9 (CON-159): the lexical index is a plain contentless FTS5 table with
 * `secure-delete` on, and `memories_indexed` (`FTS_VALUES_TABLE`) keeps the exact strings each
 * memory was indexed with. Every delete and rewrite hands FTS5 those strings through its
 * `'delete'` command, so a forgotten memory's terms leave the index at once, with no merge.
 *
 * FTS5's `integrity-check` cannot see a delete given the wrong strings on a contentless table, so
 * the write-path test compares the whole index (every term instance, the BM25 totals and the
 * per-row sizes) with a fresh rebuild instead.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { forgetMemory, tokenizeLexical, type Memory, type MemoryStore } from '@oortmem/core';
import { makeMemory, TG } from '@oortmem/core/store-conformance';
import {
  downgradeSqliteStore,
  FTS_TABLE,
  FTS_TOKENIZE,
  FTS_VALUES_TABLE,
  openSqliteStore,
  SCHEMA_VERSION,
  sqliteSchemaVersion,
  StoreMigrationRequiredError,
  WRITER_GUARD,
} from './index.js';
import { rebuildFts } from './schema.js';

const DIM = 8;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-fts-delete-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A marker with a prefix no other term shares, so FTS5 stores it whole. */
const MARKER = 'zqvmarker9forgotten';

const vecOf = (i: number): Int8Array =>
  Int8Array.from({ length: DIM }, (_, j) => ((i * 13 + j * 5) % 200) - 100 || 1);

interface Paths {
  dir: string;
  dbPath: string;
  coldDir: string;
}

function fresh(): Paths {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  return { dir, dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
}

const open = (
  s: Paths,
  extra: { migrate?: boolean; log?: (m: string) => void; icu?: string } = {},
) =>
  openSqliteStore({
    path: s.dbPath,
    coldDir: s.coldDir,
    dimension: DIM,
    vectorIndex: 'int8',
    log: () => {},
    ...extra,
  });

function raw(dbPath: string, readonly = false): Database.Database {
  const db = new Database(dbPath, { readonly });
  sqliteVec.load(db);
  return db;
}

function read<T>(dbPath: string, sql: string, ...params: unknown[]): T[] {
  const db = raw(dbPath, true);
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/** Every file the store keeps beside its database, as one buffer. */
function bytesOf(dbPath: string): Buffer {
  return Buffer.concat(
    ['', '-wal']
      .map((x) => `${dbPath}${x}`)
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f)),
  );
}

function checkpoint(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

/** How many segments the index has: `optimize` leaves exactly one. */
const segments = (dbPath: string): number =>
  read<{ n: number }>(dbPath, `SELECT count(DISTINCT segid) AS n FROM ${FTS_TABLE}_idx`)[0]!.n;

/** Whether `s` appears in any of the lexical index's shadow tables (`*_data`, `*_idx`, ...). */
function inShadowTables(dbPath: string, s: string): boolean {
  const db = raw(dbPath, true);
  try {
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .filter((n) => n.startsWith(`${FTS_TABLE}_`));
    expect(tables).toContain(`${FTS_TABLE}_data`);
    const needle = Buffer.from(s);
    for (const t of tables) {
      for (const row of db.prepare(`SELECT * FROM ${t}`).raw().all() as unknown[][]) {
        for (const cell of row) {
          if (Buffer.isBuffer(cell) && cell.includes(needle)) return true;
          if (typeof cell === 'string' && cell.includes(s)) return true;
        }
      }
    }
    return false;
  } finally {
    db.close();
  }
}

/** Everything the lexical index holds, as comparable rows. */
function indexContents(db: Database.Database) {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS temp.vocab USING fts5vocab(main, ${FTS_TABLE}, instance)`,
  );
  return {
    instances: db
      .prepare('SELECT term, doc, col, "offset" FROM temp.vocab ORDER BY term, doc, col, "offset"')
      .all(),
    // The BM25 totals: rows and tokens per column (the averages record, id 1).
    averages: db.prepare(`SELECT hex(block) AS b FROM ${FTS_TABLE}_data WHERE id = 1`).get(),
    sizes: db.prepare(`SELECT id, hex(sz) AS sz FROM ${FTS_TABLE}_docsize ORDER BY id`).all(),
    values: db
      .prepare(`SELECT rid, text, stub, entities FROM ${FTS_VALUES_TABLE} ORDER BY rid`)
      .all(),
  };
}

/** The index of the store at `dbPath` as it is, and as a fresh rebuild of a copy makes it. */
function liveAndRebuilt(s: Paths) {
  checkpoint(s.dbPath);
  const copy = path.join(s.dir, `rebuilt-${Date.now()}.sqlite`);
  fs.copyFileSync(s.dbPath, copy);
  const live = raw(s.dbPath);
  const rebuilt = raw(copy);
  try {
    live.exec(`INSERT INTO ${FTS_TABLE} (${FTS_TABLE}) VALUES ('integrity-check')`);
    rebuilt.transaction(() => rebuildFts(rebuilt, 2))();
    return { live: indexContents(live), rebuilt: indexContents(rebuilt), copy };
  } finally {
    live.close();
    rebuilt.close();
  }
}

const indexed = (t: string) => tokenizeLexical(t).join(' ');

describe('schema version 9: a lexical index that deletes a row by its own terms (CON-159)', () => {
  it('fts-delete.new-store-is-v9-with-a-plain-contentless-secure-delete-index', async () => {
    const s = fresh();
    await (await open(s)).close();
    expect(SCHEMA_VERSION).toBe(9);
    expect(WRITER_GUARD).toBe('oort_writer_v9');
    expect(sqliteSchemaVersion(s.dbPath)).toBe(9);
    const [fts] = read<{ sql: string }>(
      s.dbPath,
      'SELECT sql FROM sqlite_master WHERE name = ?',
      FTS_TABLE,
    );
    expect(fts?.sql).toMatch(/content\s*=\s*''/);
    expect(fts?.sql).not.toContain('contentless_delete');
    expect(
      read<{ v: number }>(s.dbPath, `SELECT v FROM ${FTS_TABLE}_config WHERE k = 'secure-delete'`),
    ).toEqual([{ v: 1 }]);
    expect(read(s.dbPath, `SELECT * FROM ${FTS_VALUES_TABLE}`)).toEqual([]);
  });

  it('fts-delete.the-store-keeps-the-exact-indexed-strings-of-every-memory', async () => {
    const s = fresh();
    const store = await open(s);
    await store.upsertMany(TG, [
      makeMemory({ id: 'a', text: 'The Auth-Service runs on port 8080.', entities: ['Auth'] }),
      makeMemory({ id: 'b', text: '认证服务 บริการยืนยันตัวตน', stub: 'Ｓｔｕｂ', tier: 'cold' }),
    ]);
    await store.close();
    const rows = read<{ id: string; text: string; stub: string; entities: string }>(
      s.dbPath,
      `SELECT m.id AS id, v.text AS text, v.stub AS stub, v.entities AS entities
       FROM ${FTS_VALUES_TABLE} v JOIN memories m ON m.rid = v.rid ORDER BY m.id`,
    );
    expect(rows).toEqual([
      {
        id: 'a',
        text: indexed('The Auth-Service runs on port 8080.'),
        stub: indexed('stub a'),
        entities: 'auth',
      },
      // A cold memory indexes its stub and entities only.
      { id: 'b', text: '', stub: indexed('Ｓｔｕｂ'), entities: '' },
    ]);
  });

  it('fts-delete.forget-removes-the-terms-without-merging-the-index', async () => {
    const s = fresh();
    const store = await open(s);
    // Three transactions, three segments: a merge (`optimize`) would leave one.
    await store.upsertMany(
      TG,
      Array.from({ length: 20 }, (_, i) =>
        makeMemory({ id: `n${i}`, text: `neighbour ${i} about ports`, embedding: vecOf(i) }),
      ),
    );
    await store.upsert(
      TG,
      makeMemory({
        id: 'secret',
        text: `the dev port is ${MARKER}`,
        stub: `${MARKER} stub`,
        entities: [MARKER],
        embedding: vecOf(99),
      }),
    );
    await store.upsert(TG, makeMemory({ id: 'later', text: 'a later memory' }));
    checkpoint(s.dbPath);
    const before = segments(s.dbPath);
    expect(before).toBeGreaterThan(1);
    expect(inShadowTables(s.dbPath, MARKER)).toBe(true);
    expect(bytesOf(s.dbPath).includes(MARKER)).toBe(true);

    await store.forget(TG, 'secret');
    checkpoint(s.dbPath);
    // Gone from every shadow table, the side table and the file, with the segments unmerged.
    expect(segments(s.dbPath)).toBe(before);
    expect(inShadowTables(s.dbPath, MARKER)).toBe(false);
    expect(bytesOf(s.dbPath).includes(MARKER)).toBe(false);
    expect(await store.lexical(TG, MARKER, 10)).toEqual([]);
    expect((await store.lexical(TG, 'neighbour', 50)).length).toBe(20);
    await store.close();
    const { live, rebuilt } = liveAndRebuilt(s);
    expect(live).toEqual(rebuilt);
  });

  it('fts-delete.a-rewrite-removes-the-old-terms-without-merging-the-index', async () => {
    const s = fresh();
    const store = await open(s);
    await store.upsertMany(TG, [makeMemory({ id: 'n', text: 'a neighbour' })]);
    await store.upsert(TG, makeMemory({ id: 'a', text: `the port is ${MARKER}` }));
    await store.upsert(TG, makeMemory({ id: 'z', text: 'another' }));
    checkpoint(s.dbPath);
    const before = segments(s.dbPath);
    await store.upsert(TG, makeMemory({ id: 'a', text: 'the port is 8080' }));
    checkpoint(s.dbPath);
    expect(inShadowTables(s.dbPath, MARKER)).toBe(false);
    expect(bytesOf(s.dbPath).includes(MARKER)).toBe(false);
    // The rewrite's own segment is the only new one.
    expect(segments(s.dbPath)).toBeLessThanOrEqual(before + 1);
    expect((await store.lexical(TG, '8080', 5)).map((h) => h.id)).toEqual(['a']);
    await store.close();
  });

  it('fts-delete.every-write-path-leaves-the-index-a-fresh-rebuild-would-build', async () => {
    const s = fresh();
    const store = await open(s);
    const t = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();
    const base: Memory[] = [
      makeMemory({ id: 'm1', text: 'Auth service runs on port 8080', entities: ['Auth'] }),
      makeMemory({ id: 'm2', text: '認証サービスはポート8080で動く', entities: ['認証'] }),
      makeMemory({ id: 'm3', text: 'บริการยืนยันตัวตนทำงานที่พอร์ต 8080', stub: 'บริการ' }),
      makeMemory({
        id: 'm4',
        text: 'Ｆｕｌｌ-width ＡＰＩ and autenticación ½',
        entities: ['ＡＰＩ'],
      }),
      makeMemory({ id: 'm5', text: 'प्रमाणीकरण सेवा deploy staging', tier: 'hot' }),
      makeMemory({ id: 'm6', text: 'billing ledger retry webhook', embedding: vecOf(6) }),
      makeMemory({ id: 'm7', text: 'cache warmup job', embedding: vecOf(7) }),
      makeMemory({ id: 'm8', text: 'the old port was 9090', createdAt: t(1) }),
    ];
    await store.upsertMany(TG, base);
    // A rewrite of the text, the stub and the entities.
    await store.upsert(TG, {
      ...base[0]!,
      text: 'Auth service moved to port 9443',
      entities: ['auth', 'tls'],
    });
    // An unchanged rewrite (only salience moves).
    await store.upsert(TG, { ...base[1]!, salience: 0.9 });
    // Tier changes: guarded and unguarded, warm to hot, to cold through setTier and coldPut.
    expect(await store.setTier(TG, 'm5', 'warm')).toBe(true);
    expect(await store.setTier(TG, 'm6', 'cold')).toBe(true);
    const m7 = (await store.get(TG, 'm7'))!;
    expect((await store.coldPut(TG, m7)).skipped).toEqual([]);
    expect(
      await store.setTier(TG, 'm3', 'hot', { updatedAt: base[2]!.updatedAt, tier: 'warm' }),
    ).toBe(true);
    // A cold memory written warm again (as a recall that hydrates it does).
    await store.upsert(TG, { ...m7, tier: 'warm' });
    // A guarded batch (consolidation) and an import with links.
    const m4 = (await store.get(TG, 'm4'))!;
    await store.upsertManyIfUnchanged!(TG, [
      { next: { ...m4, text: 'half-width API now', updatedAt: t(5) }, was: m4 },
      { next: { ...m4, text: 'never written' }, was: { ...m4, updatedAt: t(2) } },
    ]);
    await store.upsertManyLinked!(
      TG,
      [
        makeMemory({ id: 'i1', text: 'imported deploy note', entities: ['deploy'] }),
        makeMemory({ id: 'i2', text: 'imported staging note', entities: ['deploy'] }),
      ],
      [['i1', 'i2']],
      { assertedBy: 'user' },
    );
    // A forget that rewrites the memory restating it (CON-144), then a plain forget.
    await store.upsert(
      TG,
      makeMemory({
        id: 'm9',
        text: 'port changed from 9090 to 8443',
        stub: 'port changed from 9090 to 8443',
        supersedes: 'm8',
        createdAt: t(2),
      }),
    );
    await store.upsert(TG, { ...base[7]!, supersededBy: 'm9' });
    const r = await forgetMemory(
      {
        store,
        write: {
          write: () => Promise.reject(new Error('not used')),
          rewriteCurrent: async (m) => ({
            text: 'port changed to 8443',
            stub: 'port 8443',
            entities: m.entities,
            type: m.type,
          }),
        },
        embed: { dimension: DIM, embed: async (x) => x.map(() => vecOf(51)) },
      },
      TG,
      'm8',
    );
    expect(r.notRewritten).toEqual([]);
    expect(r.rewritten.map((x) => x.id)).toEqual(['m9']);
    await store.forget(TG, 'm2');
    // A rid used again: forget the newest row, then write a new one.
    await store.forget(TG, 'i2');
    await store.upsert(TG, makeMemory({ id: 'i3', text: 'reused row id' }));
    await store.close();

    const { live, rebuilt, copy } = liveAndRebuilt(s);
    expect(live.instances.length).toBeGreaterThan(0);
    expect(live).toEqual(rebuilt);
    // One side row per memory, holding what tokenising the stored row gives.
    const rows = read<{ rid: number; tier: string; text: string; stub: string; entities: string }>(
      s.dbPath,
      'SELECT rid, tier, text, stub, entities FROM memories ORDER BY rid',
    );
    expect(live.values).toEqual(
      rows.map((m) => ({
        rid: m.rid,
        text: m.tier === 'cold' ? '' : indexed(m.text),
        stub: indexed(m.stub),
        entities: indexed((JSON.parse(m.entities) as string[]).join(' ')),
      })),
    );
    // And every search answers as over the rebuilt index.
    const other = await openSqliteStore({
      path: copy,
      coldDir: s.coldDir,
      dimension: DIM,
      vectorIndex: 'int8',
      log: () => {},
    });
    const again = await open(s);
    try {
      for (const q of [
        'port',
        '8080',
        '9443',
        '認証',
        'บริการ',
        'api',
        'deploy',
        'reused',
        '9090',
        'tls',
      ]) {
        expect(await again.lexical(TG, q, 20)).toEqual(await other.lexical(TG, q, 20));
      }
      expect(await again.lexical(TG, '9090', 20)).toEqual([]);
    } finally {
      await again.close();
      await other.close();
    }
  });

  it('fts-delete.a-memory-without-its-indexed-strings-rebuilds-the-index-in-its-transaction', async () => {
    const s = fresh();
    const logged: string[] = [];
    // A hook's open (no migrations): the rebuild cannot wait for the next `oort` command.
    let store: MemoryStore = await open(s);
    await store.upsertMany(TG, [
      makeMemory({ id: 'n', text: 'a neighbour' }),
      makeMemory({ id: 'secret', text: `the port is ${MARKER}`, entities: [MARKER] }),
      makeMemory({ id: 'edit', text: `edit ${MARKER}x me` }),
    ]);
    await store.close();
    // This runtime's ICU, which the rebuild records (not the default `lexicalIcuVersion()`).
    store = await open(s, { migrate: false, log: (m) => logged.push(m), icu: '72.1' });
    // A bug elsewhere lost their side rows.
    const db = raw(s.dbPath);
    db.prepare(
      `DELETE FROM ${FTS_VALUES_TABLE} WHERE rid IN (SELECT rid FROM memories WHERE id IN ('secret', 'edit'))`,
    ).run();
    db.close();

    await store.forget(TG, 'secret');
    expect(logged.filter((m) => m.includes('search index was rebuilt'))).toHaveLength(1);
    expect(logged.join('\n')).not.toContain(MARKER);
    expect(await store.lexical(TG, MARKER, 10)).toEqual([]);
    expect((await store.lexical(TG, `${MARKER}x`, 10)).map((h) => h.id)).toEqual(['edit']);
    // The rebuild gave every memory its side row back: the rewrite needs no second one.
    await store.upsert(TG, makeMemory({ id: 'edit', text: 'edited' }));
    expect(logged.filter((m) => m.includes('search index was rebuilt'))).toHaveLength(1);
    expect(await store.lexical(TG, `${MARKER}x`, 10)).toEqual([]);
    await store.close();
    checkpoint(s.dbPath);
    expect(inShadowTables(s.dbPath, MARKER)).toBe(false);
    expect(bytesOf(s.dbPath).includes(MARKER)).toBe(false);
    expect(read(s.dbPath, "SELECT value FROM meta WHERE key = 'lexical_rebuild'")).toEqual([]);
    expect(read(s.dbPath, "SELECT value FROM meta WHERE key = 'lexical_icu'")).toEqual([
      { value: '72' },
    ]);
    const { live, rebuilt } = liveAndRebuilt(s);
    expect(live).toEqual(rebuilt);
    expect(live.values).toHaveLength(2);
  });

  it(
    'fts-delete.forget-leaves-no-page-key-that-names-a-forgotten-term',
    { timeout: 300_000 },
    async () => {
      // FTS5 keeps one key per leaf page in `*_idx`: the shortest prefix of the page's first term
      // that sets it apart from the page before. Deleting that term leaves the key behind.
      const s = fresh();
      const store = await open(s);
      const N = 20_000;
      const term = (i: number) => `w${String(i).padStart(6, '0')}secretqq`;
      for (let i = 0; i < N; i += 2000) {
        await store.upsertMany(
          TG,
          Array.from({ length: 2000 }, (_, k) =>
            makeMemory({ id: `m${i + k}`, text: `common ${term(i + k)}`, stub: 'x' }),
          ),
        );
      }
      await store.close();
      let db = raw(s.dbPath);
      db.function(WRITER_GUARD, () => 1);
      db.exec(`INSERT INTO ${FTS_TABLE} (${FTS_TABLE}) VALUES ('optimize')`);
      db.close();
      // A page whose first term is one memory's alone, with a key longer than `w`.
      const keys = pageKeys(s.dbPath);
      const firsts = keys
        .filter((k) => k.length > 4 && k.startsWith('w'))
        .map((k) => ({
          k,
          owners: Array.from({ length: N }, (_, i) => i).filter((i) => term(i).startsWith(k)),
        }))
        .filter((x) => x.owners.length === 1);
      expect(firsts.length).toBeGreaterThan(2);
      const target = firsts[Math.floor(firsts.length / 2)]!;
      const forgotten = term(target.owners[0]!);
      expect(leakedKeys(s.dbPath, forgotten)).toEqual([]);

      const again = await open(s);
      await again.forget(TG, `m${target.owners[0]}`);
      await again.close();
      checkpoint(s.dbPath);
      expect(leakedKeys(s.dbPath, forgotten)).toEqual([]);
      expect(inShadowTables(s.dbPath, forgotten.slice(1))).toBe(false);
      expect(bytesOf(s.dbPath).includes(forgotten.slice(1))).toBe(false);
      db = raw(s.dbPath);
      db.exec(`INSERT INTO ${FTS_TABLE} (${FTS_TABLE}) VALUES ('integrity-check')`);
      db.close();
      // The merge kept every live entry and the BM25 totals.
      const { live, rebuilt } = liveAndRebuilt(s);
      expect(live).toEqual(rebuilt);
    },
  );

  it('fts-delete.a-page-key-ending-in-a-folded-letter-is-found', { timeout: 300_000 }, async () => {
    // unicode61 folds a final sigma (ς) to σ, so the index's term is not the stored token. With
    // `ω…ορ` before it, the page key of `ω…ος` is the whole term `ω…οσ`.
    const s = fresh();
    const store = await open(s);
    const N = 10_000;
    const word = (i: number, end: string) => `ω${String(i).padStart(5, '0')}ο${end}`;
    for (let i = 0; i < N; i += 1000) {
      await store.upsertMany(
        TG,
        Array.from({ length: 1000 }, (_, k) => [
          makeMemory({ id: `k${i + k}`, text: `common ${word(i + k, 'ρ')}`, stub: 'x' }),
          makeMemory({ id: `m${i + k}`, text: `common ${word(i + k, 'ς')}`, stub: 'x' }),
        ]).flat(),
      );
    }
    await store.close();
    optimizeRaw(s.dbPath);
    const keys = new Set(pageKeyBytes(s.dbPath).map((k) => k.toString('hex')));
    const owners = Array.from({ length: N }, (_, i) => i).filter((i) =>
      keys.has(Buffer.from(word(i, 'σ')).toString('hex')),
    );
    expect(owners.length).toBeGreaterThan(2);
    const i = owners[Math.floor(owners.length / 2)]!;
    const term = word(i, 'σ');

    const again = await open(s);
    await again.forget(TG, `m${i}`);
    await again.close();
    checkpoint(s.dbPath);
    expect(leakedKeys(s.dbPath, term)).toEqual([]);
    expect(inShadowTables(s.dbPath, term)).toBe(false);
    expect(bytesOf(s.dbPath).includes(term)).toBe(false);
    expect(bytesOf(s.dbPath).includes(word(i, 'ς'))).toBe(false);
    const { live, rebuilt } = liveAndRebuilt(s);
    expect(live).toEqual(rebuilt);
  });

  it.each([
    {
      script: 'CJK',
      // Bigrams over 2,000 Han characters spread across the block: page keys end inside a
      // 3-byte character, and hundreds of terms share each first character.
      text: (r: () => number) =>
        Array.from({ length: 40 }, () =>
          String.fromCodePoint(0x4e00 + 10 * Math.floor(r() * 2000)),
        ).join(''),
    },
    {
      script: 'Cyrillic',
      text: (r: () => number) =>
        Array.from({ length: 8 }, () =>
          Array.from({ length: 4 + Math.floor(r() * 4) }, () =>
            String.fromCodePoint(0x430 + Math.floor(r() * 32)),
          ).join(''),
        ).join(' '),
    },
  ])(
    'fts-delete.a-$script-forget-merges-only-when-a-key-would-keep-part-of-a-forgotten-word',
    { timeout: 300_000 },
    async ({ text }) => {
      const s = fresh();
      const store = await open(s);
      const N = 20_000;
      const r = prng(7);
      const texts = Array.from({ length: N }, () => text(r));
      for (let i = 0; i < N; i += 2000) {
        await store.upsertMany(
          TG,
          texts
            .slice(i, i + 2000)
            .map((t, k) => makeMemory({ id: `m${i + k}`, text: t, stub: 'x' })),
        );
      }
      await store.close();
      optimizeRaw(s.dbPath);

      const docs = termDocs(s.dbPath);
      const live = await open(s);
      const byHex = new Map(docs.map((d) => [d.hex, d]));
      let merges = 0;
      let leaks = 0;
      const gone: Buffer[] = [];
      try {
        for (let n = 0; n < 40; n++) {
          const id = `m${Math.floor(r() * N)}`;
          const rid = read<{ rid: number }>(
            s.dbPath,
            'SELECT rid FROM memories WHERE id = ?',
            id,
          )[0]?.rid;
          if (rid === undefined) continue;
          const terms = termsOf(s.dbPath, rid);
          const before = segids(s.dbPath);
          const keys = pageKeyBytes(s.dbPath);
          // Whether some key is a prefix of one of its terms and of no term still live after it.
          const liveAfter = (k: Buffer) => {
            for (let x = lowerBound(docs, k); x < docs.length; x++) {
              const d = docs[x]!;
              if (!startsWith(d.term, k)) return false;
              if (d.docs - (terms.has(d.hex) ? 1 : 0) > 0) return true;
            }
            return false;
          };
          const leak = keys.some(
            (k) => [...terms.values()].some((t) => startsWith(t, k)) && !liveAfter(k),
          );
          await live.forget(TG, id);
          const merged = segids(s.dbPath) !== before;
          expect(merged).toBe(leak);
          if (merged) merges++;
          if (leak) leaks++;
          for (const [hex, t] of terms) {
            const d = byHex.get(hex)!;
            d.docs--;
            if (d.docs === 0) gone.push(t);
          }
        }
      } finally {
        await live.close();
      }
      expect(merges).toBe(leaks);
      // No key is a prefix of a forgotten term unless a live term starts with it.
      const after = pageKeyBytes(s.dbPath);
      for (const t of gone) {
        for (const k of after) {
          if (!startsWith(t, k)) continue;
          const d = docs
            .slice(lowerBound(docs, k))
            .find((e) => !startsWith(e.term, k) || e.docs > 0);
          expect(d !== undefined && startsWith(d.term, k)).toBe(true);
        }
      }
      const { live: index, rebuilt } = liveAndRebuilt(s);
      expect(index).toEqual(rebuilt);
    },
  );

  it('fts-delete.a-forget-that-leaves-no-key-merges-nothing', async () => {
    const s = fresh();
    const store = await open(s);
    await store.upsertMany(TG, [makeMemory({ id: 'n', text: 'aaa neighbour' })]);
    await store.upsert(TG, makeMemory({ id: 'a', text: 'neighbour gone' }));
    await store.upsert(TG, makeMemory({ id: 'z', text: 'neighbour later' }));
    checkpoint(s.dbPath);
    const before = segments(s.dbPath);
    expect(before).toBeGreaterThan(1);
    await store.forget(TG, 'a');
    checkpoint(s.dbPath);
    expect(segments(s.dbPath)).toBe(before);
    await store.close();
  });

  it('fts-delete.an-index-declared-with-another-tokenizer-is-rebuilt', async () => {
    const s = fresh();
    let store = await open(s);
    await store.upsert(TG, makeMemory({ id: 'a', text: 'auth service' }));
    await store.close();
    const ftsSql = () =>
      read<{ sql: string }>(s.dbPath, 'SELECT sql FROM sqlite_master WHERE name = ?', FTS_TABLE)[0]!
        .sql;
    const other = FTS_TOKENIZE.replace(`tokenchars '-_.'`, `tokenchars '-_'`);
    expect(other).not.toBe(FTS_TOKENIZE);
    const db = raw(s.dbPath);
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare('UPDATE sqlite_master SET sql = ? WHERE name = ?').run(
      ftsSql().replace(FTS_TOKENIZE, other),
      FTS_TABLE,
    );
    db.close();
    expect(ftsSql()).not.toContain(FTS_TOKENIZE);
    const err = await open(s, { migrate: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreMigrationRequiredError);
    store = await open(s);
    expect((await store.lexical(TG, 'auth', 10)).map((h) => h.id)).toEqual(['a']);
    await store.close();
    expect(ftsSql()).toContain(FTS_TOKENIZE);
  });

  it('fts-delete.an-open-that-fails-setting-up-the-lexical-scratch-closes-its-connection', async () => {
    const s = fresh();
    await (await open(s)).close();
    const exec = Database.prototype.exec;
    const execSpy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
      if (sql.startsWith('ATTACH DATABASE')) throw new Error('attach failed');
      return exec.call(this, sql);
    });
    const closeSpy = vi.spyOn(Database.prototype, 'close');
    try {
      await expect(open(s)).rejects.toThrow('attach failed');
      const failed = execSpy.mock.contexts.at(-1) as Database.Database;
      expect(closeSpy.mock.contexts).toContain(failed);
      expect(failed.open).toBe(false);
    } finally {
      execSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('fts-delete.an-index-without-secure-delete-is-rebuilt', async () => {
    const s = fresh();
    let store = await open(s);
    await store.upsert(TG, makeMemory({ id: 'a', text: 'auth service' }));
    await store.close();
    const db = raw(s.dbPath);
    db.exec(`INSERT INTO ${FTS_TABLE} (${FTS_TABLE}, rank) VALUES ('secure-delete', 0)`);
    db.close();
    const err = await open(s, { migrate: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreMigrationRequiredError);
    store = await open(s);
    await store.close();
    expect(
      read<{ v: number }>(s.dbPath, `SELECT v FROM ${FTS_TABLE}_config WHERE k = 'secure-delete'`),
    ).toEqual([{ v: 1 }]);
  });
});

/** Every leaf-page key in the lexical index (`*_idx`), as bytes without its leading byte. */
function pageKeyBytes(dbPath: string): Buffer[] {
  return read<{ term: Buffer }>(dbPath, `SELECT term FROM ${FTS_TABLE}_idx`)
    .map((r) => Buffer.from(r.term).subarray(1))
    .filter((b) => b.length > 0);
}

/** The lexical index's segment ids, as one string: a merge writes new ones. */
const segids = (dbPath: string): string =>
  read<{ segid: number }>(dbPath, `SELECT DISTINCT segid FROM ${FTS_TABLE}_idx ORDER BY segid`)
    .map((r) => r.segid)
    .join(',');

const startsWith = (t: Buffer, k: Buffer): boolean => t.subarray(0, k.length).equals(k);

/** The first index of `sorted` whose term is at or after `k`, by bytes. */
function lowerBound(sorted: { term: Buffer }[], k: Buffer): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Buffer.compare(sorted[mid]!.term, k) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Merges the lexical index into one segment, as a long-lived store's index would be. */
function optimizeRaw(dbPath: string): void {
  const db = raw(dbPath);
  db.function(WRITER_GUARD, () => 1);
  db.exec(`INSERT INTO ${FTS_TABLE} (${FTS_TABLE}) VALUES ('optimize')`);
  db.close();
}

/** Every term of the lexical index, sorted by bytes, with how many memories hold it. */
function termDocs(dbPath: string): { term: Buffer; hex: string; docs: number }[] {
  const db = raw(dbPath, true);
  try {
    db.exec(`CREATE VIRTUAL TABLE temp.rows USING fts5vocab(main, ${FTS_TABLE}, row)`);
    return (db.prepare('SELECT term, doc FROM temp.rows').all() as { term: string; doc: number }[])
      .map((r) => {
        const term = Buffer.from(r.term);
        return { term, hex: term.toString('hex'), docs: r.doc };
      })
      .sort((a, b) => Buffer.compare(a.term, b.term));
  } finally {
    db.close();
  }
}

/** The terms the lexical index holds for one memory, keyed by their hex. */
function termsOf(dbPath: string, rid: number): Map<string, Buffer> {
  const db = raw(dbPath, true);
  try {
    db.exec(`CREATE VIRTUAL TABLE temp.inst USING fts5vocab(main, ${FTS_TABLE}, instance)`);
    const out = new Map<string, Buffer>();
    for (const r of db.prepare('SELECT term FROM temp.inst WHERE doc = ?').all(rid) as {
      term: string;
    }[]) {
      const b = Buffer.from(r.term);
      out.set(b.toString('hex'), b);
    }
    return out;
  } finally {
    db.close();
  }
}

/** A small deterministic generator, so a failure can be run again. */
function prng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/** The text of every leaf-page key in the lexical index (`*_idx`), without its leading byte. */
function pageKeys(dbPath: string): string[] {
  return read<{ term: Buffer }>(dbPath, `SELECT term FROM ${FTS_TABLE}_idx`)
    .map((r) => Buffer.from(r.term))
    .filter((b) => b.length > 1)
    .map((b) => b.subarray(1).toString('latin1'));
}

/** Page keys that are a prefix of `token` while no live term starts with them. */
function leakedKeys(dbPath: string, token: string): string[] {
  const db = raw(dbPath, true);
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS temp.terms USING fts5vocab(main, ${FTS_TABLE}, row)`,
    );
    const terms = (db.prepare('SELECT term FROM temp.terms').all() as { term: string }[]).map((r) =>
      Buffer.from(r.term),
    );
    const t = Buffer.from(token);
    return (db.prepare(`SELECT term FROM ${FTS_TABLE}_idx`).all() as { term: Buffer }[])
      .map((r) => Buffer.from(r.term).subarray(1))
      .filter((k) => k.length > 0 && t.subarray(0, k.length).equals(k))
      .filter((k) => !terms.some((x) => x.subarray(0, k.length).equals(k)))
      .map((k) => k.toString('latin1'));
  } finally {
    db.close();
  }
}

describe('schema migration 8 to 9 (CON-159)', () => {
  /** A version 9 store with memories, a cold one included. */
  async function seeded(): Promise<Paths> {
    const s = fresh();
    const store = await open(s);
    await store.upsertMany(TG, [
      makeMemory({ id: 'a', text: 'auth service on port 8080', entities: ['auth'] }),
      makeMemory({ id: 'b', text: '認証サービス', embedding: vecOf(2) }),
      makeMemory({ id: 'c', text: 'billing ledger', stub: 'ledger stub', tier: 'cold' }),
    ]);
    await store.close();
    return s;
  }

  const ftsSql = (dbPath: string) =>
    read<{ sql: string }>(dbPath, 'SELECT sql FROM sqlite_master WHERE name = ?', FTS_TABLE)[0]
      ?.sql;
  const hasValues = (dbPath: string) =>
    read(dbPath, 'SELECT 1 FROM sqlite_master WHERE name = ?', FTS_VALUES_TABLE).length > 0;
  const guards = (dbPath: string) =>
    read<{ sql: string }>(
      dbPath,
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memories_writer_guard_%' ORDER BY name",
    ).map((t) => /SELECT (\w+)\(\)/.exec(t.sql)?.[1]);
  const clearCopies = (s: Paths) => {
    for (const f of fs.readdirSync(s.dir)) if (f.includes('.pre-')) fs.rmSync(path.join(s.dir, f));
  };
  async function finds(s: Paths, q: string): Promise<string[]> {
    const store = await open(s);
    try {
      return (await store.lexical(TG, q, 10)).map((h) => h.id).sort();
    } finally {
      await store.close();
    }
  }

  it('fts-delete.v9-down-to-8-puts-the-contentless-delete-index-back', async () => {
    const s = await seeded();
    downgradeSqliteStore({ path: s.dbPath, to: 8 });
    expect(sqliteSchemaVersion(s.dbPath)).toBe(8);
    expect(ftsSql(s.dbPath)).toContain('contentless_delete = 1');
    expect(hasValues(s.dbPath)).toBe(false);
    expect(guards(s.dbPath)).toEqual(Array(3).fill('oort_writer_v8'));
    // Version 8's own writes (delete by rowid) work on it.
    const db = raw(s.dbPath);
    db.function('oort_writer_v8', () => 1);
    const { rid } = db.prepare("SELECT rid FROM memories WHERE id = 'a'").get() as { rid: number };
    db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(rid);
    db.exec(`INSERT INTO ${FTS_TABLE} (${FTS_TABLE}) VALUES ('integrity-check')`);
    db.close();
  });

  it('fts-delete.v8-to-v9-rebuilds-the-index-once-in-one-open', async () => {
    const s = await seeded();
    const want = {
      auth: await finds(s, 'auth'),
      ledger: await finds(s, 'ledger'),
      cjk: await finds(s, '認証'),
    };
    downgradeSqliteStore({ path: s.dbPath, to: 8 });
    clearCopies(s);
    const logged: string[] = [];
    await (await open(s, { log: (m) => logged.push(m) })).close();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(9);
    expect(logged.filter((m) => m.startsWith('Rebuilding the search index'))).toEqual([
      'Rebuilding the search index (3 memories)…',
    ]);
    // No copy: the rebuild reads the stored rows, and going back to 8 loses nothing.
    expect(fs.readdirSync(s.dir).filter((f) => f.includes('.pre-'))).toEqual([]);
    expect(ftsSql(s.dbPath)).not.toContain('contentless_delete');
    expect(guards(s.dbPath)).toEqual(Array(3).fill('oort_writer_v9'));
    expect({
      auth: await finds(s, 'auth'),
      ledger: await finds(s, 'ledger'),
      cjk: await finds(s, '認証'),
    }).toEqual(want);
    const { live, rebuilt } = liveAndRebuilt(s);
    expect(live).toEqual(rebuilt);
    expect(live.values).toHaveLength(3);
  });

  it('fts-delete.v8-open-that-may-not-migrate-changes-nothing', async () => {
    const s = await seeded();
    downgradeSqliteStore({ path: s.dbPath, to: 8 });
    const before = fs.readFileSync(s.dbPath);
    const err = await open(s, { migrate: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreMigrationRequiredError);
    expect((err as StoreMigrationRequiredError).from).toBe(8);
    expect(fs.readFileSync(s.dbPath).equals(before)).toBe(true);
  });

  it('fts-delete.a-v8-writer-fails-on-a-v9-store', async () => {
    const s = await seeded();
    const db = raw(s.dbPath);
    db.function('oort_writer_v8', () => 1);
    try {
      expect(() => db.prepare("UPDATE memories SET salience = 0.9 WHERE id = 'a'").run()).toThrow(
        /no such function: oort_writer_v9/,
      );
      expect(() => db.prepare("DELETE FROM memories WHERE id = 'a'").run()).toThrow(
        /no such function: oort_writer_v9/,
      );
    } finally {
      db.close();
    }
  });

  it('fts-delete.v9-down-to-7-and-to-3-and-up-again', async () => {
    for (const to of [7, 3] as const) {
      const s = await seeded();
      const want = await finds(s, 'auth');
      downgradeSqliteStore({ path: s.dbPath, to });
      expect(sqliteSchemaVersion(s.dbPath)).toBe(to);
      expect(hasValues(s.dbPath)).toBe(false);
      clearCopies(s);
      await (await open(s)).close();
      expect(sqliteSchemaVersion(s.dbPath)).toBe(9);
      expect(hasValues(s.dbPath)).toBe(true);
      expect(await finds(s, 'auth')).toEqual(want);
      const { live, rebuilt } = liveAndRebuilt(s);
      expect(live).toEqual(rebuilt);
    }
  });

  it('fts-delete.a-downgrade-leaves-no-words-in-free-pages', async () => {
    // Version 8 and version 3 each forget their own way (a delete by rowid, then a merge).
    for (const [to, table, guard] of [
      [8, 'memories_fts2', 'oort_writer_v8'],
      [3, 'memories_fts', undefined],
    ] as const) {
      const s = fresh();
      const store = await open(s);
      await store.upsertMany(TG, [
        makeMemory({ id: 'n', text: 'a neighbour' }),
        makeMemory({ id: 'secret', text: `the port is ${MARKER}`, entities: [MARKER] }),
      ]);
      await store.close();
      downgradeSqliteStore({ path: s.dbPath, to });
      clearCopies(s);
      // That version's forget, with its store's pragmas.
      const db = raw(s.dbPath);
      if (guard !== undefined) db.function(guard, () => 1);
      db.pragma('secure_delete = ON');
      db.pragma('journal_size_limit = 0');
      db.transaction(() => {
        const { rid } = db
          .prepare("DELETE FROM memories WHERE id = 'secret' RETURNING rid")
          .get() as {
          rid: number;
        };
        db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(rid);
        db.prepare("DELETE FROM memories_vec WHERE id = 'secret'").run();
        db.exec(`INSERT INTO ${table} (${table}) VALUES ('optimize')`);
      })();
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      expect(bytesOf(s.dbPath).includes(MARKER)).toBe(false);
    }
  });

  it('fts-delete.entities-that-do-not-parse-never-fail-the-upgrade', async () => {
    const s = await seeded();
    downgradeSqliteStore({ path: s.dbPath, to: 8 });
    clearCopies(s);
    const db = raw(s.dbPath);
    db.function('oort_writer_v8', () => 1);
    db.prepare("UPDATE memories SET entities = 'not json' WHERE id = 'a'").run();
    db.prepare(`UPDATE memories SET entities = '{"x":1}' WHERE id = 'b'`).run();
    db.close();
    await (await open(s)).close();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(9);
    expect(await finds(s, 'auth')).toEqual(['a']);
    expect(await finds(s, '認証')).toEqual(['b']);
    // And a write that has to index such a row again does not fail either.
    const raw2 = raw(s.dbPath);
    raw2
      .prepare(
        `DELETE FROM ${FTS_VALUES_TABLE} WHERE rid = (SELECT rid FROM memories WHERE id = 'a')`,
      )
      .run();
    raw2.close();
    const store = await open(s, { migrate: false });
    expect(await store.setTier(TG, 'a', 'hot')).toBe(true);
    await store.close();
    const { live, rebuilt } = liveAndRebuilt(s);
    expect(live).toEqual(rebuilt);
  });

  it('fts-delete.an-open-that-may-migrate-drops-a-pending-rebuild-mark', async () => {
    const s = fresh();
    let store = await open(s);
    await store.close();
    const db = raw(s.dbPath);
    db.prepare("INSERT INTO meta (key, value) VALUES ('lexical_rebuild', '1')").run();
    db.close();
    store = await open(s, { migrate: false });
    await store.close();
    expect(read(s.dbPath, "SELECT value FROM meta WHERE key = 'lexical_rebuild'")).toHaveLength(1);
    store = await open(s);
    await store.close();
    expect(read(s.dbPath, "SELECT value FROM meta WHERE key = 'lexical_rebuild'")).toEqual([]);
  });

  it('fts-delete.a-v9-store-without-its-side-table-is-repaired', async () => {
    const s = await seeded();
    const db = raw(s.dbPath);
    db.exec(`DROP TABLE ${FTS_VALUES_TABLE}`);
    db.close();
    const err = await open(s, { migrate: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreMigrationRequiredError);
    await (await open(s)).close();
    expect(hasValues(s.dbPath)).toBe(true);
    const { live, rebuilt } = liveAndRebuilt(s);
    expect(live).toEqual(rebuilt);
  });
});
