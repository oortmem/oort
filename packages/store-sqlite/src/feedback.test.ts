/**
 * Recall feedback in the SQLite store: `feedbackConformance`, rows that survive a reopen without
 * a schema change, forgotten rows whose text is gone from the file and the WAL, the indexes the
 * reads use, and two resolves at once against one file.
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
import { openSqliteStore } from './index.js';
import { FEEDBACK_TABLE, SCHEMA_VERSION } from './schema.js';

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
    await s1.putFeedback!(TG, makeFeedback({ id: 'f1' }));
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
    expect(plan(`DELETE FROM ${FEEDBACK_TABLE} WHERE memory_id = 'm1'`)).toMatch(
      /USING (COVERING )?INDEX feedback_memory/,
    );
    expect(
      plan(
        `SELECT id FROM ${FEEDBACK_TABLE} WHERE org_id = 'local' AND level = 'user'
         AND customer_id IS 'self' AND agent_id IS NULL AND memory_id IN ('m1', 'm2')`,
      ),
    ).toMatch(/USING (COVERING )?INDEX feedback_(address|memory)/);
    expect(plan(`SELECT id FROM ${FEEDBACK_TABLE} WHERE status = 'open'`)).toMatch(
      /USING (COVERING )?INDEX feedback_status/,
    );
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
    const as = (store: MemoryStore) => ({ store, grant: TG, by: 'local-user', now: later });
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
});
