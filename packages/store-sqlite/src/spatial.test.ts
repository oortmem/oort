/**
 * The SQLite store's spatial seam (CON-84, PR #102 review): filters reach SQL only as bound
 * values, `k` is taken after the filter, scope still applies, the R*Tree follows the rows (and is
 * rebuilt from them when missing), and a damaged stored place never breaks a recall.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import {
  localGrant,
  type Memory,
  type MemoryStore,
  type ScopeFilter,
  type SpatialFilter,
} from '@oortmem/core';
import { CONFORMANCE_DIMENSION, makeMemory, TG, vec } from '@oortmem/core/store-conformance';
import { openSqliteStore } from './index.js';
import { defineWriterGuard } from './schema.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-sqlite-spatial-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fresh(): { path: string; coldDir: string; dimension: number } {
  const d = fs.mkdtempSync(path.join(root, 'c-'));
  return {
    path: path.join(d, 'oort.sqlite'),
    coldDir: path.join(d, 'cold'),
    dimension: CONFORMANCE_DIMENSION,
  };
}

const LOCAL: ScopeFilter = {
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
};
const G = () => localGrant(LOCAL);
const E = vec(10, 10, 10, 10);
const ids = (hs: { id: string }[]) => hs.map((h) => h.id).sort();
const both = async (s: MemoryStore, f: SpatialFilter, k = 50) => [
  ids(await s.lexical(G(), 'toolbox', k, { spatial: f })),
  ids(await s.dense(G(), E, k, { spatial: f })),
];
const toolbox = (id: string, place: Memory['place'], extra: Partial<Memory> = {}): Memory =>
  makeMemory({ id, text: 'toolbox', stub: 'toolbox', embedding: E, place, ...extra });
const near = (x: number, y: number, radius: number): SpatialFilter => ({
  near: { mapId: 'hq', pose: { x, y }, radius },
});

function rawExec(file: string, sql: string): void {
  const db = new Database(file);
  try {
    defineWriterGuard(db); // a connection that writes `memories` passes the version 6 guard
    db.exec(sql);
  } finally {
    db.close();
  }
}

describe('sqlite spatial seam', () => {
  it('spatial.within-strings-are-bound-never-sql-or-like-patterns', async () => {
    const s = await openSqliteStore(fresh());
    await s.upsert(TG, toolbox('a', { nodeId: 'site:hq/room:B' }));
    for (const w of ["') OR 1=1 --", "'; DROP TABLE memories; --", '%', '_', 'room:%', '', '/']) {
      expect(await both(s, { within: w })).toEqual([[], []]);
    }
    expect(await both(s, { within: 'room:B' })).toEqual([['a'], ['a']]);
    expect(await s.list(TG)).toHaveLength(1);
    await s.close();
  });

  it('spatial.unchecked-near-values-at-the-seam-match-nothing', async () => {
    const s = await openSqliteStore(fresh());
    await s.upsert(TG, toolbox('a', { mapId: 'hq', pose: { x: 0, y: 0 } }));
    for (const n of [
      { mapId: 'hq', pose: { x: NaN, y: 0 }, radius: 1 },
      { mapId: 'hq', pose: { x: 0, y: 0 }, radius: NaN },
      { mapId: 'hq', pose: { x: 0, y: 0 }, radius: -1 },
      { mapId: "hq') --", pose: { x: 0, y: 0 }, radius: 1 },
    ]) {
      expect(await both(s, { near: n })).toEqual([[], []]);
    }
    await s.close();
  });

  it('spatial.k-is-taken-after-the-filter-with-hundreds-of-better-matches-outside', async () => {
    const s = await openSqliteStore(fresh());
    const outside: Memory[] = [];
    for (let i = 0; i < 400; i++) {
      outside.push(
        toolbox(
          `o${i}`,
          { nodeId: 'room:A', mapId: 'hq', pose: { x: 100 + i, y: 0 } },
          {
            text: 'toolbox toolbox',
          },
        ),
      );
    }
    await s.upsertMany(TG, outside);
    await s.upsert(
      TG,
      toolbox(
        'in',
        { nodeId: 'room:B', mapId: 'hq', pose: { x: 0, y: 0 } },
        {
          text: 'a toolbox among other words',
          embedding: vec(10, -10, 10, -10),
        },
      ),
    );
    expect(await both(s, { within: 'room:B' }, 5)).toEqual([['in'], ['in']]);
    expect(await both(s, near(0, 0, 1), 5)).toEqual([['in'], ['in']]);
    await s.close();
  });

  it('spatial.another-end-user-at-the-same-place-never-shows-up', async () => {
    const s = await openSqliteStore(fresh());
    const place = { nodeId: 'room:B', mapId: 'hq', pose: { x: 0, y: 0 } };
    await s.upsert(TG, toolbox('mine', place));
    const bobScope = { orgId: 'local', customerId: 'bob', agentId: 'claude-code' };
    await s.upsert(
      localGrant({ ...bobScope, projectIds: [null] }),
      toolbox('bobs', place, { scope: bobScope }),
    );
    expect(await both(s, { within: 'room:B' })).toEqual([['mine'], ['mine']]);
    expect(await both(s, near(0, 0, 1))).toEqual([['mine'], ['mine']]);
    await s.close();
  });

  it('spatial.forget-removes-the-spatial-index-row', async () => {
    const o = fresh();
    const s = await openSqliteStore(o);
    await s.upsert(TG, toolbox('a', { mapId: 'hq', pose: { x: 0, y: 0 } }));
    await s.forget(TG, 'a');
    await s.close();
    const db = new Database(o.path, { readonly: true });
    expect((db.prepare('SELECT COUNT(*) AS n FROM memories_place').get() as { n: number }).n).toBe(
      0,
    );
    db.close();
  });

  it('spatial.a-damaged-stored-place-is-not-near-anything-and-breaks-no-recall', async () => {
    const o = fresh();
    const s = await openSqliteStore(o);
    await s.upsert(TG, toolbox('bad', { mapId: 'hq', pose: { x: 0, y: 0 } }));
    await s.upsert(TG, toolbox('good', { mapId: 'hq', pose: { x: 0.5, y: 0 } }));
    await s.close();
    rawExec(o.path, "UPDATE memories SET place = '{not json' WHERE id = 'bad'");
    const s2 = await openSqliteStore(o);
    expect(await both(s2, near(0, 0, 1))).toEqual([['good'], ['good']]);
    await s2.close();
  });

  it('spatial.a-tampered-place-with-its-index-row-left-breaks-no-recall', async () => {
    // The R*Tree row stays, so `near` reaches the stored JSON: a place that parses but does not
    // check (a null pose or extent) is near nothing, on the lexical and the dense path alike, and
    // reads back without its place, so nothing returns a place an import would refuse.
    const o = fresh();
    const s = await openSqliteStore(o);
    await s.upsert(TG, toolbox('good', { mapId: 'hq', pose: { x: 0.5, y: 0 } }));
    await s.upsert(TG, toolbox('null-pose', { mapId: 'hq', pose: { x: 0, y: 0 } }));
    await s.upsert(
      TG,
      toolbox('null-extent', { mapId: 'hq', pose: { x: 0, y: 0 }, extent: { radius: 1 } }),
    );
    await s.close();
    rawExec(
      o.path,
      [
        `UPDATE memories SET place = '{"mapId":"hq","pose":null}' WHERE id = 'null-pose';`,
        `UPDATE memories SET place = '{"mapId":"hq","pose":{"x":0,"y":0},"extent":null}'
           WHERE id = 'null-extent';`,
      ].join('\n'),
    );
    const s2 = await openSqliteStore(o);
    expect(await both(s2, near(0, 0, 1))).toEqual([['good'], ['good']]);
    for (const id of ['null-pose', 'null-extent']) {
      const m = await s2.get(TG, id);
      expect(m).not.toBeNull();
      expect(m!.place).toBeUndefined();
    }
    const listed = await s2.list(TG);
    expect(listed.find((m) => m.id === 'null-pose')?.place).toBeUndefined();
    expect(listed.find((m) => m.id === 'good')?.place).toEqual({
      mapId: 'hq',
      pose: { x: 0.5, y: 0 },
    });
    await s2.close();
  });

  it('spatial.a-missing-spatial-index-is-rebuilt-from-the-stored-places', async () => {
    const o = fresh();
    const s = await openSqliteStore(o);
    await s.upsert(TG, toolbox('a', { nodeId: 'room:B', mapId: 'hq', pose: { x: 0, y: 0 } }));
    await s.upsert(TG, toolbox('path-only', { nodeId: 'room:B' }));
    await s.close();
    rawExec(o.path, 'DROP TABLE memories_place');
    const logs: string[] = [];
    const s2 = await openSqliteStore({ ...o, log: (m) => logs.push(m) });
    expect(logs.filter((l) => l.includes('place check'))).toEqual([]);
    expect(await both(s2, near(0, 0, 1))).toEqual([['a'], ['a']]);
    expect(await both(s2, { within: 'room:B' })).toEqual([
      ['a', 'path-only'],
      ['a', 'path-only'],
    ]);
    await s2.close();
  });

  it('spatial.a-rebuilt-spatial-index-skips-stored-places-that-do-not-check', async () => {
    // A crafted or damaged database (say, a restored copy) whose index is missing: places that
    // parse but would never pass `checkPlace` are left out of the rebuild, as unparseable ones
    // are, instead of failing the open on an R*Tree constraint (a negative size gives min > max).
    const o = fresh();
    const s = await openSqliteStore(o);
    await s.upsert(TG, toolbox('good', { mapId: 'hq', pose: { x: 0, y: 0 } }));
    for (const id of ['negative-dx', 'odom', 'string-x', 'no-map', 'nan', 'unknown-field']) {
      await s.upsert(TG, toolbox(id, { mapId: 'hq', pose: { x: 0.5, y: 0 } }));
    }
    await s.close();
    const set = (id: string, place: string) =>
      `UPDATE memories SET place = '${place}' WHERE id = '${id}';`;
    rawExec(
      o.path,
      [
        set('negative-dx', '{"mapId":"hq","pose":{"x":0.5,"y":0},"extent":{"dx":-4,"dy":1}}'),
        set('odom', '{"mapId":"hq","frame":"odom","pose":{"x":0.5,"y":0}}'),
        set('string-x', '{"mapId":"hq","pose":{"x":"0.5","y":0}}'),
        set('no-map', '{"pose":{"x":0.5,"y":0}}'),
        set('nan', '{"mapId":"hq","pose":{"x":1e999,"y":0}}'),
        set('unknown-field', '{"mapId":"hq","pose":{"x":0.5,"y":0},"evil":1}'),
        'DROP TABLE memories_place;',
      ].join('\n'),
    );
    const logs: string[] = [];
    const s2 = await openSqliteStore({ ...o, log: (m) => logs.push(m) });
    expect(await both(s2, near(0, 0, 1))).toEqual([['good'], ['good']]);
    await s2.close();
    expect(logs).toContain(
      'sqlite store: 6 stored places failed the place check and are not searchable by near',
    );
    const db = new Database(o.path, { readonly: true });
    expect((db.prepare('SELECT COUNT(*) AS n FROM memories_place').get() as { n: number }).n).toBe(
      1,
    );
    db.close();
  });
});
