/**
 * `config.store.vectorIndex`: the SDK's local store builds the binary index (CON-17) or the
 * RaBitQ index (CON-25) when asked.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sqliteVectorIndex } from '@oortmem/store-sqlite';
import { tmpdir } from '../../test/helpers.js';
import { fakeAdapters } from '../../test/helpers/sdk-fakes.js';
import { createOortWith } from './create.js';

const NOW = new Date('2026-11-06T12:00:00.000Z');

describe('store.vectorIndex', () => {
  it('sdk.binary-vector-index-is-built-and-searched', async () => {
    const root = tmpdir('oort-sdk-vec-');
    const home = path.join(root, 'home');
    const env = { HOME: root, OORT_NO_KEYCHAIN: '1' };
    const open = (vectorIndex: 'binary' | 'int8' | 'rabitq') =>
      createOortWith(
        { mode: 'local', home, env, project: null, config: { store: { vectorIndex } } },
        { adapters: fakeAdapters(), now: () => NOW },
      );
    const first = await open('binary');
    const saved = await first.remember('We deploy the billing service on Fridays.');
    const id = saved.results[0]!.id!;
    await first.close();
    // Built when the store opened, and kept in step by every write since.
    const second = await open('binary');
    expect(sqliteVectorIndex(path.join(home, 'oort.sqlite'))).toEqual({
      index: 'binary',
      vectors: 1,
    });
    expect((await second.recall('when do we deploy billing?')).memories.map((m) => m.id)).toContain(
      id,
    );
    await second.close();
    await (await open('int8')).close();
    expect(sqliteVectorIndex(path.join(home, 'oort.sqlite'))?.index).toBe('int8');
    // The RaBitQ index: built from the int8 vectors, searched by recall, kept by every write.
    const third = await open('rabitq');
    expect(sqliteVectorIndex(path.join(home, 'oort.sqlite'))).toEqual({
      index: 'rabitq',
      vectors: 1,
    });
    const more = await third.remember('The billing service runs on three nodes.');
    expect((await third.recall('when do we deploy billing?')).memories.map((m) => m.id)).toContain(
      id,
    );
    expect(sqliteVectorIndex(path.join(home, 'oort.sqlite'))?.vectors).toBe(
      1 + more.results.filter((r) => r.id !== undefined).length,
    );
    await third.forget(id);
    expect((await third.recall('when do we deploy billing?')).memories.map((m) => m.id)).not.toContain(
      id,
    );
    await third.close();
  });
});
