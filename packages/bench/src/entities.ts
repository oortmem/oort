/**
 * Entities for the verbatim writer (`verbatim.ts`), from the same place a normal write gets them:
 * the memory writer (`@oortmem/writer`), which names a memory's entities as it writes it. Core has
 * no other entity extraction. The writer is asked to write each turn as one memory (`ADD`); only
 * its `entities` are kept, and the stored text stays the turn's own words, so evidence is still
 * scored through `turnRef`.
 *
 * The writer is a paid model call per distinct turn text, so the answers are cached by model and
 * text, in memory and in a SQLite file: a second run (another links mode or speed, or the same set
 * again) calls the writer for nothing it has already seen. `prefetch` asks for every uncached
 * text up front, a few calls at a time.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { MemoryWriter, Observation } from '@oortmem/core';
import type { EntitySource } from './verbatim.js';

/** The cache key's text: what `observe` embeds for a turn (after scrubbing and capping). */
export const entityTextOf = (obs: Pick<Observation, 'userText' | 'assistantText'>): string =>
  `${obs.userText}\n${obs.assistantText}`;

export interface EntityUsage {
  /** Writer calls made. */
  calls: number;
  /** Calls that failed; their turns are stored with no entities. */
  failed: number;
  /** Texts answered from the cache. */
  hits: number;
}

export interface CachingEntities {
  source: EntitySource;
  /** Calls the writer for every observation whose text is not cached, `concurrency` at a time. */
  prefetch(observations: Observation[]): Promise<void>;
  has(text: string): boolean;
  usage(): EntityUsage;
  close(): void;
}

export interface WriterEntitiesOptions {
  /** Part of the cache key: answers of one model are never served for another. */
  model: string;
  /** A SQLite file that keeps answers across runs; memory only without it. */
  file?: string;
  /** Writer calls in flight during `prefetch` (default 8). */
  concurrency?: number;
  /**
   * Failed calls tolerated before the run stops: a broken key or model fails every call, and a
   * run whose memories silently name no entity would measure nothing. Default: 10, or 1% of the
   * calls made, whichever is more.
   */
  maxFailures?: (calls: number) => number;
}

export function writerEntities(writer: MemoryWriter, opts: WriterEntitiesOptions): CachingEntities {
  const mem = new Map<string, string[]>();
  let db: Database.Database | undefined;
  if (opts.file !== undefined) {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    db = new Database(opts.file);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS e (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID');
  }
  const getStmt = db?.prepare<[string], { v: string }>('SELECT v FROM e WHERE k = ?');
  const putStmt = db?.prepare<[string, string]>('INSERT OR REPLACE INTO e (k, v) VALUES (?, ?)');
  const usage: EntityUsage = { calls: 0, failed: 0, hits: 0 };
  const maxFailures = opts.maxFailures ?? ((calls: number) => Math.max(10, calls / 100));
  const key = (text: string): string =>
    createHash('sha256').update(`${opts.model}\0${text}`).digest('hex');
  const lookup = (k: string): string[] | undefined => {
    const hit = mem.get(k);
    if (hit !== undefined) return hit;
    const row = getStmt?.get(k);
    if (row === undefined) return undefined;
    const v = JSON.parse(row.v) as string[];
    mem.set(k, v);
    return v;
  };
  const ask = async (obs: Observation): Promise<string[]> => {
    const k = key(entityTextOf(obs));
    usage.calls++;
    try {
      const w = await writer.write(obs, 'ADD');
      mem.set(k, w.entities);
      putStmt?.run(k, JSON.stringify(w.entities));
      return w.entities;
    } catch (e) {
      usage.failed++;
      if (usage.failed > maxFailures(usage.calls)) {
        throw new Error(
          `entities: ${usage.failed} of ${usage.calls} writer calls failed, stopping. Last error: ${(e as Error).message}`,
        );
      }
      return [];
    }
  };
  return {
    async source(obs) {
      const hit = lookup(key(entityTextOf(obs)));
      if (hit !== undefined) {
        usage.hits++;
        return hit;
      }
      return ask(obs);
    },
    async prefetch(observations) {
      const seen = new Set<string>();
      const todo = observations.filter((o) => {
        const k = key(entityTextOf(o));
        if (seen.has(k) || lookup(k) !== undefined) return false;
        seen.add(k);
        return true;
      });
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < todo.length) await ask(todo[next++] as Observation);
      };
      await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 8) }, worker));
    },
    has: (text) => lookup(key(text)) !== undefined,
    usage: () => ({ ...usage }),
    close: () => db?.close(),
  };
}
