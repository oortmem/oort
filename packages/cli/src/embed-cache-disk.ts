import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EmbeddingCache } from '@oortmem/core';

/**
 * Query embeddings on disk, so each hook process (one per prompt) can reuse the last few
 * minutes of embeddings (CON-57). One file per key under `dir`: the file name is the SHA-256 key
 * and the content is an 8-byte expiry (ms, big-endian) followed by the int8 vector. No query text
 * is ever written. The directory is 0700 and files are 0600. Every error is swallowed: the cache
 * is an optimisation, never a reason to fail.
 */
export function diskEmbeddingCache(
  dir: string,
  opts: { ttlMs: number; maxEntries?: number; now?: () => number },
): EmbeddingCache {
  const now = opts.now ?? Date.now;
  const maxEntries = opts.maxEntries ?? 500;
  const KEY = /^[0-9a-f]{64}$/;
  const file = (key: string): string | undefined =>
    KEY.test(key) ? path.join(dir, key) : undefined;

  const prune = (): void => {
    const names = fs.readdirSync(dir).filter((n) => KEY.test(n));
    const t = now();
    const live: { name: string; mtime: number }[] = [];
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        const buf = fs.readFileSync(p);
        if (buf.length < 8 || Number(buf.readBigUInt64BE(0)) <= t) fs.rmSync(p, { force: true });
        else live.push({ name, mtime: fs.statSync(p).mtimeMs });
      } catch {
        // A file another process is writing or removing: skip it.
      }
    }
    if (live.length <= maxEntries) return;
    live.sort((a, b) => a.mtime - b.mtime);
    for (const { name } of live.slice(0, live.length - maxEntries)) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  };

  return {
    async get(key) {
      const p = file(key);
      if (p === undefined) return undefined;
      try {
        const buf = fs.readFileSync(p);
        if (buf.length < 8) return undefined;
        if (Number(buf.readBigUInt64BE(0)) <= now()) {
          fs.rmSync(p, { force: true });
          return undefined;
        }
        return new Int8Array(buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + buf.length));
      } catch {
        return undefined;
      }
    },
    async set(key, vector) {
      const p = file(key);
      if (p === undefined) return;
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const buf = Buffer.alloc(8 + vector.length);
        buf.writeBigUInt64BE(BigInt(Math.floor(now() + opts.ttlMs)), 0);
        Buffer.from(vector.buffer, vector.byteOffset, vector.length).copy(buf, 8);
        // Write then rename, so a reader never sees a half-written vector.
        const tmp = `${p}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, buf, { mode: 0o600 });
        fs.renameSync(tmp, p);
        // Prune now and then, not on every write.
        if (Math.random() < 0.05) prune();
      } catch {
        // Unwritable home or a full disk: carry on without the cache.
      }
    },
  };
}
