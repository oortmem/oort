/**
 * The multilingual eval (CON-110, design §11): one corpus and one question file per language in
 * `eval/multilingual/`, run in three conditions against English.
 *
 * - `mono`: questions in a language against that language's corpus.
 * - `cross`: the same questions against the English corpus; each expected id is mapped to its
 *   English twin. This measures a question in one language finding a memory written in another.
 * - `mixed`: every language's corpus plus the 1,500-memory synthetic English store as distractors,
 *   in one store. A question counts a hit for any language's copy of the expected fact, so the
 *   score measures whether the fact is found among the noise, and `sameLanguageFirst` reports how
 *   often the first copy found is in the question's language.
 *
 * Lexical-only and fake-embedder runs are deterministic and run in CI; real models are passed in.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  localScope,
  recall,
  resolveConfig,
  type RecallResult,
  type Embedder,
  type Memory,
  type MemoryStore,
  type MemoryType,
  type Reranker,
  type ResolvedConfig,
} from '@oortmem/core';
import { openSqliteStore, type VectorIndex } from '@oortmem/store-sqlite';
import {
  cell,
  computeMetrics,
  EVAL_CONDITIONS,
  loadEvalRows,
  type EvalCondition,
  type EvalReport,
  type EvalRow,
} from './eval.js';
import { fakeEmbedding } from './fake-embed.js';
import { FIXTURE_COUNT, FIXTURE_SEED } from './fixture.js';
import { EMBEDDING_DIMENSION, GENERATOR_NOW, generateMemories } from './generate.js';
import { ALL_SCOPE, seedStore } from './seed.js';

/** The six languages the bars apply to (design §11), plus English as the reference. */
export const GATING = ['es', 'pt-BR', 'de', 'fr', 'ja', 'zh-Hans'] as const;
/** Reported from the start; they join the gating set once stable. */
export const TRACKED = ['ko', 'hi', 'ar', 'th', 'ru', 'id'] as const;
export const LANGUAGES = ['en', ...GATING, ...TRACKED] as const;
export type Language = (typeof LANGUAGES)[number];

export const CONDITIONS = EVAL_CONDITIONS;
export type Condition = EvalCondition;

export const MULTILINGUAL_DIR = fileURLToPath(new URL('../eval/multilingual/', import.meta.url));

/** One fact's language-neutral metadata (`facts.jsonl`). */
export interface FactMeta {
  fact: string;
  type: MemoryType;
  entities: string[];
  validFrom: string;
  /** The fact this one replaced (a knowledge update); the older one ends when this begins. */
  supersedes?: string;
}

export interface MultilingualSet {
  facts: FactMeta[];
  /** Per language, fact id to memory text. */
  corpora: Map<Language, Map<string, string>>;
  /** Per language, its questions (eval rows whose ids are that language's memory ids). */
  questions: Map<Language, EvalRow[]>;
}

/** A memory's id: the language code, a dash, the fact id (`pt-BR-u03a`). */
export const memoryId = (lang: string, fact: string): string => `${lang}-${fact}`;

const FACT_ID = /^[a-z]\d{2}[a-z]?$/;

/** The fact behind a multilingual memory id, or the id itself for any other memory. */
export function factOf(id: string): string {
  const fact = id.slice(id.lastIndexOf('-') + 1);
  return FACT_ID.test(fact) &&
    (LANGUAGES as readonly string[]).includes(id.slice(0, -fact.length - 1))
    ? fact
    : id;
}

/** The language of a multilingual memory id, or undefined for any other memory. */
export function languageOf(id: string): Language | undefined {
  const fact = factOf(id);
  return fact === id ? undefined : (id.slice(0, -fact.length - 1) as Language);
}

function jsonl(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l, i) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        throw new Error(`${path.basename(file)}:${i + 1}: not valid JSON`);
      }
    });
}

/**
 * Reads and checks the set: every language has a text for every fact, and every question's
 * expected and not-expected ids name memories of its own language.
 */
