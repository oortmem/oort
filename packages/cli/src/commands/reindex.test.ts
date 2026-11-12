/** `oort reindex` (CON-25): recentres the RaBitQ index on request, never on its own. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '@oortmem/core';
import { TG, makeMemory } from '@oortmem/core/store-conformance';
import { openSqliteStore, sqliteVectorIndex } from '@oortmem/store-sqlite';
import { harness } from '../../test/helpers.js';

const generation = (db: string): unknown => {
  const c = new Database(db, { readonly: true });
  try {
    return (
      c.prepare("SELECT value FROM memories_rq_meta WHERE key = 'generation'").get() as
        { value: unknown } | undefined
    )?.value;
  } finally {
    c.close();
  }
};

describe('oort reindex', () => {
  it('reindex.recentres-the-rabitq-index-and-leaves-other-indexes-alone', async () => {
    const h = harness();
    fs.mkdirSync(h.home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(h.home, 'config.json'),
      JSON.stringify({ store: { vectorIndex: 'rabitq' } }),
    );
    const { embed } = resolveConfig(h.cwd, { OORT_HOME: h.home }, { projectConfig: false });
    const db = path.join(h.home, 'oort.sqlite');
    const s = await openSqliteStore({
      path: db,
      coldDir: path.join(h.home, 'cold'),
      dimension: embed.dimension,
      vectorIndex: 'rabitq',
      log: () => {},
    });
    let seed = 7;
    const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 255) - 127;
    await s.upsertMany(
      TG,
      Array.from({ length: 1000 }, (_, i) =>
        makeMemory({ id: `r${i}`, embedding: Int8Array.from({ length: embed.dimension }, next) }),
      ),
    );
    await s.close();
    expect(sqliteVectorIndex(db)?.recentreDue).toBe(true);
    const before = generation(db);
    const r = await h.run(['reindex']);
    expect(r.code).toBe(0);
    expect(r.io.stdout).toContain('Rebuilt the RaBitQ vector index (1000 vectors)');
    expect(generation(db)).not.toBe(before);
    expect(sqliteVectorIndex(db)).toEqual({ index: 'rabitq', vectors: 1000 });
    // JSON, and a store without a RaBitQ index: nothing to do.
    fs.writeFileSync(
      path.join(h.home, 'config.json'),
      JSON.stringify({ store: { vectorIndex: 'int8' } }),
    );
    const j = await h.run(['reindex', '--json']);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.io.stdout).data).toMatchObject({
      index: 'int8',
      rebuilt: false,
    });
  });
});
