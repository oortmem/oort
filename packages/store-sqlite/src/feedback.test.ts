/**
 * Recall feedback in the SQLite store: `feedbackConformance`, rows that survive a reopen without
 * a schema change, a table from an earlier build, orphan rows swept on open, forgotten rows whose
 * text is gone from the file and the WAL, the indexes the reads use, and resolves and `helped`
 * marks at once against one file.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import {
  dismissFeedback,
  forgetMemory,
  recordFeedback,
  retireFeedback,
  supersedeFeedback,
  FeedbackError,
  type MemoryStore,
} from '@oortmem/core';
import {
  CONFORMANCE_DIMENSION,
  feedbackConformance,
  makeFeedback,
  makeMemory,
  TG,
} from '@oortmem/core/store-conformance';
import { openSqliteStore, ORPHAN_SWEEP_KEY } from './index.js';
import { FEEDBACK_TABLE, SCHEMA_VERSION, WRITER_GUARD } from './schema.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-store-feedback-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function optsIn(dir: string) {
  return {
    path: path.join(dir, 'oort.sqlite'),
    coldDir: path.join(dir, 'cold'),
    dimension: CONFORMANCE_DIMENSION,
  };
}

const fresh = () => fs.mkdtempSync(path.join(root, 'case-'));

feedbackConformance('sqlite', () => openSqliteStore(optsIn(fresh())));

const SCOPE = { orgId: 'local', customerId: 'self', agentId: 'claude-code' };
const NOW = new Date('2026-11-16T12:00:00.000Z');

describe('sqlite feedback', () => {
  it('feedback.survives-a-reopen-without-a-schema-change', async () => {
    const dir = fresh();
    const s1 = await openSqliteStore(optsIn(dir));
    await s1.upsert(TG, makeMemory({ id: 'm1', scope: SCOPE }));
    expect(await s1.putFeedback!(TG, makeFeedback({ id: 'f1' }))).toBe('written');
    await s1.close();
    const db = new Database(optsIn(dir).path, { readonly: true });
    const version = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    db.close();
    expect(version.value).toBe(String(SCHEMA_VERSION));
    const s2 = await openSqliteStore(optsIn(dir));
    expect((await s2.getFeedback!(TG, 'f1'))?.note).toBe('The port moved to 8080');
    await s2.close();
  });

  it('feedback.reads-use-the-indexes', async () => {
    const dir = fresh();
    const s = await openSqliteStore(optsIn(dir));
    await s.close();
    const db = new Database(optsIn(dir).path, { readonly: true });
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(' ');
    // A forget, and recall's lookup of the memories it returns: the memory index, not a scan.
    expect(plan(`DELETE FROM ${FEEDBACK_TABLE} WHERE memory_id = 'm1'`)).toMatch(
      /USING (COVERING )?INDEX feedback_memory_status/,
    );
    const lookup = plan(
      `SELECT record FROM ${FEEDBACK_TABLE}
       WHERE memory_id IN (SELECT value FROM json_each('["m1","m2"]'))
         AND status IN (SELECT value FROM json_each('["open","resolving"]'))`,
    );
    expect(lookup).toMatch(/USING INDEX feedback_memory_status \(memory_id=\? AND status=\?\)/);
    expect(lookup).not.toMatch(/SCAN feedback/);
    // A list at one address, newest first: the address index, in order.
    const listed = plan(
      `SELECT record FROM ${FEEDBACK_TABLE} WHERE org_id = 'local' AND level = 'user'
       AND customer_id = 'self' AND agent_id = 'claude-code' ORDER BY created_at DESC`,
    );
    expect(listed).toMatch(/USING INDEX feedback_node/);
    expect(listed).not.toMatch(/TEMP B-TREE/);
    expect(plan(`SELECT id FROM ${FEEDBACK_TABLE} WHERE status = 'open'`)).toMatch(
      /USING (COVERING )?INDEX feedback_status/,
    );
    expect(plan(`SELECT id FROM ${FEEDBACK_TABLE} WHERE helped_key = 'm1|ada|2026-11-16'`)).toMatch(
      /USING (COVERING )?INDEX feedback_helped/,
    );
    // Rows whose memory is gone, swept on open: one probe of the memory id per row.
    expect(
      plan(
        `DELETE FROM ${FEEDBACK_TABLE} WHERE NOT EXISTS
         (SELECT 1 FROM memories WHERE memories.id = ${FEEDBACK_TABLE}.memory_id)`,
      ),
    ).toMatch(/SEARCH memories USING (COVERING )?INDEX/);
    db.close();
  });

  it('feedback.forget-leaves-no-text-in-the-file-or-the-wal', async () => {
    const dir = fresh();
    const s = await openSqliteStore(optsIn(dir));
    const dbPath = optsIn(dir).path;
    const words = ['quokkanotewrong', 'numbatquerystale'];
    await s.upsert(TG, makeMemory({ id: 'm1', scope: SCOPE }));
    await s.putFeedback!(TG, makeFeedback({ id: 'f1', note: words[0]! }));
    await s.putFeedback!(
      TG,
      makeFeedback({ id: 'f2', signal: 'irrelevant', status: 'recorded', query: words[1]! }),
    );
    expect(fs.readFileSync(`${dbPath}-wal`).includes(words[0]!)).toBe(true);
    await forgetMemory({ store: s }, TG, 'm1');
    expect(await s.listFeedback!(TG)).toEqual([]);
    const wal = fs.existsSync(`${dbPath}-wal`) ? fs.readFileSync(`${dbPath}-wal`) : Buffer.alloc(0);
    const main = fs.readFileSync(dbPath);
    for (const w of words) {
      expect(wal.includes(w), `${w} in the WAL`).toBe(false);
      expect(main.includes(w), `${w} in the file`).toBe(false);
    }
    await s.close();
  });

  it('feedback.two-resolves-at-once-exactly-one-wins', async () => {
    const dir = fresh();
    const s = await openSqliteStore(optsIn(dir));
    const later = new Date('2026-11-16T13:00:00.000Z');
    const as = (store: MemoryStore) => ({
      store,
      grant: TG,
      scope: SCOPE,
      by: 'local-user',
      now: later,
    });
    const resolves = {
      retire: (id: string) => retireFeedback(id, as(s)),
      dismiss: (id: string) => dismissFeedback(id, as(s)),
      supersede: (id: string) =>
        supersedeFeedback(id, 'The service listens on 8080', { ...as(s), harness: 'test' }),
    };
    const pairs = [
      ['retire', 'retire'],
      ['retire', 'dismiss'],
      ['supersede', 'retire'],
      ['supersede', 'dismiss'],
      ['supersede', 'supersede'],
    ] as const;
    for (const [i, [x, y]] of pairs.entries()) {
      const id = `m${i}`;
      await s.upsert(TG, makeMemory({ id, scope: SCOPE, validFrom: '2026-11-01T00:00:00.000Z' }));
      const r = await recordFeedback(
        { memoryId: id, signal: 'wrong', by: 'local-user' },
        { store: s, grant: TG, scope: SCOPE, via: 'cli', now: NOW },
      );
      if (!r.kept) throw new Error('not kept');
      const rs = await Promise.allSettled([resolves[x](r.feedback.id), resolves[y](r.feedback.id)]);
      expect(
        rs.filter((v) => v.status === 'fulfilled'),
        `${x}+${y}`,
      ).toHaveLength(1);
      const lost = rs.find((v) => v.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(FeedbackError);
      expect((lost.reason as FeedbackError).memoryChanged).toBeUndefined();
      const row = (await s.getFeedback!(TG, r.feedback.id))!;
      const all = (await s.list(TG, { validOnly: false, embeddings: false })).filter(
        (m) => m.id === id || m.supersedes === id,
      );
      const old = all.find((m) => m.id === id)!;
      if (row.status === 'dismissed') expect(old.expiredAt).toBeNull();
      if (row.status === 'retired') expect(old.endReason).toBe('corrected');
      if (row.status === 'superseded') expect(old.supersededBy).toBe(row.resolved?.supersededBy);
      expect(all).toHaveLength(row.status === 'superseded' ? 2 : 1);
    }
    await s.close();
  });

  it('feedback.a-table-from-an-earlier-build-gains-the-new-column', async () => {
    const dir = fresh();
    const s1 = await openSqliteStore(optsIn(dir));
    await s1.upsert(TG, makeMemory({ id: 'm1', scope: SCOPE }));
    await s1.close();
    // The table as the first build with feedback wrote it: no helped_key, the old indexes.
    const raw = new Database(optsIn(dir).path);
    raw.exec(`DROP TABLE ${FEEDBACK_TABLE};
      CREATE TABLE ${FEEDBACK_TABLE} (id TEXT PRIMARY KEY, level TEXT NOT NULL,
        org_id TEXT NOT NULL, customer_id TEXT, agent_id TEXT, hive_id TEXT, run_id TEXT,
        project_id TEXT, author_agent_id TEXT, memory_id TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, record TEXT NOT NULL);
      CREATE INDEX ${FEEDBACK_TABLE}_address ON ${FEEDBACK_TABLE} (org_id, level, created_at);
      CREATE INDEX ${FEEDBACK_TABLE}_memory ON ${FEEDBACK_TABLE} (memory_id);`);
    const old = makeFeedback({ id: 'f1' });
    raw
      .prepare(
        `INSERT INTO ${FEEDBACK_TABLE} (id, level, org_id, customer_id, agent_id, memory_id,
         status, created_at, record) VALUES ('f1', 'agent', 'local', 'self', 'claude-code', 'm1',
         'open', @at, @record)`,
      )
      .run({ at: old.createdAt, record: JSON.stringify(old) });
    raw.close();
    const s2 = await openSqliteStore(optsIn(dir));
    expect((await s2.getFeedback!(TG, 'f1'))?.note).toBe('The port moved to 8080');
    expect(
      await s2.putFeedback!(
        TG,
        makeFeedback({
          id: 'f2',
          signal: 'helped',
          status: 'recorded',
          helpedKey: 'm1|ada|2026-11-16',
        }),
      ),
    ).toBe('written');
    expect(
      await s2.putFeedback!(
        TG,
        makeFeedback({
          id: 'f3',
          signal: 'helped',
          status: 'recorded',
          helpedKey: 'm1|ada|2026-11-16',
        }),
      ),
    ).toBe('helped-today');
    await s2.close();
    const db = new Database(optsIn(dir).path, { readonly: true });
    const cols = (
      db.prepare(`PRAGMA table_info(${FEEDBACK_TABLE})`).all() as { name: string }[]
    ).map((c) => c.name);
    const indexes = (
      db.prepare(`PRAGMA index_list(${FEEDBACK_TABLE})`).all() as { name: string }[]
    ).map((i) => i.name);
    db.close();
    expect(cols).toContain('helped_key');
    expect(indexes).not.toContain(`${FEEDBACK_TABLE}_memory`);
    expect(indexes).toEqual(
      expect.arrayContaining([
        `${FEEDBACK_TABLE}_node`,
        `${FEEDBACK_TABLE}_memory_status`,
        `${FEEDBACK_TABLE}_helped`,
      ]),
    );
  });

  it('feedback.orphan-rows-go-when-the-store-opens-at-most-once-a-day', async () => {
    const dir = fresh();
    const T0 = Date.parse('2026-11-16T08:00:00.000Z');
    const at = (hours: number) => ({ ...optsIn(dir), now: () => new Date(T0 + hours * 3_600_000) });
    const s1 = await openSqliteStore(at(0));
    for (const id of ['m1', 'm2', 'm3', 'm4']) {
      await s1.upsert(TG, makeMemory({ id, scope: SCOPE }));
    }
    await s1.putFeedback!(TG, makeFeedback({ id: 'f1', note: 'wallabyorphannote' }));
    for (const id of ['f2', 'f3', 'f4']) {
      await s1.putFeedback!(TG, makeFeedback({ id, memoryId: `m${id.slice(1)}` }));
    }
    await s1.close();
    const dbPath = optsIn(dir).path;
    // An earlier build forgets a memory without knowing the feedback table.
    const forgetRaw = (memoryId: string, also?: (db: Database.Database) => void) => {
      const raw = new Database(dbPath);
      raw.function(WRITER_GUARD, () => 1);
      raw.prepare(`DELETE FROM memories WHERE id = ?`).run(memoryId);
      also?.(raw);
      raw.close();
    };
    const ids = async (hours: number, migrate = true) => {
      const s = await openSqliteStore({ ...at(hours), ...(!migrate && { migrate: false }) });
      const out = (await s.listFeedback!(TG)).map((f) => f.id).sort();
      await s.close();
      return out;
    };
    forgetRaw('m1');
    // A hook opens without migrating and leaves the sweep to a later process.
    expect(await ids(1, false)).toEqual(['f1', 'f2', 'f3', 'f4']);
    // The first open swept within the day: a second open does not sweep again.
    expect(await ids(2)).toEqual(['f1', 'f2', 'f3', 'f4']);
    // A day after the last sweep, the next open sweeps, and the note leaves the WAL too.
    expect(await ids(25)).toEqual(['f2', 'f3', 'f4']);
    const wal = fs.existsSync(`${dbPath}-wal`) ? fs.readFileSync(`${dbPath}-wal`) : Buffer.alloc(0);
    expect(wal.includes('wallabyorphannote')).toBe(false);
    expect(fs.readFileSync(dbPath).includes('wallabyorphannote')).toBe(false);
    // A sweep marker another build wrote, or none (a store from before it), sweeps at once.
    forgetRaw('m2', (db) =>
      db
        .prepare(`UPDATE meta SET value = json_set(value, '$.build', 'older') WHERE key = ?`)
        .run(ORPHAN_SWEEP_KEY),
    );
    expect(await ids(26)).toEqual(['f3', 'f4']);
    forgetRaw('m3', (db) => db.prepare(`DELETE FROM meta WHERE key = ?`).run(ORPHAN_SWEEP_KEY));
    expect(await ids(27)).toEqual(['f4']);
    // A clock set back counts as due.
    forgetRaw('m4');
    expect(await ids(-5)).toEqual([]);
  });

  it('feedback.five-helped-at-once-against-one-file-apply-once', async () => {
    const dir = fresh();
    const s = await openSqliteStore(optsIn(dir));
    await s.upsert(TG, makeMemory({ id: 'm1', scope: SCOPE }));
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        recordFeedback(
          { memoryId: 'm1', signal: 'helped', by: 'local-user' },
          { store: s, grant: TG, scope: SCOPE, via: 'cli', now: NOW },
        ),
      ),
    );
    expect(rs.filter((r) => r.kept && r.applied)).toHaveLength(1);
    expect(rs.filter((r) => r.kept && r.reason === 'already-helped-today')).toHaveLength(4);
    expect(await s.listFeedback!(TG, { signal: 'helped' })).toHaveLength(5);
    await s.close();
  });
});
