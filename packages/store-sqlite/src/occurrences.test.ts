/**
 * Event time in the SQLite store: the conformance suite, schema version 10 and its
 * migration from version 9, and the plan of the range read.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterAll, describe, expect, it } from 'vitest';
import { occurrencesOf, type Memory } from '@oortmem/core';
import { makeMemory, occurrenceConformance, TG } from '@oortmem/core/store-conformance';
import {
  downgradeSqliteStore,
  OCCURRED_READ,
  OCCURRED_TABLE,
  openSqliteStore,
  SHORT_OCCURRENCE_DAYS,
  SCHEMA_VERSION,
  sqliteSchemaVersion,
  StoreMigrationRequiredError,
  WRITER_GUARD,
} from './index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-occurred-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fresh(): { dbPath: string; coldDir: string } {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  return { dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
}
const optsFor = (s: { dbPath: string; coldDir: string }) => ({
  path: s.dbPath,
  coldDir: s.coldDir,
  dimension: 4,
  log: () => {},
});

occurrenceConformance('sqlite', () => openSqliteStore(optsFor(fresh())));

/** A raw connection, as an older Oort or a tool would open the file: no writer guard. */
function raw(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  return db;
}

const columns = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM pragma_table_info('memories')").all() as { name: string }[]).map(
    (c) => c.name,
  );
const hasTable = (db: Database.Database, name: string): boolean =>
  db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined;

