import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Embedder } from '@oortmem/core';

/** What a caching embedder sent to the embedder it wraps. */
export interface EmbedUsage {
  /** Calls to the wrapped embedder (one per batch). */
  requests: number;
  texts: number;
  chars: number;
  /** Texts answered from the cache. */
  hits: number;
}

export interface CachingEmbedder extends Embedder {
  /** Embeds every text not yet cached, in batches of `batch`. */
  prefetch(texts: string[], kind: 'document' | 'query', batch?: number): Promise<void>;
  usage(): EmbedUsage;
  /** True when `text` is cached for `kind`. */
  has(text: string, kind: 'document' | 'query'): boolean;
  close(): void;
}

/**
 * Wraps an embedder with a cache keyed by the model name, the kind and the text, kept in memory
 * and, with `file`, in a SQLite file, so a second run (links on, after links off) embeds nothing
 * again. `prefetch` sends uncached texts in batches; a later `embed` of the same text is a hit.
 */
export function cachingEmbedder(
  base: Embedder,
  opts: { model: string; file?: string },
): CachingEmbedder {
  const mem = new Map<string, Int8Array>();
  let db: Database.Database | undefined;
  if (opts.file !== undefined) {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    db = new Database(opts.file);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS e (k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID');
  }
  const getStmt = db?.prepare<[string], { v: Buffer }>('SELECT v FROM e WHERE k = ?');
  const putStmt = db?.prepare<[string, Buffer]>('INSERT OR REPLACE INTO e (k, v) VALUES (?, ?)');
  const usage: EmbedUsage = { requests: 0, texts: 0, chars: 0, hits: 0 };
  const key = (text: string, kind: string): string =>
    createHash('sha256').update(`${opts.model}\0${kind}\0${text}`).digest('hex');
  const lookup = (k: string): Int8Array | undefined => {
    const hit = mem.get(k);
    if (hit !== undefined) return hit;
    const row = getStmt?.get(k);
    if (row === undefined) return undefined;
    const v = new Int8Array(row.v.buffer, row.v.byteOffset, row.v.byteLength).slice();
    mem.set(k, v);
    return v;
  };
  const send = async (texts: string[], kind: 'document' | 'query'): Promise<Int8Array[]> => {
    usage.requests++;
    usage.texts += texts.length;
    usage.chars += texts.reduce((n, t) => n + t.length, 0);
    const vecs = await base.embed(texts, kind);
    const save = db?.transaction((rows: [string, Int8Array][]) => {
      for (const [k, v] of rows) putStmt?.run(k, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    });
    const rows = texts.map((t, i) => [key(t, kind), vecs[i] as Int8Array] as [string, Int8Array]);
    for (const [k, v] of rows) mem.set(k, v);
    save?.(rows);
    return vecs;
  };
  return {
    dimension: base.dimension,
    async embed(texts, kind) {
      const out: (Int8Array | undefined)[] = texts.map((t) => lookup(key(t, kind)));
      const missing = texts.filter((_, i) => out[i] === undefined);
      usage.hits += texts.length - missing.length;
      if (missing.length > 0) {
        const vecs = await send(missing, kind);
        let j = 0;
        for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = vecs[j++];
      }
      return out as Int8Array[];
    },
    async prefetch(texts, kind, batch = 128) {
      const todo = [...new Set(texts)].filter((t) => lookup(key(t, kind)) === undefined);
      for (let i = 0; i < todo.length; i += batch) await send(todo.slice(i, i + batch), kind);
    },
    usage: () => ({ ...usage }),
    has: (text, kind) => lookup(key(text, kind)) !== undefined,
    close: () => db?.close(),
  };
}