export function loadMultilingualSet(dir = MULTILINGUAL_DIR): MultilingualSet {
  const facts = jsonl(path.join(dir, 'facts.jsonl')) as unknown as FactMeta[];
  const ids = new Set(facts.map((f) => f.fact));
  for (const f of facts) {
    if (!FACT_ID.test(f.fact)) throw new Error(`facts.jsonl: bad fact id ${f.fact}`);
    if (Number.isNaN(Date.parse(f.validFrom))) throw new Error(`facts.jsonl: ${f.fact} validFrom`);
    if (f.supersedes !== undefined && !ids.has(f.supersedes)) {
      throw new Error(`facts.jsonl: ${f.fact} supersedes unknown ${f.supersedes}`);
    }
  }
  const corpora = new Map<Language, Map<string, string>>();
  const questions = new Map<Language, EvalRow[]>();
  for (const lang of LANGUAGES) {
    const corpus = new Map<string, string>();
    for (const r of jsonl(path.join(dir, `${lang}.corpus.jsonl`))) {
      const fact = r['fact'];
      const text = r['text'];
      if (typeof fact !== 'string' || !ids.has(fact) || typeof text !== 'string' || !text.trim()) {
        throw new Error(`${lang}.corpus.jsonl: bad row for ${String(fact)}`);
      }
      corpus.set(fact, text);
    }
    const missing = facts.filter((f) => !corpus.has(f.fact)).map((f) => f.fact);
    if (missing.length > 0) throw new Error(`${lang}.corpus.jsonl: missing ${missing.join(', ')}`);
    corpora.set(lang, corpus);
    const file = path.join(dir, `${lang}.questions.jsonl`);
    const { rows } = loadEvalRows(fs.readFileSync(file, 'utf8'));
    for (const row of rows) {
      if (row.lang !== lang) throw new Error(`${lang}.questions.jsonl: row lang ${row.lang}`);
      for (const id of [...row.expectedMemoryIds, ...(row.notExpectedMemoryIds ?? [])]) {
        if (languageOf(id) !== lang || !ids.has(factOf(id))) {
          throw new Error(`${lang}.questions.jsonl: ${id} is not a ${lang} memory`);
        }
      }
    }
    questions.set(lang, rows);
  }
  return { facts, corpora, questions };
}

/** The stub a writer would give: the first sentence, cut to 80 characters. */
function stubOf(text: string): string {
  const first = text.split(/(?<=[.!?。！？])\s*/u)[0] ?? text;
  return first.length <= 80 ? first : `${first.slice(0, 77).trimEnd()}...`;
}

/**
 * One language's corpus as memories, all global (no project), with knowledge updates chained the
 * way the write path leaves them: the older version ends (`validTo`, `supersededBy`) when the newer
 * one begins. Embeddings are the fake embedder's; `embedMemories` replaces them for a real model.
 */
export function memoriesFor(set: MultilingualSet, lang: Language): Memory[] {
  const corpus = set.corpora.get(lang) as Map<string, string>;
  const next = new Map<string, FactMeta>();
  for (const f of set.facts) if (f.supersedes !== undefined) next.set(f.supersedes, f);
  return set.facts.map((f) => {
    const text = corpus.get(f.fact) as string;
    const later = next.get(f.fact);
    const iso = new Date(f.validFrom).toISOString();
    const end = later === undefined ? null : new Date(later.validFrom).toISOString();
    return {
      id: memoryId(lang, f.fact),
      scope: localScope(),
      type: f.type,
      text,
      stub: stubOf(text),
      entities: f.entities,
      salience: 0.6,
      pinned: false,
      tier: 'warm',
      accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
      validFrom: iso,
      validTo: end,
      expiredAt: end,
      endReason: end === null ? null : 'superseded',
      lastConfirmedAt: null,
      supersedes: f.supersedes === undefined ? null : memoryId(lang, f.supersedes),
      supersededBy: later === undefined ? null : memoryId(lang, later.fact),
      source: { harness: 'multilingual-eval', sessionId: `eval-${lang}`, decisions: [] },
      embedding: fakeEmbedding(text, EMBEDDING_DIMENSION),
      createdAt: iso,
      updatedAt: end ?? iso,
    };
  });
}

/** `memories` with their vectors replaced by `embed`'s document embeddings. */
export async function embedMemories(memories: Memory[], embed: Embedder): Promise<Memory[]> {
  const out: Memory[] = [];
  for (let i = 0; i < memories.length; i += 64) {
    const chunk = memories.slice(i, i + 64);
    const vectors = await embed.embed(
      chunk.map((m) => m.text),
      'document',
    );
    chunk.forEach((m, j) => out.push({ ...m, embedding: vectors[j] as Int8Array }));
  }
  return out;
}

