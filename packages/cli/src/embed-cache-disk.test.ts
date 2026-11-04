import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { queryCacheKey } from '@oortmem/core';
import { diskEmbeddingCache } from './embed-cache-disk.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'oort-qcache-'));

describe('disk query-embedding cache', () => {
  it('disk-cache.round-trips-across-instances-with-private-modes-and-no-text', async () => {
    const dir = path.join(tmp(), 'cache', 'query-embed');
    const key = await queryCacheKey('m', 4, 'the secret project name is quokka');
    await diskEmbeddingCache(dir, { ttlMs: 60_000 }).set(key, Int8Array.from([1, -2, 3, -4]));
    const back = await diskEmbeddingCache(dir, { ttlMs: 60_000 }).get(key);
    expect([...(back ?? [])]).toEqual([1, -2, 3, -4]);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const files = fs.readdirSync(dir);
    expect(files).toEqual([key]);
    expect(fs.statSync(path.join(dir, key)).mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(path.join(dir, key));
    expect(raw.toString('latin1')).not.toContain('quokka');
  });

  it('disk-cache.expired-entries-are-misses-and-removed', async () => {
    const dir = tmp();
    let now = 1_000;
    const c = diskEmbeddingCache(dir, { ttlMs: 500, now: () => now });
    const key = await queryCacheKey('m', 4, 'q');
    await c.set(key, Int8Array.from([5, 6, 7, 8]));
    now = 1_400;
    expect(await c.get(key)).toBeDefined();
    now = 1_600;
    expect(await c.get(key)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, key))).toBe(false);
  });

  it('disk-cache.ignores-keys-that-are-not-hashes-and-an-unwritable-dir', async () => {
    const dir = tmp();
    const c = diskEmbeddingCache(dir, { ttlMs: 1000 });
    await c.set('../escape', Int8Array.from([1]));
    expect(await c.get('../escape')).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
    const ro = diskEmbeddingCache('/dev/null/not-a-dir', { ttlMs: 1000 });
    const key = await queryCacheKey('m', 4, 'q');
    await expect(ro.set(key, Int8Array.from([1]))).resolves.toBeUndefined();
    expect(await ro.get(key)).toBeUndefined();
  });
});
