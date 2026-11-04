import type { Embedder } from './adapters.js';

/**
 * A cache of query embeddings (CON-57). Keys are SHA-256 hashes, so a cache never holds the
 * query text. Implementations may be in memory (an MCP server, the cloud) or on disk (the hooks,
 * which are a new process per prompt).
 */
export interface EmbeddingCache {
  get(key: string): Promise<Int8Array | undefined>;
  set(key: string, vector: Int8Array): Promise<void>;
}

/** The text a cache key is built from: lower case, whitespace collapsed, trimmed. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** SHA-256 (hex) of model, dimension and the normalised query text. */
export async function queryCacheKey(
  model: string,
  dimension: number,
  text: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${model}\u0000${dimension}\u0000${normalise(text)}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** An in-process LRU with a time to live. Defaults: 256 entries, 10 minutes. */
export function memoryEmbeddingCache(
  opts: { max?: number; ttlMs?: number; now?: () => number } = {},
): EmbeddingCache {
  const max = opts.max ?? 256;
  const ttlMs = opts.ttlMs ?? 600_000;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { v: Int8Array; exp: number }>();
  return {
    async get(key) {
      const e = entries.get(key);
      if (e === undefined) return undefined;
      if (e.exp <= now()) {
        entries.delete(key);
        return undefined;
      }
      // Refresh recency: re-insert at the end of the Map's insertion order.
      entries.delete(key);
      entries.set(key, e);
      return e.v;
    },
    async set(key, v) {
      entries.delete(key);
      entries.set(key, { v: Int8Array.from(v), exp: now() + ttlMs });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

/**
 * Wraps an embedder so a single-text `query` embed is served from `cache` when it can be.
 * Documents and batches always go to the embedder. A failing cache is ignored: embedding never
 * fails because of it.
 */
export function cachingEmbedder(
  inner: Embedder,
  cache: EmbeddingCache,
  id: { model: string; dimension: number },
): Embedder {
  return {
    dimension: inner.dimension,
    async embed(texts, kind) {
      const only = texts.length === 1 ? texts[0] : undefined;
      if (kind !== 'query' || only === undefined) return inner.embed(texts, kind);
      const key = await queryCacheKey(id.model, id.dimension, only);
      const hit = await cache.get(key).catch(() => undefined);
      if (hit !== undefined) return [Int8Array.from(hit)];
      const out = await inner.embed(texts, kind);
      const v = out[0];
      if (v !== undefined) await cache.set(key, v).catch(() => {});
      return out;
    },
  };
}

/** Two caches in order: a fast one in front of a slower shared one (memory in front of disk). */
export function layeredEmbeddingCache(front: EmbeddingCache, back: EmbeddingCache): EmbeddingCache {
  return {
    async get(key) {
      const f = await front.get(key).catch(() => undefined);
      if (f !== undefined) return f;
      const b = await back.get(key).catch(() => undefined);
      if (b !== undefined) await front.set(key, b).catch(() => {});
      return b;
    },
    async set(key, v) {
      await Promise.all([front.set(key, v).catch(() => {}), back.set(key, v).catch(() => {})]);
    },
  };
}