export interface MultilingualOptions {
  set?: MultilingualSet;
  languages?: readonly Language[];
  conditions?: readonly Condition[];
  /** Dense path and corpus vectors (default: lexical only, fake vectors in the store). */
  embed?: Embedder;
  rerank?: Reranker;
  /** Recall settings to override; the default waits for the reranker (`rerankBudgetMs` 0). */
  recall?: Partial<ResolvedConfig['recall']>;
  /** The read path's clock (default `GENERATOR_NOW`, 2026-11-01). */
  now?: Date;
  /** Synthetic English distractors in the mixed store (default 1,500). */
  distractors?: number;
  /** Progress lines (default: none). */
  log?: (message: string) => void;
  /** The stores' dense index (CON-17; default `auto`, so int8 at this size). */
  vectorIndex?: VectorIndex;
  /**
   * Called with every row's full recall result (CON-131's calibration reads the gate and the
   * scores from it). Cross rows arrive with their ids mapped to English, mixed rows unmapped.
   */
  onRow?: (seen: RowSeen) => void;
  /**
   * Rows recalled after each (language, condition)'s own, in the same store, reported only to
   * `onRow` (with `extra: true`) and never in the metrics: `unrelatedRows()`, for example.
   */
  extraRows?: ReadonlyMap<Language, readonly EvalRow[]>;
}

/** One recalled row, as `MultilingualOptions.onRow` sees it. */
export interface RowSeen {
  lang: Language;
  condition: Condition;
  row: EvalRow;
  result: RecallResult;
  extra: boolean;
}

export interface LatencyStats {
  p50: number;
  p95: number;
}

export interface ConditionResult {
  lang: Language;
  condition: Condition;
  report: EvalReport;
  /** Recall's `totalMs` per question. */
  latencyMs: LatencyStats;
  /**
   * Mixed only: of the answerable questions whose fact was found in the top 10, the share whose
   * first copy found was in the question's language. Null elsewhere.
   */
  sameLanguageFirst: number | null;
}

export interface MultilingualReport {
  ks: number[];
  results: ConditionResult[];
}

const KS = [5, 10];

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
}

async function seeded(
  dir: string,
  memories: Memory[],
  vectorIndex?: VectorIndex,
): Promise<MemoryStore> {
  fs.mkdirSync(dir, { recursive: true });
  const store = await openSqliteStore({
    path: path.join(dir, 'oort.sqlite'),
    coldDir: path.join(dir, 'cold'),
    dimension: EMBEDDING_DIMENSION,
    ...(vectorIndex !== undefined && { vectorIndex }),
    log: () => {},
  });
  await seedStore(store, memories);
  return store;
}

/** Recalls every row in order; returns the ranked ids and each row's `totalMs`. */
async function recallRows(
  store: MemoryStore,
  rows: EvalRow[],
  config: ResolvedConfig,
  opts: MultilingualOptions,
  at: { lang: Language; condition: Condition },
): Promise<{ ids: string[][]; ms: number[] }> {
  // Rows must not influence each other through access records.
  const evalStore: MemoryStore = { ...store, recordAccess: async () => {} };
  const ids: string[][] = [];
  const ms: number[] = [];
  for (const row of rows) {
    const r = await recall(
      { text: row.question, scope: ALL_SCOPE, ...(row.asOf !== undefined && { asOf: row.asOf }) },
      {
        store: evalStore,
        config,
        now: opts.now ?? GENERATOR_NOW,
        ...(opts.embed !== undefined && { embed: opts.embed }),
        ...(opts.rerank !== undefined && { rerank: opts.rerank }),
      },
    );
    ids.push(r.memories.map((m) => m.id));
    ms.push(r.timings['totalMs'] ?? 0);
    opts.onRow?.({ ...at, row, result: r, extra: false });
  }
  for (const row of opts.onRow === undefined ? [] : (opts.extraRows?.get(at.lang) ?? [])) {
    const r = await recall(
      { text: row.question, scope: ALL_SCOPE },
      {
        store: evalStore,
        config,
        now: opts.now ?? GENERATOR_NOW,
        ...(opts.embed !== undefined && { embed: opts.embed }),
        ...(opts.rerank !== undefined && { rerank: opts.rerank }),
      },
    );
    opts.onRow?.({ ...at, row, result: r, extra: true });
  }
  return { ids, ms };
}

