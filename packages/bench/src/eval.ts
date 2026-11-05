import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  recall,
  resolveConfig,
  type Embedder,
  type MemoryStore,
  type Reranker,
  type ResolvedConfig,
  type ScopeFilter,
} from '@oortmem/core';
import { openSqliteStore } from '@oortmem/store-sqlite';

export const CATEGORIES = [
  'single-fact',
  'knowledge-update',
  'temporal',
  'multi-session',
  'abstention',
] as const;
export type EvalCategory = (typeof CATEGORIES)[number];

/** One JSONL row; see `eval/format.md`. */
export interface EvalRow {
  question: string;
  expectedMemoryIds: string[];
  asOf?: string;
  category?: EvalCategory;
  notExpectedMemoryIds?: string[];
}

export interface LoadedRows {
  rows: EvalRow[];
  /** Rows with an empty question (the `oort import` placeholders), left out. */
  skippedEmpty: number;
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === 'string');
}

/**
 * Parses an eval JSONL file. Blank lines are ignored; rows whose `question` is
 * empty or whitespace (what `oort import` writes for hand labelling) are
 * skipped and counted; any other malformed row throws, naming its line.
 * Unknown keys (such as the importer's `memoryId`) are ignored.
 */
export function loadEvalRows(text: string): LoadedRows {
  const rows: EvalRow[] = [];
  let skippedEmpty = 0;
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    const where = `eval row at line ${i + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not valid JSON`);
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`${where}: expected a JSON object`);
    }
    const o = raw as Record<string, unknown>;
    if (typeof o['question'] !== 'string') throw new Error(`${where}: question must be a string`);
    if (!isStringArray(o['expectedMemoryIds'])) {
      throw new Error(`${where}: expectedMemoryIds must be an array of strings`);
    }
    if (
      o['asOf'] !== undefined &&
      (typeof o['asOf'] !== 'string' || Number.isNaN(Date.parse(o['asOf'])))
    ) {
      throw new Error(`${where}: asOf must be an ISO timestamp`);
    }
    if (o['notExpectedMemoryIds'] !== undefined && !isStringArray(o['notExpectedMemoryIds'])) {
      throw new Error(`${where}: notExpectedMemoryIds must be an array of strings`);
    }
    if (o['category'] !== undefined && !CATEGORIES.includes(o['category'] as EvalCategory)) {
      throw new Error(`${where}: category must be one of ${CATEGORIES.join(', ')}`);
    }
    if (o['question'].trim() === '') {
      skippedEmpty++;
      continue;
    }
    rows.push({
      question: o['question'],
      expectedMemoryIds: o['expectedMemoryIds'],
      ...(o['asOf'] !== undefined ? { asOf: o['asOf'] as string } : {}),
      ...(o['category'] !== undefined ? { category: o['category'] as EvalCategory } : {}),
      ...(o['notExpectedMemoryIds'] !== undefined
        ? { notExpectedMemoryIds: o['notExpectedMemoryIds'] as string[] }
        : {}),
    });
  }
  return { rows, skippedEmpty };
}

export interface GroupMetrics {
  rows: number;
  /** Mean over rows with expected ids of the fraction of them in the top k; null when none. */
  recallAt: Record<number, number | null>;
  /** MRR@10: mean reciprocal rank of the first expected id in the top 10; null when no row has expected ids. */
  mrr: number | null;
  /** Fraction of rows listing not-expected ids where any appears in the top 10; null when none list any. */
  staleLeak: number | null;
  /** Fraction of abstention rows that returned a memory (above the threshold); null when none. */
  abstainFp: number | null;
}

export interface EvalReport {
  ks: number[];
  skippedEmpty: number;
  groups: Record<string, GroupMetrics>;
}

