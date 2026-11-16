/**
 * Judging predictions in the SQLite store: `predictionsConformance`, records that survive a
 * reopen, and a forgotten or purged prediction whose text is gone from the file.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { purgedPrediction } from '@oortmem/core';
import {
  CONFORMANCE_DIMENSION,
  makePrediction,
  predictionsConformance,
  TG,
} from '@oortmem/core/store-conformance';
import { openSqliteStore } from './index.js';
import { PREDICTION_TABLE, SCHEMA_VERSION } from './schema.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-store-predictions-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function optsIn(dir: string) {
  return {
    path: path.join(dir, 'oort.sqlite'),
    coldDir: path.join(dir, 'cold'),
    dimension: CONFORMANCE_DIMENSION,
  };
}

const fresh = () => fs.mkdtempSync(path.join(root, 'case-'));

predictionsConformance('sqlite', () => openSqliteStore(optsIn(fresh())));

/** Every byte the store keeps on disk: the database and its WAL. */
function fileBytes(dbPath: string): Buffer {
  const parts = [dbPath, `${dbPath}-wal`].filter((p) => fs.existsSync(p));
  return Buffer.concat(parts.map((p) => fs.readFileSync(p)));
}

describe('sqlite predictions', () => {
  it('predictions.survive-a-reopen-without-a-schema-change', async () => {
    const dir = fresh();
    const s1 = await openSqliteStore(optsIn(dir));
    await s1.putPrediction!(TG, makePrediction({ id: 'p1' }));
    await s1.close();
    const db = new Database(optsIn(dir).path, { readonly: true });
    const version = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    const n = db.prepare(`SELECT count(*) AS n FROM ${PREDICTION_TABLE}`).get() as { n: number };
    db.close();
    expect(version.value).toBe(String(SCHEMA_VERSION));
    expect(n.n).toBe(1);
    const s2 = await openSqliteStore(optsIn(dir));
    expect((await s2.getPrediction!(TG, 'p1'))?.verdict).toBe('rejected');
    await s2.close();
  });

  it('predictions.forget-and-purge-leave-no-text-in-the-file', async () => {
    const dir = fresh();
    const s = await openSqliteStore(optsIn(dir));
    const forgotten = 'zanzibarquokkaforgotten';
    const purged = 'kilimanjaroquollpurged';
    await s.putPrediction!(TG, makePrediction({ id: 'p1', item: { summary: forgotten } }));
    const p2 = makePrediction({
      id: 'p2',
      createdAt: '2026-11-16T11:00:00.000Z',
      item: { summary: purged, details: purged },
    });
    await s.putPrediction!(TG, p2);
    await s.close();
    expect(fileBytes(optsIn(dir).path).includes(forgotten)).toBe(true);

    const s2 = await openSqliteStore(optsIn(dir));
    expect(await s2.forgetPrediction!(TG, 'p1')).toBe(true);
    const stub = purgedPrediction(p2, 'ada', new Date('2026-11-16T12:00:00Z'));
    expect(await s2.putPrediction!(TG, stub, { revision: p2.revision })).toBe(true);
    await s2.close();
    const bytes = fileBytes(optsIn(dir).path);
    expect(bytes.includes(forgotten)).toBe(false);
    expect(bytes.includes(purged)).toBe(false);
  });
});