describe('schema version 10: event time', () => {
  const said = '2023-05-22T10:00:00.000Z';
  const hiking = 'I went hiking with Sam last weekend.';
  /** Two memories as Oort before event time stored them: text and a time, no `occurred`. */
  const before: Memory[] = [
    makeMemory({ id: 'hike', text: hiking, createdAt: said, validFrom: said, updatedAt: said }),
    makeMemory({
      id: 'plain',
      text: 'The auth service listens on port 8080.',
      createdAt: said,
      validFrom: said,
      updatedAt: said,
    }),
  ];

  /** A version 9 store holding `before`, as Oort before event time leaves it. */
  async function v9(): Promise<{ dbPath: string; coldDir: string }> {
    const s = fresh();
    const store = await openSqliteStore(optsFor(s));
    await store.upsertMany(TG, before);
    await store.close();
    downgradeSqliteStore({ path: s.dbPath, to: 9 });
    return s;
  }

  it('occurred.new-store-starts-at-v10-with-the-event-time-index', async () => {
    const s = fresh();
    await (await openSqliteStore(optsFor(s))).close();
    expect(SCHEMA_VERSION).toBe(10);
    expect(sqliteSchemaVersion(s.dbPath)).toBe(10);
    const db = raw(s.dbPath);
    try {
      expect(columns(db)).toContain('occurred');
      expect(hasTable(db, OCCURRED_TABLE)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('occurred.down-to-9-drops-the-column-and-the-index-and-puts-the-v9-guard-back', async () => {
    const s = await v9();
    expect(sqliteSchemaVersion(s.dbPath)).toBe(9);
    const db = raw(s.dbPath);
    try {
      expect(columns(db)).not.toContain('occurred');
      expect(hasTable(db, OCCURRED_TABLE)).toBe(false);
      const guards = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%guard%'")
        .all() as { sql: string }[];
      expect(guards).toHaveLength(3);
      for (const g of guards) expect(g.sql).toContain('oort_writer_v9()');
    } finally {
      db.close();
    }
  });

  it('occurred.v9-to-v10-reads-each-memorys-event-time-from-its-text', async () => {
    const s = await v9();
    const store = await openSqliteStore(optsFor(s));
    try {
      expect(sqliteSchemaVersion(s.dbPath)).toBe(SCHEMA_VERSION);
      // Additive and read again from text: no copy of every memory is taken.
      expect(fs.readdirSync(path.dirname(s.dbPath)).filter((n) => n.includes('.pre-v'))).toEqual(
        [],
      );
      const hike = await store.get(TG, 'hike');
      // Read against the time it was stored, as the write path reads a turn against its time.
      expect(hike?.occurred).toEqual(occurrencesOf(hiking, new Date(said)));
      expect(hike?.occurred?.[0]).toMatchObject({
        from: '2023-05-20T00:00:00.000Z',
        to: '2023-05-22T00:00:00.000Z',
        source: 'relative',
      });
      // A memory that states no date has only the day it was said.
      expect((await store.get(TG, 'plain'))?.occurred).toEqual([
        {
          from: '2023-05-22T00:00:00.000Z',
          to: '2023-05-23T00:00:00.000Z',
          precision: 'day',
          source: 'mention',
        },
      ]);
      const range = { from: '2023-05-20T00:00:00.000Z', to: '2023-05-21T00:00:00.000Z' };
      expect((await store.occurredIn!(TG, range, 10)).map((h) => h.id)).toEqual(['hike']);
      // Everything else reads back as version 9 kept it.
      const strip = ({ occurred: _o, ...m }: Memory) => m;
      expect((await store.get(TG, 'plain')) && strip((await store.get(TG, 'plain'))!)).toEqual(
        before[1],
      );
    } finally {
      await store.close();
    }
  });

  it('occurred.v9-to-v10-reads-a-refined-memory-against-its-last-rewrite', async () => {
    // Created 1 May, refined on 10 June with "last weekend": that weekend is 3 to 4 June.
    const s = fresh();
    const store = await openSqliteStore(optsFor(s));
    await store.upsert(
      TG,
      makeMemory({
        id: 'refined',
        text: 'I went hiking with Sam last weekend.',
        createdAt: '2023-05-01T09:00:00.000Z',
        validFrom: '2023-05-01T09:00:00.000Z',
        updatedAt: '2023-06-10T09:00:00.000Z',
        source: {
          harness: 'claude-code',
          decisions: [
            {
              stage: 'refine',
              question: 'previous-text',
              answer: 'I like hiking.',
              probability: 1,
            },
          ],
        },
      }),
    );
    await store.close();
    downgradeSqliteStore({ path: s.dbPath, to: 9 });
    const again = await openSqliteStore(optsFor(s));
    try {
      expect((await again.get(TG, 'refined'))?.occurred?.[0]).toMatchObject({
        from: '2023-06-03T00:00:00.000Z',
        to: '2023-06-05T00:00:00.000Z',
      });
    } finally {
      await again.close();
    }
  });

  it('occurred.v9-open-that-may-not-migrate-changes-nothing', async () => {
    const s = await v9();
    const bytes = fs.readFileSync(s.dbPath);
    const err = await openSqliteStore({ ...optsFor(s), migrate: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreMigrationRequiredError);
    expect((err as StoreMigrationRequiredError).from).toBe(9);
    expect(fs.readFileSync(s.dbPath).equals(bytes)).toBe(true);
  });

  it('occurred.a-v9-writer-fails-on-a-v10-store', async () => {
    // An Oort process started before the upgrade keeps its connection: its next write must fail,
    // not leave a memory's occurrences behind its new text.
    const s = fresh();
    await (await openSqliteStore(optsFor(s))).close();
    expect(WRITER_GUARD).toBe('oort_writer_v10');
    const db = raw(s.dbPath);
    try {
      db.function('oort_writer_v9', () => 1);
      expect(() =>
        db
          .prepare(
            `INSERT INTO memories (id, level, org_id, type, text, stub, entities, salience, pinned,
               tier, access_log, valid_from, author_agent_id, source, created_at, updated_at)
             VALUES ('x', 'user', 'local', 'semantic', 't', 's', '[]', 0.5, 0, 'warm', '{}',
               '2023-01-01', 'a', '{}', '2023-01-01', '2023-01-01')`,
          )
          .run(),
      ).toThrow(/no such function: oort_writer_v10/);
    } finally {
      db.close();
    }
  });

  it('occurred.a-forgotten-memory-leaves-no-rows', async () => {
    const s = fresh();
    const store = await openSqliteStore(optsFor(s));
    await store.upsert(TG, { ...before[0]!, occurred: occurrencesOf(hiking, new Date(said)) });
    await store.forget(TG, 'hike');
    await store.close();
    const db = raw(s.dbPath);
    try {
      expect(db.prepare(`SELECT count(*) AS n FROM ${OCCURRED_TABLE}`).get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('occurred.the-range-read-is-two-bounded-ranges-of-its-index', async () => {
    const s = fresh();
    await (await openSqliteStore(optsFor(s))).close();
    const db = raw(s.dbPath);
    try {
      const names = [...new Set([...OCCURRED_READ.matchAll(/@(\w+)/g)].map((m) => m[1]!))];
      const steps = (
        db
          .prepare(`EXPLAIN QUERY PLAN ${OCCURRED_READ}`)
          .all(Object.fromEntries(names.map((n) => [n, null]))) as { detail: string }[]
      ).map((r) => r.detail);
      // Short occurrences and long ones, each a range of the index by start: a short one is read
      // only from a month before the range, so "yesterday" does not walk a year of rows.
      const ranges = steps.filter((d) =>
        /SEARCH \w+ USING COVERING INDEX memory_occurred_from \(long=\? AND from_ms>\? AND from_ms<\?\)/.test(
          d,
        ),
      );
      expect(ranges, steps.join('\n')).toHaveLength(2);
      expect(steps.join('\n')).toMatch(/SEARCH m USING INTEGER PRIMARY KEY \(rowid=\?\)/);
      // No table is scanned: only the union of the two index ranges is read through.
      expect(steps.filter((d) => /^SCAN (m|memories|memory_occurred)\b/.test(d))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('occurred.yesterday-reads-only-recent-short-rows', async () => {
    // A store with a year of memories, one a day: a read for one day looks at a month of short
    // rows at most, not the year, and still finds a long occurrence that started long before.
    const s = fresh();
    const store = await openSqliteStore(optsFor(s));
    const day = 86_400_000;
    const start = Date.parse('2023-01-01T00:00:00.000Z');
    const ms: Memory[] = [];
    for (let i = 0; i < 365; i++) {
      const at = new Date(start + i * day).toISOString();
      ms.push(
        makeMemory({
          id: `d${i}`,
          text: `note ${i}`,
          createdAt: at,
          validFrom: at,
          updatedAt: at,
          occurred: occurrencesOf(`note ${i}`, new Date(at)),
        }),
      );
    }
    const yearAt = '2023-01-02T00:00:00.000Z';
    ms.push(
      makeMemory({
        id: 'year',
        text: 'In 2023 I learned to sail.',
        createdAt: yearAt,
        validFrom: yearAt,
        updatedAt: yearAt,
        occurred: occurrencesOf('In 2023 I learned to sail.', new Date(yearAt)),
      }),
    );
    await store.upsertMany(TG, ms);
    const range = { from: '2023-12-30T00:00:00.000Z', to: '2023-12-31T00:00:00.000Z' };
    const ids = (await store.occurredIn!(TG, range, 10)).map((h) => h.id);
    expect(ids).toEqual(['year', 'd363']);
    await store.close();
    const db = raw(s.dbPath);
    try {
      const from = Date.parse(range.from);
      const to = Date.parse(range.to);
      const read = (sql: string) => (db.prepare(sql).get({ from, to }) as { n: number }).n;
      // What the short arm's index range covers: rows that start within 31 days before.
      expect(
        read(
          `SELECT count(*) AS n FROM ${OCCURRED_TABLE} WHERE long = 0 AND from_ms >= @from - ${SHORT_OCCURRENCE_DAYS} * 86400000 AND from_ms < @to`,
        ),
      ).toBeLessThanOrEqual(SHORT_OCCURRENCE_DAYS + 1);
    } finally {
      db.close();
    }
  });
});
