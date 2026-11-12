import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  localGrant,
  recall,
  resolveConfig,
  type Embedder,
  type MemoryStore,
  type Reranker,
  type ResolvedConfig,
  type ScopeFilter,
} from '@oortmem/core';
import { openSqliteStore, sqliteVectorIndex, type VectorIndex } from '@oortmem/store-sqlite';
import { linksOverride, viaOf, type LinksMode } from './links.js';

export const CATEGORIES = [
  'single-fact',
  'knowledge-update',
  'temporal',
  'multi-session',
  'multi-hop',
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
  /** BCP 47 code of the question's language (the multilingual set, `eval/multilingual/`). */
  lang?: string;
  /** Pins a row to one multilingual condition; rows without one run in every condition. */
  condition?: EvalCondition;
}

export const EVAL_CONDITIONS = ['mono', 'cross', 'mixed'] as const;
export type EvalCondition = (typeof EVAL_CONDITIONS)[number];

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
    if (o['lang'] !== undefined && (typeof o['lang'] !== 'string' || o['lang'] === '')) {
      throw new Error(`${where}: lang must be a language code`);
    }
    if (
      o['condition'] !== undefined &&
      !EVAL_CONDITIONS.includes(o['condition'] as EvalCondition)
    ) {
      throw new Error(`${where}: condition must be one of ${EVAL_CONDITIONS.join(', ')}`);
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
      ...(o['lang'] !== undefined ? { lang: o['lang'] as string } : {}),
      ...(o['condition'] !== undefined ? { condition: o['condition'] as EvalCondition } : {}),
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
  /**
   * Of the link-admitted memories (`explanation.via`) in the top 10 of every row, the share that
   * were expected; null when no row returned one (always, until links exist).
   */
  linkPrecision: number | null;
}

export interface EvalReport {
  ks: number[];
  skippedEmpty: number;
  groups: Record<string, GroupMetrics>;
  /**
   * The dense index the copy searched: exact int8, binary codes rescored in int8 (CON-17), or the
   * RaBitQ index (CON-25).
   */
  vectorIndex?: { index: 'int8' | 'binary' | 'rabitq'; vectors: number };
  /**
   * The int8 vectors read to rescore candidates (binary and RaBitQ indexes): `denseQueries`
   * dense searches, `reads` in all, `perQuery` on average.
   */
  rescoring?: { denseQueries: number; reads: number; perQuery: number };
  /**
   * What the rows read beyond the live set (CON-17): `hydrated`, the cold memories returned (each
   * one a cold read and a write); `asked`, the rows where the adaptive stop was asked (cold
   * matches beside live ones); `stopped`, the rows where it left the cold matches out.
   */
  reads?: { hydrated: number; asked: number; stopped: number };
}

export interface RowOutcome {
  /** Ranked ids returned by recall, best first. */
  ids: string[];
  /** How many returned memories counted as above the abstention threshold. */
  aboveThreshold: number;
  /** The returned ids a link brought in (`explanation.via`); absent or empty without links. */
  linked?: string[];
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Each row with the outcome recall gave it. */
function paired(rows: EvalRow[], outcomes: RowOutcome[]): { r: EvalRow; o: RowOutcome }[] {
  return rows.map((r, i) => ({ r, o: outcomes[i] as RowOutcome }));
}

/** MRR is taken over the top results only: fixed at 10, whatever `--k` asks for. */
const MRR_WINDOW = 10;
/** Link precision looks at the same top 10 the links bar is set on (design section 11). */
const LINK_WINDOW = 10;

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
  // Pooled over the rows, not averaged per row: most rows bring in no linked memory at all.
  let linked = 0;
  let linkedExpected = 0;
  for (const { r, o } of all) {
    const top = new Set(o.ids.slice(0, LINK_WINDOW));
    const want = new Set(r.expectedMemoryIds);
    for (const id of o.linked ?? []) {
      if (!top.has(id)) continue;
      linked++;
      if (want.has(id)) linkedExpected++;
    }
  }
  const linkPrecision = linked === 0 ? null : linkedExpected / linked;
  return { rows: rows.length, recallAt, mrr, staleLeak, abstainFp, linkPrecision };
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
  /** The copy's dense index (CON-17; default `auto`, as a store opens). */
  vectorIndex?: VectorIndex;
  /**
   * Archive this share of the copy's hot and warm memories before the rows run (0 to 1, default
   * 0): the same memories every run (chosen by a hash of the id), so the cold path is exercised
   * on a corpus that has none. For the adaptive stop's measurement (CON-17).
   */
  coldShare?: number;
  scope?: ScopeFilter;
  /**
   * A question set to run first with access recording live on the copy (`--warm-up`), so learned
   * links have history. Must not share a question with `rows`. The rows then run twice: cold
   * (before the warm-up) and warm (after it).
   */
  warmUp?: EvalRow[];
  /** Which links recall follows (`links.ts`); default `off`, today's recall. */
  links?: LinksMode;
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

/** What the warm-up pass did (`--warm-up`). */
export interface WarmUpStats {
  rows: number;
  /** `recordAccess` calls the warm-up's recalls made on the copy. */
  accessCalls: number;
  /** Memory ids those calls recorded, summed. */
  accessIds: number;
}

export interface EvalRun extends EvalReport {
  /** With `warmUp`: the same rows again, after the warm-up pass. The top level is the cold run. */
  warm?: EvalReport;
  warmUp?: WarmUpStats;
  /** The links mode the run used (`off` is today's recall). */
  links?: LinksMode;
}

/**
 * `--min-recall10`: every run that falls under the bar, cold and warm, for every links mode (an
 * empty list passes). A bar of 0 checks nothing.
 */
export function belowMinRecall10(runs: EvalRun[], min: number): string[] {
  if (!(min > 0)) return [];
  const out: string[] = [];
  for (const run of runs) {
    const label = `links ${run.links ?? 'off'}`;
    const passes: [string, EvalReport | undefined][] = [
      [label, run],
      [`${label} (warm)`, run.warm],
    ];
    for (const [name, r] of passes) {
      if (r === undefined) continue;
      const r10 = r.groups['overall']?.recallAt[10];
      if (r10 === null || r10 === undefined || r10 < min) {
        out.push(`${name}: recall@10 ${cell(r10)}`);
      }
    }
  }
  return out;
}

/** Questions compared for the warm-up's disjointness check: case and spacing do not count. */
const normalised = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, ' ');

