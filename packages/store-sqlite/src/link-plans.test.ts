/**
 * The link reads of recall stay bounded (CON-149): every statement `neighbours` runs is one range
 * of the index it was written for, whatever else the store holds. `budgetMs` is checked between
 * reads, not inside one, so these plans are what bound a single read. A change to a query or an
 * index that makes SQLite scan instead fails here.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { recall, resolveConfig, type MemoryStore, type Reranker } from '@oortmem/core';
import { makeMemory, memoryAt, nodesGrant, TG } from '@oortmem/core/store-conformance';
import {
  LINK_READS,
  openSqliteStore,
  StoreMigrationRequiredError,
  type LinkStats,
} from './index.js';
import { LINK_INDEXES } from './schema.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-link-plans-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fresh(): { dbPath: string; coldDir: string } {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  return { dbPath: path.join(dir, 'oort.sqlite'), coldDir: path.join(dir, 'cold') };
}
const openAt = (
  p: { dbPath: string; coldDir: string },
  extra: Partial<Parameters<typeof openSqliteStore>[0]> = {},
): Promise<MemoryStore> =>
  openSqliteStore({ path: p.dbPath, coldDir: p.coldDir, dimension: 4, log: () => {}, ...extra });

/** SQLite's plan for `sql`, one line per step. Every named parameter is bound (to NULL). */
function plan(db: Database.Database, sql: string): string[] {
  const names = [...new Set([...sql.matchAll(/@(\w+)/g)].map((m) => m[1] as string))];
  const st = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  return (st.all(Object.fromEntries(names.map((n) => [n, null]))) as { detail: string }[]).map(
    (r) => r.detail,
  );
}
/**
 * The steps that read a stored table (`memories` as `m`, the entity index as `e`, the link
 * table). Steps over a subquery's own rows, or over the grant's project list, read nothing stored.
 */
const reads = (steps: string[]): string[] =>
  steps.filter((d) => /^(SEARCH|SCAN) (memories|memory_links|memory_entities|m|e)\b/.test(d));

/**
 * One memory's explicit links of one asserter from the `a` end: all three columns are matched,
 * through either index that holds them (both include the key's columns).
 */
const A_END =
  /USING COVERING INDEX memory_links_(a \(a_rid=\? AND kind=\? AND asserted_by=\?\)|by \(kind=\? AND asserted_by=\? AND a_rid=\?\))/;
const NODE =
  'level=? AND org_id=? AND customer_id=? AND agent_id=? AND hive_id=? AND run_id=? AND session_id=?';
/** What each statement must do, and nothing else: no step may be a SCAN. */
const EXPECTED: Record<string, { sql: string; uses: RegExp[] }> = {
  anyUserLink: {
    sql: LINK_READS.anyUserLink(),
    uses: [/USING COVERING INDEX memory_links_by \(kind=\? AND asserted_by=\?\)/],
  },
  explicitRaw: {
    sql: LINK_READS.explicitRaw(),
    uses: [
      A_END,
      /USING COVERING INDEX memory_links_b \(b_rid=\? AND kind=\? AND asserted_by=\?\)/,
    ],
  },
  explicitEnds: {
    sql: LINK_READS.explicitEnds(2),
    uses: [
      A_END,
      /USING COVERING INDEX memory_links_b \(b_rid=\? AND kind=\? AND asserted_by=\?\)/,
      /SEARCH m USING INTEGER PRIMARY KEY \(rowid=\?\)/,
    ],
  },
  episodeRaw: {
    sql: LINK_READS.episodeRaw(),
    uses: [
      new RegExp(
        `INDEX memories_episode \\(${NODE.replace(/[?()]/g, '\\$&')} AND episode_seq>\\? AND episode_seq<\\?\\)`,
      ),
    ],
  },
  episodeNear: {
    sql: LINK_READS.episodeNear(2),
    uses: [
      new RegExp(
        `INDEX memories_episode \\(${NODE.replace(/[?()]/g, '\\$&')} AND episode_seq>\\? AND episode_seq<\\?\\)`,
      ),
    ],
  },
  entityRaw: {
    sql: LINK_READS.entityRaw(),
    uses: [/USING (COVERING INDEX \S+|PRIMARY KEY) \(node_id=\? AND entity_key=\?\)/],
  },
  entityFan: {
    sql: LINK_READS.entityFan(2),
    uses: [
      /SEARCH e USING (COVERING INDEX \S+|PRIMARY KEY) \(node_id=\? AND entity_key=\?\)/,
      /SEARCH m USING INTEGER PRIMARY KEY \(rowid=\?\)/,
    ],
  },
};

