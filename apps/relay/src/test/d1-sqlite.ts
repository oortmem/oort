import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1DatabaseLike, D1ResultLike, D1StatementLike } from '../d1.js';

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

/** Migration files in apply order, as wrangler applies them. */
export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function toSql(v: unknown): SQLInputValue {
  if (v === undefined)
    throw new TypeError('D1_TYPE_ERROR: undefined is not a supported bind value');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as SQLInputValue;
}

/**
 * An in-memory D1 stand-in backed by node:sqlite with the real migrations applied.
 * It follows D1's result shapes (first() returns null when empty, run() reports meta.changes).
 */
export function sqliteD1(dir = MIGRATIONS_DIR): D1DatabaseLike & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of migrationFiles(dir)) raw.exec(readFileSync(join(dir, f), 'utf8'));

  const statement = (sql: string, values: unknown[] = []): D1StatementLike => ({
    bind: (...v: unknown[]) => statement(sql, v),
    async first<T>() {
      const row = raw.prepare(sql).get(...values.map(toSql));
      return (row ?? null) as T | null;
    },
    async all<T>() {
      const rows = raw.prepare(sql).all(...values.map(toSql));
      return { results: rows as T[], success: true, meta: { changes: 0 } };
    },
    async run() {
      const r = raw.prepare(sql).run(...values.map(toSql));
      return { results: [], success: true, meta: { changes: Number(r.changes) } };
    },
  });

  return {
    raw,
    prepare: (sql) => statement(sql),
    async batch(stmts) {
      raw.exec('BEGIN');
      try {
        const out: D1ResultLike[] = [];
        for (const s of stmts) out.push(await s.run());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