export interface RowOutcome {
  /** Ranked ids returned by recall, best first. */
  ids: string[];
  /** How many returned memories counted as above the abstention threshold. */
  aboveThreshold: number;
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Each row with the outcome recall gave it. */
function paired(rows: EvalRow[], outcomes: RowOutcome[]): { r: EvalRow; o: RowOutcome }[] {
  return rows.map((r, i) => ({ r, o: outcomes[i] as RowOutcome }));
}

/** MRR is taken over the top results only: fixed at 10, whatever `--k` asks for. */
const MRR_WINDOW = 10;

function groupMetrics(rows: EvalRow[], outcomes: RowOutcome[], ks: number[]): GroupMetrics {
  const all = paired(rows, outcomes);
  const withExpected = all.filter((x) => x.r.expectedMemoryIds.length > 0);
  const recallAt: Record<number, number | null> = {};
  for (const k of ks) {
    recallAt[k] = mean(
      withExpected.map(({ r, o }) => {
        const top = new Set(o.ids.slice(0, k));
        return r.expectedMemoryIds.filter((id) => top.has(id)).length / r.expectedMemoryIds.length;
      }),
    );
  }
  const mrr = mean(
    withExpected.map(({ r, o }) => {
      const want = new Set(r.expectedMemoryIds);
      const rank = o.ids.slice(0, MRR_WINDOW).findIndex((id) => want.has(id));
      return rank < 0 ? 0 : 1 / (rank + 1);
    }),
  );
  const staleLeak = mean(
    all
      .filter((x) => (x.r.notExpectedMemoryIds ?? []).length > 0)
      .map(({ r, o }) => {
        const top = new Set(o.ids.slice(0, 10));
        return (r.notExpectedMemoryIds ?? []).some((id) => top.has(id)) ? 1 : 0;
      }),
  );
  const abstainFp = mean(
    all.filter((x) => x.r.category === 'abstention').map(({ o }) => (o.aboveThreshold > 0 ? 1 : 0)),
  );
  return { rows: rows.length, recallAt, mrr, staleLeak, abstainFp };
}

/** Pure scoring: `outcomes[i]` is what recall returned for `rows[i]`. */
export function computeMetrics(
  rows: EvalRow[],
  outcomes: RowOutcome[],
  ks: number[],
  skippedEmpty = 0,
): EvalReport {
  const groups: Record<string, GroupMetrics> = { overall: groupMetrics(rows, outcomes, ks) };
  const names = new Set<string>(rows.map((r) => r.category ?? 'uncategorized'));
  for (const name of [...CATEGORIES, 'uncategorized']) {
    if (!names.has(name)) continue;
    const idx = rows.flatMap((r, i) => ((r.category ?? 'uncategorized') === name ? [i] : []));
    groups[name] = groupMetrics(
      idx.map((i) => rows[i] as EvalRow),
      idx.map((i) => outcomes[i] as RowOutcome),
      ks,
    );
  }
  return { ks, skippedEmpty, groups };
}

export interface RunEvalOptions {
  rows: EvalRow[];
  skippedEmpty?: number;
  storePath: string;
  /** Cold blob directory of the store at `storePath`. */
  coldDir: string;
  /** The store's embedding dimension (default 512). */
  dimension?: number;
  /** Cut-offs to report (default 5 and 10); 10 is always computed. */
  ks?: number[];
  /** The read path's `now` (default: wall clock). */
  now?: Date;
  /** Run the dense path with this embedder (default: lexical only). */
  embed?: Embedder;
  /**
   * An abstention row is a false positive when recall returns a memory whose
   * fused score exceeds this. Unset: any returned memory counts.
   */
  abstainThreshold?: number;
  /** Apply recall's relevance gate (default true). False sets its thresholds to 0, for comparison. */
  gate?: boolean;
  /** Recall settings to override for this run, for comparisons (for example `lexicalFirst`). */
  recall?: Partial<ResolvedConfig['recall']>;
  /** Rerank with this reranker (default: none). */
  rerank?: Reranker;
  scope?: ScopeFilter;
  /** Receives one-line warnings (counts only); defaults to stderr. */
  warn?: (message: string) => void;
}

/** The copy must be writable (hydration writes) even when the live directory is read-only. */
function makeWritable(dir: string): void {
  fs.chmodSync(dir, 0o700);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) makeWritable(p);
    else fs.chmodSync(p, 0o600);
  }
}

/**
 * Snapshots the store into a temp directory and returns it. The database is
 * read through a read-only connection and written with SQLite's online backup,
 * so the copy is transaction-consistent even while another process writes
 * (copying the main file and WAL separately could tear). The cold blobs are
 * copied after it. `recall` appends access records, so eval only ever opens
 * the copy: the live files are read, never written.
 */
