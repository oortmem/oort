import { describe, expect, it, vi } from 'vitest';
import worker from './index.js';
import { pruneCliSessions } from './prune.js';
import type { RelayEnv } from './relay.js';
import { sqliteD1 } from './test/d1-sqlite.js';

const NOW = new Date('2026-11-04T12:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

function seeded() {
  const db = sqliteD1();
  const add = (id: string, code: string, at: string) =>
    db.raw
      .prepare('INSERT INTO cli_sessions (id, user_code, created_at) VALUES (?, ?, ?)')
      .run(id, code, at);
  add('old', 'BBBBBBBB', ago(61));
  add('recent', 'CCCCCCCC', ago(59));
  add('new', 'DDDDDDDD', ago(1));
  return db;
}

describe('cli_sessions pruning', () => {
  it('deletes sign-in requests older than an hour and keeps the rest', async () => {
    const db = seeded();
    expect(await pruneCliSessions(db, NOW)).toBe(1);
    const left = db.raw.prepare('SELECT id FROM cli_sessions ORDER BY id').all();
    expect(left).toEqual([{ id: 'new' }, { id: 'recent' }]);
  });

  it('uses the created_at index', () => {
    const db = sqliteD1();
    const plan = db.raw
      .prepare('EXPLAIN QUERY PLAN DELETE FROM cli_sessions WHERE created_at < ?')
      .all('x') as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('cli_sessions_created');
  });

  it('runs from the Worker scheduled handler and logs nothing', async () => {
    const db = seeded();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const env = { DB: db } as unknown as RelayEnv;
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ scheduledTime: NOW.getTime(), cron: '17 * * * *' }, env, {
      waitUntil: (p) => void pending.push(p),
    });
    await Promise.all(pending);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM cli_sessions').get()).toEqual({ n: 2 });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