/**
 * Prompts a developer types that no memory in the set answers ("why does this test fail on
 * CI?"), so anything recalled for them is a false injection (CON-131). A prompt hook sees mostly
 * these. Per language: five written in it, 65 distinct tasks (`unrelated.jsonl`), then the
 * earlier three, translated into every language (`unrelated-translated.jsonl`, when `dir` has
 * it and `translated` is not false). The floors are chosen on both: the written ones alone pick
 * a rerank floor that injects more of the translated ones than the plain gate does.
 */
export function unrelatedRows(
  dir = MULTILINGUAL_DIR,
  opts: { translated?: boolean } = {},
): Map<Language, EvalRow[]> {
  const out = new Map<Language, EvalRow[]>();
  const files = ['unrelated.jsonl'];
  if (opts.translated !== false && fs.existsSync(path.join(dir, 'unrelated-translated.jsonl'))) {
    files.push('unrelated-translated.jsonl');
  }
  for (const file of files) {
    for (const r of jsonl(path.join(dir, file))) {
      const lang = r['lang'] as Language;
      const question = r['question'];
      if (!(LANGUAGES as readonly string[]).includes(lang) || typeof question !== 'string') {
        throw new Error(`${file}: bad row ${JSON.stringify(r)}`);
      }
      out.set(lang, [
        ...(out.get(lang) ?? []),
        { question, expectedMemoryIds: [], category: 'abstention', lang },
      ]);
    }
  }
  return out;
}

/** The rows that run in `condition`: those not pinned to another one. */
const rowsFor = (set: MultilingualSet, lang: Language, condition: Condition): EvalRow[] =>
  (set.questions.get(lang) ?? []).filter(
    (r) => r.condition === undefined || r.condition === condition,
  );

/** Rows with their memory ids rewritten by `f`. */
function remap(rows: EvalRow[], f: (id: string) => string): EvalRow[] {
  return rows.map((r) => ({
    ...r,
    expectedMemoryIds: r.expectedMemoryIds.map(f),
    ...(r.notExpectedMemoryIds !== undefined && {
      notExpectedMemoryIds: r.notExpectedMemoryIds.map(f),
    }),
  }));
}