/** Throws when a warm-up question is also an eval question: the two sets must be disjoint. */
export function assertDisjoint(rows: EvalRow[], warmUp: EvalRow[]): void {
  const asked = new Set(rows.map((r) => normalised(r.question)));
  const shared = warmUp.filter((r) => asked.has(normalised(r.question))).length;
  if (shared > 0) {
    throw new Error(
      `--warm-up: ${shared} question(s) also appear in the eval rows; use a disjoint set`,
    );
  }
}

export async function runEval(opts: RunEvalOptions): Promise<EvalRun> {
  const rescoring = { denseQueries: 0, reads: 0 };
  const ks = [...new Set([...(opts.ks ?? [5, 10]), 10])].sort((a, b) => a - b);
  const maxK = Math.max(...ks);
  if (opts.warmUp !== undefined) assertDisjoint(opts.rows, opts.warmUp);
  const copy = await copyStore(
    opts.storePath,
    opts.coldDir,
    opts.warn ?? ((m) => process.stderr.write(`${m}\n`)),
  );
  const store = await openSqliteStore({
    path: copy.dbPath,
    coldDir: copy.coldDir,
    dimension: opts.dimension ?? 512,
    ...(opts.vectorIndex !== undefined && { vectorIndex: opts.vectorIndex }),
    onDenseStats: (x) => (rescoring.reads += x.reads),
    log: () => {},
  });
  try {
    const base = resolveConfig(copy.dir, { OORT_HOME: copy.dir }, { projectConfig: false });
    const links = opts.links ?? 'off';
    const config = {
      ...base,
      recall: {
        ...base.recall,
        returnK: maxK,
        rerankK: Math.max(base.recall.rerankK, maxK),
        ...(opts.gate === false && { minRerankScore: 0, minCoverage: 0, minDenseScore: 0 }),
        ...linksOverride(links, base),
        ...opts.recall,
      },
    } as ResolvedConfig;
    // Rows must not influence each other: recall's access records would raise the
    // activation of everything an earlier row returned. The copy is discarded
    // either way, so reads of it simply skip that write.
    // Hydration (a cold memory written back warm) is skipped for the same reason: each row sees
    // the tiers the store had.
    const evalStore: MemoryStore = {
      ...store,
      recordAccess: async () => {},
      upsert: async () => {},
      dense: (...args) => {
        rescoring.denseQueries++;
        return store.dense(...args);
      },
    };
    const scope = opts.scope ?? discoverScope(copy.dbPath);
    const share = opts.coldShare ?? 0;
    if (share > 0) {
      const grant = localGrant(scope);
      const live = (await store.list(grant, { validOnly: false })).filter((m) => m.tier !== 'cold');
      const pick = live.filter(
        (m) => createHash('sha256').update(m.id).digest().readUInt32BE(0) / 2 ** 32 < share,
      );
      if (pick.length > 0) await store.coldPutMany(grant, pick);
    }
    const vectorIndex = sqliteVectorIndex(copy.dbPath);
    const recallRow = (row: EvalRow, s: MemoryStore) =>
      recall(
        { text: row.question, scope, ...(row.asOf !== undefined ? { asOf: row.asOf } : {}) },
        {
          store: s,
          config,
          ...(opts.embed !== undefined ? { embed: opts.embed } : {}),
          ...(opts.rerank !== undefined ? { rerank: opts.rerank } : {}),
          ...(opts.now !== undefined ? { now: opts.now } : {}),
        },
      );
    const runRows = async (): Promise<EvalReport> => {
      const reads = { hydrated: 0, asked: 0, stopped: 0 };
      // Each pass reports its own rescoring (the warm-up's recalls also read vectors).
      rescoring.denseQueries = 0;
      rescoring.reads = 0;
      const outcomes: RowOutcome[] = [];
      for (const row of opts.rows) {
        const r = await recallRow(row, evalStore);
        reads.hydrated += r.memories.filter((m) => m.explanation.hydrated === true).length;
        if (r.adaptiveStop !== undefined) reads.asked++;
        if (r.adaptiveStop?.stopped === true) reads.stopped++;
        outcomes.push({
          ids: r.memories.map((m) => m.id),
          aboveThreshold: r.memories.filter(
            (m) =>
              opts.abstainThreshold === undefined || m.explanation.fused > opts.abstainThreshold,
          ).length,
          linked: r.memories.filter((m) => viaOf(m) !== undefined).map((m) => m.id),
        });
      }
      return {
        ...computeMetrics(opts.rows, outcomes, ks, opts.skippedEmpty ?? 0),
        ...(vectorIndex !== undefined && { vectorIndex }),
        ...(vectorIndex !== undefined &&
          vectorIndex.index !== 'int8' && {
            rescoring: {
              ...rescoring,
              perQuery:
                rescoring.denseQueries === 0
                  ? 0
                  : Math.round((rescoring.reads / rescoring.denseQueries) * 10) / 10,
            },
          }),
        reads,
      };
    };
    const cold = await runRows();
    if (opts.warmUp === undefined) return { ...cold, links };
    // The warm-up pass: a disjoint question set whose recalls record accesses on the copy (and,
    // once links exist, learn recalledWith pairs there), so the second pass sees that history.
    // Only the copy is written; hydration stays off, so tiers do not move under the rows.
    const warmUp: WarmUpStats = { rows: opts.warmUp.length, accessCalls: 0, accessIds: 0 };
    const recording: MemoryStore = {
      ...store,
      upsert: async () => {},
      recordAccess: async (...args: Parameters<MemoryStore['recordAccess']>) => {
        warmUp.accessCalls++;
        warmUp.accessIds += args[1].length;
        return store.recordAccess(...args);
      },
    };
    for (const row of opts.warmUp) await recallRow(row, recording);
    const warm = await runRows();
    return { ...cold, warm, warmUp, links };
  } finally {
    await store.close();
    fs.rmSync(copy.dir, { recursive: true, force: true });
  }
}