describe('link reads use their indexes (CON-149)', () => {
  it('link-plans.every-gather-and-bound-statement-is-an-index-range', async () => {
    const p = fresh();
    await (await openAt(p)).close();
    const db = new Database(p.dbPath, { readonly: true });
    try {
      // Every statement `neighbours` runs is named here: a new one must be added with its plan.
      expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(LINK_READS).sort());
      for (const [name, want] of Object.entries(EXPECTED)) {
        const steps = plan(db, want.sql);
        const table = reads(steps);
        expect(
          table.filter((d) => d.startsWith('SCAN ')),
          `${name}: ${steps.join(' | ')}`,
        ).toEqual([]);
        for (const re of want.uses) {
          expect(
            table.some((d) => re.test(d)),
            `${name} should match ${re}: ${steps.join(' | ')}`,
          ).toBe(true);
        }
        expect(table, `${name}: ${steps.join(' | ')}`).toHaveLength(want.uses.length);
      }
      // The session's turns are found inside one node: the node's columns lead the index, so rows
      // another node wrote under the same session id are not visited.
      const episode = reads(plan(db, LINK_READS.episodeNear(1)))[0]!;
      expect(episode.indexOf('level=?')).toBeLessThan(episode.indexOf('session_id=?'));
    } finally {
      db.close();
    }
  });

  it('link-plans.the-write-path-finds-a-session-inside-its-node', async () => {
    // `turnSeq` and `nextSeq` (the episode position of a new memory) use the same index.
    const p = fresh();
    await (await openAt(p)).close();
    const db = new Database(p.dbPath, { readonly: true });
    try {
      const steps = plan(
        db,
        `SELECT coalesce(max(episode_seq), 0) + 1 AS seq FROM memories
         WHERE session_id = @session AND rid != @rid
           AND level = @level AND org_id = @org AND customer_id IS @customer AND agent_id IS @agent
           AND hive_id IS @hive AND run_id IS @run`,
      );
      expect(steps.join(' | ')).toMatch(/memories_episode \(level=\?.*session_id=\?/);
    } finally {
      db.close();
    }
  });

  it('link-plans.a-store-from-an-earlier-build-gets-its-indexes-replaced-once', async () => {
    const p = fresh();
    await (await openAt(p)).close();
    const definitions = (): Record<string, string> => {
      const db = new Database(p.dbPath, { readonly: true });
      try {
        const rows = db
          .prepare(
            `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL
               AND (name LIKE 'memory_links_%' OR name = 'memories_episode')`,
          )
          .all() as { name: string; sql: string }[];
        return Object.fromEntries(rows.map((r) => [r.name, r.sql]));
      } finally {
        db.close();
      }
    };
    const current = definitions();
    expect(current).toEqual(Object.fromEntries(LINK_INDEXES.map((i) => [i.name, i.sql])));
    // The indexes as the first build of schema version 8 created them.
    const raw = new Database(p.dbPath);
    raw.exec(`
      DROP INDEX memories_episode; DROP INDEX memory_links_a; DROP INDEX memory_links_b;
      DROP INDEX memory_links_by;
      CREATE INDEX memories_episode ON memories (session_id, episode_seq);
      CREATE INDEX memory_links_a ON memory_links (a_rid);
      CREATE INDEX memory_links_b ON memory_links (b_rid, kind);
    `);
    // With them, the explicit read from the `b` end walked every explicit link in the store
    // (the key's `kind` prefix), and a session was found across every node.
    const old = reads(plan(raw, LINK_READS.explicitEnds(1))).join(' | ');
    expect(old).not.toMatch(/memory_links_b \(b_rid=\? AND kind=\? AND asserted_by=\?\)/);
    expect(reads(plan(raw, LINK_READS.episodeNear(1))).join(' | ')).not.toMatch(/level=\?/);
    raw.close();
    // An open that may not migrate (a hook) refuses, changing nothing.
    await expect(openAt(p, { migrate: false })).rejects.toBeInstanceOf(StoreMigrationRequiredError);
    expect(definitions()).not.toEqual(current);
    // The next ordinary open replaces them, and the one after changes nothing.
    await (await openAt(p)).close();
    expect(definitions()).toEqual(current);
    const before = fs.statSync(p.dbPath).mtimeMs;
    await (await openAt(p, { migrate: false })).close();
    await (await openAt(p)).close();
    expect(definitions()).toEqual(current);
    expect(fs.statSync(p.dbPath).mtimeMs).toBe(before);
  });
});

