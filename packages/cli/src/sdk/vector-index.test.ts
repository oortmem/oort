/** `config.store.vectorIndex` (CON-17): the SDK's local store builds the binary index when asked. */
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
    const open = (vectorIndex: 'binary' | 'int8') =>
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
  });
});