/** Runs the multilingual eval and returns one result per (language, condition). */
export async function runMultilingual(opts: MultilingualOptions = {}): Promise<MultilingualReport> {
  const set = opts.set ?? loadMultilingualSet();
  const languages = opts.languages ?? LANGUAGES;
  const conditions = opts.conditions ?? CONDITIONS;
  const log = opts.log ?? (() => {});
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-multilingual-'));
  const base = resolveConfig(tmp, { OORT_HOME: tmp }, { projectConfig: false });
  const maxK = Math.max(...KS);
  const config: ResolvedConfig = {
    ...base,
    recall: {
      ...base.recall,
      returnK: maxK,
      rerankK: Math.max(base.recall.rerankK, maxK),
      rerankBudgetMs: 0,
      ...opts.recall,
    },
  };
  const vectors = async (ms: Memory[]): Promise<Memory[]> =>
    opts.embed === undefined ? ms : embedMemories(ms, opts.embed);
  const results: ConditionResult[] = [];
  const result = (
    lang: Language,
    condition: Condition,
    rows: EvalRow[],
    run: { ids: string[][]; ms: number[] },
    sameLanguageFirst: number | null = null,
  ): void => {
    const report = computeMetrics(
      rows,
      run.ids.map((ids) => ({ ids, aboveThreshold: ids.length })),
      KS,
    );
    const latencyMs = { p50: quantile(run.ms, 0.5), p95: quantile(run.ms, 0.95) };
    results.push({ lang, condition, report, latencyMs, sameLanguageFirst });
    log(`${lang} ${condition}: recall@10 ${cell(report.groups['overall']?.recallAt[10])}`);
  };
  try {
    if (conditions.includes('mono') || conditions.includes('cross')) {
      const english = await seeded(
        path.join(tmp, 'en'),
        await vectors(memoriesFor(set, 'en')),
        opts.vectorIndex,
      );
      try {
        for (const lang of languages) {
          if (conditions.includes('mono')) {
            const rows = rowsFor(set, lang, 'mono');
            if (lang === 'en') {
              result(
                lang,
                'mono',
                rows,
                await recallRows(english, rows, config, opts, { lang, condition: 'mono' }),
              );
            } else {
              const own = await seeded(
                path.join(tmp, lang),
                await vectors(memoriesFor(set, lang)),
                opts.vectorIndex,
              );
              try {
                result(
                  lang,
                  'mono',
                  rows,
                  await recallRows(own, rows, config, opts, { lang, condition: 'mono' }),
                );
              } finally {
                await own.close();
              }
            }
          }
          if (conditions.includes('cross') && lang !== 'en') {
            const crossRows = remap(rowsFor(set, lang, 'cross'), (id) =>
              memoryId('en', factOf(id)),
            );
            result(
              lang,
              'cross',
              crossRows,
              await recallRows(english, crossRows, config, opts, { lang, condition: 'cross' }),
            );
          }
        }
      } finally {
        await english.close();
      }
    }
    if (conditions.includes('mixed')) {
      const all = LANGUAGES.flatMap((lang) => memoriesFor(set, lang));
      const noise = generateMemories(opts.distractors ?? FIXTURE_COUNT, FIXTURE_SEED);
      const mixed = await seeded(
        path.join(tmp, 'mixed'),
        await vectors([...all, ...noise]),
        opts.vectorIndex,
      );
      try {
        for (const lang of languages) {
          const rows = rowsFor(set, lang, 'mixed');
          const run = await recallRows(mixed, rows, config, opts, { lang, condition: 'mixed' });
          // Any language's copy of the expected fact is a hit.
          let found = 0;
          let same = 0;
          rows.forEach((row, i) => {
            const want = new Set(row.expectedMemoryIds.map(factOf));
            if (want.size === 0) return;
            const first = (run.ids[i] as string[]).find((id) => want.has(factOf(id)));
            if (first === undefined) return;
            found++;
            if (languageOf(first) === lang) same++;
          });
          result(
            lang,
            'mixed',
            remap(rows, factOf),
            { ids: run.ids.map((ids) => ids.map(factOf)), ms: run.ms },
            found === 0 ? null : same / found,
          );
        }
      } finally {
        await mixed.close();
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { ks: KS, results };
}

const r10 = (r: ConditionResult | undefined): number | null | undefined =>
  r?.report.groups['overall']?.recallAt[10];

/**
 * A markdown table: one row per (language, condition). `vs en` is recall@10 as a share of
 * English's in the same condition; for `cross` it is against English `mono` (design §11's bar).
 */
export function renderMultilingual(report: MultilingualReport): string {
  const find = (lang: string, c: Condition) =>
    report.results.find((r) => r.lang === lang && r.condition === c);
  const head = [
    'Language',
    'Condition',
    'Rows',
    ...report.ks.map((k) => `R@${k}`),
    'MRR@10',
    'Stale',
    'Abstain FP',
    'vs en',
    'p50 ms',
    'p95 ms',
  ];
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const r of report.results) {
    const g = r.report.groups['overall'];
    if (g === undefined) continue;
    const ref = r10(find('en', r.condition === 'cross' ? 'mono' : r.condition));
    const mine = g.recallAt[10];
    const ratio =
      mine === null || mine === undefined || ref === null || ref === undefined || ref === 0
        ? '-'
        : (mine / ref).toFixed(2);
    lines.push(
      `| ${[
        r.lang,
        r.condition,
        String(g.rows),
        ...report.ks.map((k) => cell(g.recallAt[k])),
        cell(g.mrr),
        cell(g.staleLeak),
        cell(g.abstainFp),
        ratio,
        r.latencyMs.p50.toFixed(1),
        r.latencyMs.p95.toFixed(1),
      ].join(' | ')} |`,
    );
  }
  const mixed = report.results.filter((r) => r.sameLanguageFirst !== null);
  if (mixed.length > 0) {
    lines.push(
      '',
      'Mixed store, share of found facts whose first copy is in the question language: ' +
        mixed.map((r) => `${r.lang} ${cell(r.sameLanguageFirst)}`).join(', '),
    );
  }
  return lines.join('\n');
}
