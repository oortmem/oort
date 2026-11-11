import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { binaryCode } from './binary.js';
import { openBlobDir, withCleanupFailures } from './blobs.js';
import { createColdCodec } from './cold.js';
import { BIT_TABLE, hasBinaryIndex } from './schema.js';

/**
 * Which embedding model a store's vectors come from. Vectors from two models live in unrelated
 * spaces even at the same dimension (Voyage int8 and a local model padded to 512), so a store is
 * bound to one embedder: the binding is recorded in the store's `meta` table, next to its
 * dimension, and `reembedSqliteStore` moves a store to another model.
 */

const KEY = 'embed_model';

export interface EmbedderBinding {
  /** The recorded model (`voyage/voyage-3.5-lite`, `local/bge-small-en-v1.5`), or null. */
  model: string | null;
  /** Whether the store holds any memory (a store with none can be bound to anything). */
  hasMemories: boolean;
}

/**
 * Reads the binding through a short read-only connection (about a millisecond). Null model and
 * false for a store file that does not exist or has no schema yet.
 */
export function readEmbedderBinding(dbPath: string): EmbedderBinding {
  if (!fs.existsSync(dbPath)) return { model: null, hasMemories: false };
  const db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
  try {
    const has = (name: string): boolean =>
      db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined;
    if (!has('meta') || !has('memories')) return { model: null, hasMemories: false };
    const row = db
      .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
      .get(KEY);
    const any = db.prepare('SELECT 1 FROM memories LIMIT 1').get() !== undefined;
    return { model: row?.value ?? null, hasMemories: any };
  } finally {
    db.close();
  }
}

/** Records `model` as the store's embedder. The store must already be open once (schema applied). */
export function writeEmbedderBinding(dbPath: string, model: string, busyTimeoutMs = 5000): void {
  const db = new Database(path.resolve(dbPath), { fileMustExist: true });
  try {
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(KEY, model);
  } finally {
    db.close();
  }
}

export interface ReembedOptions {
  /** The SQLite database file (opened once before, so its schema is current). */
  path: string;
  coldDir: string;
  /** The store's dimension; every new vector must have it. */
  dimension: number;
  /** The model the new vectors come from; recorded as the binding when every vector is done. */
  model: string;
  /** Document embeddings for `texts`, in order. */
  embed(texts: string[]): Promise<Int8Array[]>;
  /** Texts per `embed` call (default 32). */
  batchSize?: number;
  onProgress?(p: { done: number; total: number }): void;
  log?(message: string): void;
}

export interface ReembedResult {
  /** Live (hot and warm) memories whose vector was replaced. */
  live: number;
  /** Cold copies whose stored vector was replaced. */
  cold: number;
  /** Live memories without a vector (written lexical-only); left as they are. */
  withoutVector: number;
}