async function copyStore(
  storePath: string,
  coldDir: string,
  warn: (message: string) => void,
): Promise<{ dbPath: string; coldDir: string; dir: string }> {
  if (!fs.existsSync(storePath)) throw new Error(`store not found: ${storePath}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-eval-'));
  const dbPath = path.join(dir, 'oort.sqlite');
  const copiedCold = path.join(dir, 'cold');
  try {
    const live = new Database(storePath, { readonly: true, fileMustExist: true });
    try {
      await live.backup(dbPath);
    } finally {
      live.close();
    }
    if (fs.existsSync(coldDir)) {
      fs.cpSync(coldDir, copiedCold, { recursive: true });
      makeWritable(copiedCold);
    }
    const copy = new Database(dbPath, { readonly: true });
    try {
      const names = copy.prepare<[], { path: string }>('SELECT path FROM cold_index').all();
      const missing = names.filter((r) => !fs.existsSync(path.join(copiedCold, r.path))).length;
      if (missing > 0) {
        warn(`eval: ${missing} cold blob(s) named by the store are missing from ${coldDir}`);
      }
    } finally {
      copy.close();
    }
    return { dbPath, coldDir: copiedCold, dir };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Every project a store holds is visible to eval (it measures recall, not
 * scoping): the (org, customer, agent) with the most memories, over all of its
 * project ids and global. Read from the temp copy.
 */
function hasColumn(db: Database.Database, column: string): boolean {
  return db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('memories')")
    .all()
    .some((c) => c.name === column);
}

export function discoverScope(dbPath: string): ScopeFilter {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare<
        [],
        {
          org_id: string;
          customer_id: string;
          agent_id: string;
          project_id: string | null;
          n: number;
        }
      >(
        // Schema version 2 keeps the writing agent in author_agent_id; only Planet
        // memories map onto a scope filter. Version 1 (a copy not yet opened) has agent_id.
        hasColumn(db, 'author_agent_id')
          ? `SELECT org_id, customer_id, author_agent_id AS agent_id, project_id, COUNT(*) AS n
             FROM memories WHERE level = 'user'
             GROUP BY org_id, customer_id, author_agent_id, project_id`
          : `SELECT org_id, customer_id, agent_id, project_id, COUNT(*) AS n FROM memories
             GROUP BY org_id, customer_id, agent_id, project_id`,
      )
      .all();
    const totals = new Map<string, number>();
    for (const r of rows) {
      const key = JSON.stringify([r.org_id, r.customer_id, r.agent_id]);
      totals.set(key, (totals.get(key) ?? 0) + r.n);
    }
    const best = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best === undefined)
      return { orgId: 'local', customerId: 'self', agentId: 'claude-code', projectIds: [null] };
    const [orgId, customerId, agentId] = JSON.parse(best[0]) as [string, string, string];
    const projectIds = new Set<string | null>([null]);
    for (const r of rows) {
      if (r.org_id === orgId && r.customer_id === customerId && r.agent_id === agentId) {
        projectIds.add(r.project_id);
      }
    }
    return { orgId, customerId, agentId, projectIds: [...projectIds] };
  } finally {
    db.close();
  }
}

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const ks = [...new Set([...(opts.ks ?? [5, 10]), 10])].sort((a, b) => a - b);
  const maxK = Math.max(...ks);
  const copy = await copyStore(
    opts.storePath,
    opts.coldDir,
    opts.warn ?? ((m) => process.stderr.write(`${m}\n`)),
  );
  const store = await openSqliteStore({
    path: copy.dbPath,
    coldDir: copy.coldDir,
    dimension: opts.dimension ?? 512,
    log: () => {},
  });
  try {
    const base = resolveConfig(copy.dir, { OORT_HOME: copy.dir }, { projectConfig: false });
    const config = {
      ...base,
      recall: {
        ...base.recall,
        returnK: maxK,
        rerankK: Math.max(base.recall.rerankK, maxK),
        ...(opts.gate === false && { minRerankScore: 0, minCoverage: 0, minDenseScore: 0 }),
        ...opts.recall,
      },
    };
    // Rows must not influence each other: recall's access records would raise the
    // activation of everything an earlier row returned. The copy is discarded
    // either way, so reads of it simply skip that write.
    const evalStore: MemoryStore = { ...store, recordAccess: async () => {} };
    const scope = opts.scope ?? discoverScope(copy.dbPath);
    const outcomes: RowOutcome[] = [];
    for (const row of opts.rows) {
      const r = await recall(
        { text: row.question, scope, ...(row.asOf !== undefined ? { asOf: row.asOf } : {}) },
        {
          store: evalStore,
          config,
          ...(opts.embed !== undefined ? { embed: opts.embed } : {}),
          ...(opts.rerank !== undefined ? { rerank: opts.rerank } : {}),
          ...(opts.now !== undefined ? { now: opts.now } : {}),
        },
      );
      outcomes.push({
        ids: r.memories.map((m) => m.id),
        aboveThreshold: r.memories.filter(
          (m) => opts.abstainThreshold === undefined || m.explanation.fused > opts.abstainThreshold,
        ).length,
      });
    }
    return computeMetrics(opts.rows, outcomes, ks, opts.skippedEmpty ?? 0);
  } finally {
    await store.close();
    fs.rmSync(copy.dir, { recursive: true, force: true });
  }
}