describe('a store with nothing to follow reads nothing (CON-149)', () => {
  const USER = { assertedBy: 'user' } as const;
  const AGENT = { assertedBy: 'agent' } as const;
  const scores: Record<string, number> = { A: 0.9, C: 0.5, B: 0.6 };
  const rerank: Reranker = {
    rerank: async (_q, docs, topK) =>
      docs
        .map((d) => ({ id: d.id, score: scores[d.id] ?? 0 }))
        .sort((x, y) => y.score - x.score)
        .slice(0, topK),
  };
  const dir = fs.mkdtempSync(path.join(root, 'home-'));
  const base = resolveConfig(dir, { OORT_HOME: dir }, { projectConfig: false });
  const config = { ...base, recall: { ...base.recall, skipRerankWhenConfident: false } };
  const seeded = async (stats: LinkStats[]) => {
    const p = fresh();
    const store = await openAt(p, { onLinkStats: (s) => stats.push({ ...s }) });
    await store.upsertMany(TG, [
      makeMemory({ id: 'A', text: 'auth-service moved to port 8080', entities: ['auth-service'] }),
      makeMemory({ id: 'C', text: 'the auth-service port was 3000', entities: ['auth-service'] }),
      makeMemory({ id: 'B', text: 'it runs on Postgres 16', stub: 'storage engine' }),
    ]);
    return { p, store };
  };
  const ask = (store: MemoryStore) =>
    recall(
      {
        text: 'which port does auth-service use',
        scope: { orgId: 'local', customerId: 'self', agentId: 'claude-code', projectIds: [null] },
      },
      { store, config, rerank },
    );

  it('link-plans.the-default-recall-runs-no-link-statement-without-a-user-link', async () => {
    const stats: LinkStats[] = [];
    const { p, store } = await seeded(stats);
    // Links an agent wrote do not count: the default follows none of them.
    await store.link!(TG, 'A', 'B', AGENT);
    const first = await ask(store);
    expect(first.memories.map((m) => m.id)).toEqual(['A', 'C']);
    // One existence probe, then its cached answer: no statement at all on later recalls.
    expect(stats).toEqual([{ reads: 0, checks: 1 }]);
    await ask(store);
    await ask(store);
    expect(stats.slice(1)).toEqual([
      { reads: 0, checks: 0 },
      { reads: 0, checks: 0 },
    ]);
    // A link confirmed at a terminal, written through this handle, is followed at once.
    await store.link!(TG, 'A', 'B', USER);
    const linked = await ask(store);
    expect(linked.memories.map((m) => m.id)).toEqual(['A', 'B', 'C']);
    expect(stats.at(-1)!.reads).toBeGreaterThan(0);
    await store.unlink!(TG, 'A', 'B', USER);
    expect((await ask(store)).memories.map((m) => m.id)).toEqual(['A', 'C']);
    expect(stats.at(-1)).toEqual({ reads: 0, checks: 1 });
    await store.close();
    void p;
  });

  it('link-plans.a-link-another-process-writes-is-seen', async () => {
    const stats: LinkStats[] = [];
    const { p, store } = await seeded(stats);
    await ask(store);
    await ask(store);
    expect(stats.at(-1)).toEqual({ reads: 0, checks: 0 });
    // Another connection (`oort link` in a terminal while a daemon holds this one).
    const other = await openAt(p);
    await other.link!(TG, 'A', 'B', USER);
    await other.close();
    const r = await ask(store);
    expect(r.memories.map((m) => m.id)).toEqual(['A', 'B', 'C']);
    expect(stats.at(-1)!.checks).toBe(1);
    await store.close();
  });

  it('link-plans.rows-in-another-node-under-the-same-session-are-not-read', async () => {
    // Another node floods a session id this reader also uses. The reader's episode read returns
    // only its own node's turns and is not skipped; its plan (above) never visits the others.
    const stats: LinkStats[] = [];
    const p = fresh();
    const store = await openAt(p, { onLinkStats: (s) => stats.push({ ...s }) });
    const src = (turnRef: string) => ({ harness: 'test', sessionId: 's1', turnRef, decisions: [] });
    await store.upsertMany(TG, [
      makeMemory({ id: 'a', source: src('t1') }),
      makeMemory({ id: 'b', source: src('t2') }),
    ]);
    const star = { level: 'agent' as const, orgId: 'local', agentId: 'another-agent' };
    const theirs = nodesGrant(star);
    await store.upsertMany(
      theirs,
      Array.from({ length: 600 }, (_, i) =>
        memoryAt(`x${i}`, star, { agentId: 'another-agent' }, { source: src(i % 2 ? 't1' : 't2') }),
      ),
    );
    const r = await store.neighbours!(TG, ['a'], { kinds: ['episode'] });
    expect(r).toEqual({
      neighbours: [{ id: 'b', kind: 'episode', from: 'a', weight: Math.exp(-1 / 3) }],
    });
    // The seed's row, the bound's count, the read, and one block probe for the one candidate.
    expect(stats.at(-1)).toEqual({ reads: 4, checks: 0 });
    await store.close();
  });
});