const toBytes = (v: Int8Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/**
 * Replaces every vector in the store with one from `embed`: the vec row of each live memory
 * (by id, so the vector index keeps its partition columns), and the embedding inside each cold
 * copy (a new blob, swapped in under the index, the old one removed after commit), so hydrating
 * a cold memory later cannot bring an old-model vector back. Each batch commits on its own and
 * the binding is written last: an interrupted run leaves the old binding, and running it again
 * redoes the work. Memory text, metadata and access logs are not touched.
 */
export async function reembedSqliteStore(opts: ReembedOptions): Promise<ReembedResult> {
  const { dimension } = opts;
  const batchSize = opts.batchSize ?? 32;
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const db = new Database(path.resolve(opts.path), { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    sqliteVec.load(db);
    const blobs = openBlobDir(path.resolve(opts.coldDir), log);
    const codec = createColdCodec({ dimension });
    const check = (vs: Int8Array[], n: number): void => {
      if (vs.length !== n)
        throw new Error(`reembed: embedder returned ${vs.length} vectors for ${n} texts`);
      for (const v of vs) {
        if (v.length !== dimension) {
          throw new RangeError(
            `reembed: vector has ${v.length} dimensions, store dimension is ${dimension}`,
          );
        }
      }
    };

    const live = db
      .prepare<[], { id: string; text: string }>(
        `SELECT m.id AS id, m.text AS text FROM memories m
         WHERE m.tier != 'cold' AND EXISTS (SELECT 1 FROM memories_vec v WHERE v.id = m.id)
         ORDER BY m.rid`,
      )
      .all();
    const withoutVector =
      db
        .prepare<[], { n: number }>(
          `SELECT count(*) AS n FROM memories m WHERE m.tier != 'cold'
           AND NOT EXISTS (SELECT 1 FROM memories_vec v WHERE v.id = m.id)`,
        )
        .get()?.n ?? 0;
    const cold = db
      .prepare<[], { id: string; path: string }>('SELECT id, path FROM cold_index')
      .all();
    const total = live.length + cold.length;
    let done = 0;
    let coldDone = 0;

    // vec0 rejects `UPDATE ... SET embedding = vec_int8(?)`, so each row is deleted and
    // re-inserted with its other columns (partition and metadata) copied as they were.
    const others = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('memories_vec')")
      .all()
      .map((c) => c.name)
      .filter((c) => c !== 'id' && c !== 'embedding');
    const readRow = db.prepare<[string], Record<string, unknown>>(
      `SELECT ${others.join(', ')} FROM memories_vec WHERE id = ?`,
    );
    const deleteRow = db.prepare<[string]>('DELETE FROM memories_vec WHERE id = ?');
    const insertRow = db.prepare<unknown[]>(
      `INSERT INTO memories_vec (id, embedding, ${others.join(', ')})
       VALUES (?, vec_int8(?), ${others.map(() => '?').join(', ')})`,
    );
    // The binary index (schema version 5) follows each searchable vector: same code as `upsert`.
    const binary = hasBinaryIndex(db)
      ? {
          remove: db.prepare<[string]>(`DELETE FROM ${BIT_TABLE} WHERE id = ?`),
          insert: db.prepare<[string, Buffer, unknown, unknown, unknown, Buffer]>(
            `INSERT INTO ${BIT_TABLE} (id, embedding, node_key, project_key, author_key, rescore)
             VALUES (?, vec_bit(?), ?, ?, ?, ?)`,
          ),
        }
      : undefined;
    const setVector = (bytes: Buffer, id: string): void => {
      const row = readRow.get(id);
      if (row === undefined) return;
      deleteRow.run(id);
      insertRow.run(id, bytes, ...others.map((c) => row[c]));
      if (binary === undefined) return;
      binary.remove.run(id);
      if (row['tier'] === 'cold') return;
      const v = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      binary.insert.run(
        id,
        binaryCode(v),
        row['node_key'],
        row['project_key'],
        row['author_key'],
        bytes,
      );
    };
    for (let i = 0; i < live.length; i += batchSize) {
      const chunk = live.slice(i, i + batchSize);
      const vs = await opts.embed(chunk.map((r) => r.text));
      check(vs, chunk.length);
      db.transaction(() => {
        chunk.forEach((r, j) => setVector(toBytes(vs[j]!), r.id));
      }).immediate();
      done += chunk.length;
      opts.onProgress?.({ done, total });
    }

    const swap = db.prepare<[string, string, string]>(
      'UPDATE cold_index SET path = ? WHERE id = ? AND path = ?',
    );
    for (let i = 0; i < cold.length; i += batchSize) {
      const chunk = cold.slice(i, i + batchSize);
      const snapshots = chunk.flatMap((r) => {
        const data = blobs.read(r.path);
        return data === null ? [] : [{ ...r, memory: codec.decode(data) }];
      });
      const vs = await opts.embed(snapshots.map((s) => s.memory.text));
      check(vs, snapshots.length);
      const names = await blobs.writeMany(
        snapshots.map((s, j) => ({
          id: s.id,
          data: codec.encode({ ...s.memory, embedding: vs[j]! }),
        })),
      );
      const stale: string[] = [];
      const unused: string[] = [];
      try {
        db.transaction(() => {
          snapshots.forEach((s, j) => {
            // A cold copy rewritten or hydrated meanwhile keeps its newer blob.
            if (swap.run(names[j]!, s.id, s.path).changes === 1) stale.push(s.path);
            else unused.push(names[j]!);
          });
        }).immediate();
      } catch (e) {
        throw withCleanupFailures(e, blobs.removeAll(names));
      }
      blobs.removeAll([...stale, ...unused]);
      coldDone += stale.length;
      done += chunk.length;
      opts.onProgress?.({ done, total });
    }

    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(KEY, opts.model);
    return { live: live.length, cold: coldDone, withoutVector };
  } finally {
    db.close();
  }
}
