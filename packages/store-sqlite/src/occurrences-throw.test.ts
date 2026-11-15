/**
 * A memory whose text the event-time reader cannot read must not stop the store reaching
 * schema version 10: that one memory keeps only the day it was stored, and the rest are read.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { makeMemory, TG } from '@oortmem/core/store-conformance';

vi.mock('@oortmem/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@oortmem/core')>();
  return {
    ...real,
    occurrencesOf: (text: string, at: Date, offset?: number) => {
      if (text.includes('POISON')) throw new Error('reader failed');
      return real.occurrencesOf(text, at, offset);
    },
  };
});

const { downgradeSqliteStore, openSqliteStore, sqliteSchemaVersion } = await import('./index.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-occurred-throw-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it('occurred.a-text-the-reader-throws-on-does-not-stop-the-migration', async () => {
  const dbPath = path.join(root, 'oort.sqlite');
  const opts = { path: dbPath, coldDir: path.join(root, 'cold'), dimension: 4, log: () => {} };
  const at = '2023-05-22T10:00:00.000Z';
  const store = await openSqliteStore(opts);
  await store.upsertMany(TG, [
    makeMemory({
      id: 'bad',
      text: 'POISON last weekend',
      createdAt: at,
      validFrom: at,
      updatedAt: at,
    }),
    makeMemory({
      id: 'good',
      text: 'I went hiking last weekend.',
      createdAt: at,
      validFrom: at,
      updatedAt: at,
    }),
  ]);
  await store.close();
  downgradeSqliteStore({ path: dbPath, to: 9 });
  const again = await openSqliteStore(opts);
  try {
    expect(sqliteSchemaVersion(dbPath)).toBe(10);
    expect((await again.get(TG, 'bad'))?.occurred).toEqual([
      {
        from: '2023-05-22T00:00:00.000Z',
        to: '2023-05-23T00:00:00.000Z',
        precision: 'day',
        source: 'mention',
      },
    ]);
    expect((await again.get(TG, 'good'))?.occurred?.[0]).toMatchObject({ source: 'relative' });
  } finally {
    await again.close();
  }
});