/** A metric to three decimals, `-` when there is nothing to compute it from. */
export const cell = (n: number | null | undefined): string =>
  n === null || n === undefined ? '-' : n.toFixed(3);

export function renderReport(r: EvalReport): string {
  const head = [
    'Group',
    'Rows',
    ...r.ks.map((k) => `recall@${k}`),
    'MRR@10',
    'Stale-leak',
    'Abstain FP',
    'Link precision',
  ];
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const [name, g] of Object.entries(r.groups)) {
    lines.push(
      `| ${[name, String(g.rows), ...r.ks.map((k) => cell(g.recallAt[k])), cell(g.mrr), cell(g.staleLeak), cell(g.abstainFp), cell(g.linkPrecision)].join(' | ')} |`,
    );
  }
  if (r.skippedEmpty > 0) {
    lines.push('', `Skipped ${r.skippedEmpty} row(s) with an empty question.`);
  }
  if (r.vectorIndex !== undefined) {
    lines.push('', `Vector index: ${r.vectorIndex.index} (${r.vectorIndex.vectors} vectors).`);
  }
  if (r.rescoring !== undefined) {
    lines.push(
      `Rescoring reads: ${r.rescoring.perQuery} int8 vectors per dense query (${r.rescoring.reads} over ${r.rescoring.denseQueries} queries).`,
    );
  }
  if (r.reads !== undefined) {
    lines.push(
      `Cold hydrations: ${r.reads.hydrated}; adaptive stop asked on ${r.reads.asked} row(s), stopped on ${r.reads.stopped}.`,
    );
  }
  return lines.join('\n');
}

/** A run's report: the links mode, then the cold table, then (with a warm-up) the warm one. */
export function renderRun(r: EvalRun): string {
  const parts = [
    `Links: ${r.links ?? 'off'}${r.links === undefined || r.links === 'off' ? " (today's recall)" : ''}.`,
    '',
  ];
  if (r.warm === undefined) return [...parts, renderReport(r)].join('\n');
  const w = r.warmUp;
  return [
    ...parts,
    'Cold (before the warm-up):',
    '',
    renderReport(r),
    '',
    `Warm (after ${w?.rows ?? 0} warm-up question(s), ${w?.accessCalls ?? 0} access record(s) of ${w?.accessIds ?? 0} memories on the copy):`,
    '',
    renderReport(r.warm),
  ].join('\n');
}
