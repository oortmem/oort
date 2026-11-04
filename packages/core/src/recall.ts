import type { Embedder, Hit, MemoryStore, Reranker, ScopeFilter } from './adapters.js';
import type { ResolvedConfig } from './config.js';
import { activation } from './activation.js';
import { fuse, isVisible, type TemporalView } from './fusion.js';
import { localGrant } from './grant.js';
import { scrub } from './scrub.js';
import { isCurrent, type Memory } from './model.js';
import { temporalIntent, type RecallMode } from './temporal.js';
import { isStale, lastConfirmed } from './volatile.js';
import {
  CONFIDENT_COVERAGE,
  CONFIDENT_COVERAGE_GAP,
  informativeTokens,
  queryCoverage,
} from './relevance.js';

export interface RecallQuery {
  text: string;
  scope: ScopeFilter;
  budgetChars?: number;
  /** ISO timestamp: recall what was true then (valid time). Implies `mode: 'as-of'`. */
  asOf?: string;
  /** ISO timestamp: recall what was believed then (transaction time). Implies `mode: 'known-at'`. */
  knownAt?: string;
  /**
   * Which slice of time to read (CON-34): `current` (the default), `as-of` (`asOf`), `history`
   * (every version, along the supersede chain) or `known-at` (`knownAt`). Without a mode, `asOf`
   * or `knownAt`, the mode is read from the query ("on 2 April", "how has … changed").
   */
  mode?: RecallMode;
}

/** The temporal view a recall used, and whether it was read from the query. */
export interface RecallTemporal {
  mode: RecallMode;
  asOf?: string;
  knownAt?: string;
  inferred: boolean;
}

export interface RecalledMemory extends Memory {
  explanation: {
    lexicalRank?: number;
    denseRank?: number;
    /** Final fused score: rrf scaled by the bounded activation boost. */
    fused: number;
    /** Raw reciprocal-rank-fusion score. */
    rrf: number;
    reranked?: number;
    /** Share of the query's informative words this memory contains, 0 to 1. */
    coverage: number;
    /** Dense (cosine) similarity to the query, when the dense search found it. */
    dense?: number;
    activation: number;
    hydrated: boolean;
    /** History mode: found by walking the supersede chain, not by the search. */
    chain?: true;
    /** A volatile fact nobody confirmed within `recall.staleAfterDays`. */
    stale?: true;
  };
}

export type Degradation =
  | 'no-embedder'
  | 'no-reranker'
  | 'embed-failed'
  | 'rerank-failed'
  /** The reranker returned no ids: the fused order stands. */
  | 'rerank-empty'
  /** The store's dense search failed: lexical-only. */
  | 'dense-failed'
  /** The reranker did not answer within `recall.rerankBudgetMs`: the fused order stands. */
  | 'rerank-timeout'
  /** Reading or promoting a cold copy failed: those memories stay cold, unhydrated. */
  | 'hydrate-failed';

export interface RecallResult {
  memories: RecalledMemory[];
  /** Reserved for the hook layer (gate decision); `recall` never sets it. */
  skipped?: string;
  degraded?: Degradation[];
  /** Candidates were found, but none was relevant enough: the answer is "no relevant memories". */
  abstained?: true;
  /** What the relevance gate did, when it dropped anything. */
  gate?: { by: 'rerank' | 'coverage'; threshold: number; dropped: number };
  /** Rerank was available but not called, because fusion already had a clear answer. */
  rerankSkipped?: 'confident';
  /** The query was not embedded, because the lexical search already had a clear answer. */
  embedSkipped?: 'lexical-confident';
  /** The temporal view this recall read. Always set by `recall`. */
  temporal?: RecallTemporal;
  timings: Record<string, number>;
}

export interface RecallDeps {
  store: MemoryStore;
  embed?: Embedder;
  rerank?: Reranker;
  config: ResolvedConfig;
  now?: Date;
}

const clock = (): number => performance.now();

/**
 * Hybrid recall: lexical + dense first stage, cold hydration, activation-aware
 * fusion, optional rerank. Adapter failures degrade, never throw; so do store
 * failures in the dense search and in cold hydration (lexical-only, with the
 * reason in `degraded`). The lexical search is the floor: its failure rejects.
 */
export async function recall(q: RecallQuery, deps: RecallDeps): Promise<RecallResult> {
  const { store, config } = deps;
  // The store enforces scope; recall reads and hydrates only inside q.scope.
  const grant = localGrant(q.scope);
  const now = deps.now ?? new Date();
  // Scrub once: the query text reaches embedders and rerankers, which may be remote. Temporal
  // words ("on 2 April", "changed over time") pick the view and are not searched for.
  const { view, temporal, text } = viewFor(q, scrub(q.text).text, now);
  const t0 = clock();
  const degraded: Degradation[] = [];
  const timings: Record<string, number> = {
    gateMs: 0,
    embedMs: 0,
    lexicalMs: 0,
    denseMs: 0,
    hydrateMs: 0,
    fuseMs: 0,
    rerankMs: 0,
    totalMs: 0,
  };

  const timed = async <T>(key: string, p: () => Promise<T>): Promise<T> => {
    const t = clock();
    try {
      return await p();
    } finally {
      timings[key] = clock() - t;
    }
  };

  const queryTokens = informativeTokens(text);
  // Memories read while deciding, reused below so nothing is read twice.
  const prefetched = new Map<string, Memory | null>();
  const read = async (id: string): Promise<Memory | null> => {
    if (prefetched.has(id)) return prefetched.get(id) ?? null;
    const m = await store.get(grant, id);
    prefetched.set(id, m);
    return m;
  };

  const lexicalP = timed('lexicalMs', () => store.lexical(grant, text, config.recall.lexicalK));
  // A failed embed must not leave the lexical promise unobserved.
  lexicalP.catch(() => {});

  // Lexical first (CON-57): when the lexical answer is already clear, skip the embedding round
  // trip. Otherwise the lexical search has run while nothing else waited on it.
  let embedSkipped: RecallResult['embedSkipped'];
  if (deps.embed && config.recall.lexicalFirst) {
    const first = await lexicalP;
    if (await lexicalIsConfident(first, queryTokens, read, now, view)) {
      embedSkipped = 'lexical-confident';
    }
  }

  let vector: Int8Array | undefined;
  if (!deps.embed) {
    degraded.push('no-embedder');
  } else if (embedSkipped === undefined) {
    const t = clock();
    try {
      vector = (await deps.embed.embed([text], 'query'))[0];
      if (vector === undefined) degraded.push('embed-failed');
    } catch {
      degraded.push('embed-failed');
    }
    timings['embedMs'] = clock() - t;
  }

  const v = vector;
  const [lexical, dense] = await Promise.all([
    lexicalP,
    v === undefined
      ? Promise.resolve<Hit[]>([])
      : timed('denseMs', () =>
          store.dense(grant, v, config.recall.denseK).catch((): Hit[] => {
            degraded.push('dense-failed');
            return [];
          }),
        ),
  ]);

  const ids = [...new Set([...lexical, ...dense].map((h) => h.id))];
  const coldIds = new Set([...lexical, ...dense].filter((h) => h.tier === 'cold').map((h) => h.id));

  const th = clock();
  const hydratedIds = new Set<string>();
  let hydrateFailed = false;
  const loaded = await Promise.all(
    ids.map(async (id): Promise<Memory | null> => {
      const live = await read(id);
      if (live === null) return null;
      if (live.tier !== 'cold' && !coldIds.has(id)) return live;
      try {
        const blob = await store.coldGet(grant, id);
        // A lost or torn blob: the memory stays cold, lexical-only.
        // TODO(Phase 2): re-embed on hydration when an embedder is present.
        if (!blob?.embedding) return live;
        const hydrated: Memory = {
          ...live,
          text: blob.text,
          stub: blob.stub,
          entities: blob.entities,
          embedding: blob.embedding,
          tier: 'warm',
        };
        await store.upsert(grant, hydrated);
        hydratedIds.add(id);
        return hydrated;
      } catch {
        hydrateFailed = true;
        return live;
      }
    }),
  );
  timings['hydrateMs'] = clock() - th;
  if (hydrateFailed) degraded.push('hydrate-failed');

  const memories = new Map<string, Memory>();
  for (const m of loaded) if (m !== null) memories.set(m.id, m);

  const tf = clock();
  const fused = fuse([lexical, dense], memories, now, { activation: config.activation, view });
  timings['fuseMs'] = clock() - tf;

  const coverage = new Map<string, number>();
  for (const f of fused) {
    const m = memories.get(f.id);
    if (m !== undefined) coverage.set(f.id, queryCoverage(queryTokens, m));
  }
  const denseScore = new Map(dense.map((h) => [h.id, h.score]));

  let ordered = fused.slice(0, config.recall.rerankK);
  const rerankScores = new Map<string, number>();
  let rerankSkipped: RecallResult['rerankSkipped'];
  if (!deps.rerank) {
    degraded.push('no-reranker');
  } else if (
    config.recall.skipRerankWhenConfident &&
    isConfident(ordered, lexical, dense, coverage)
  ) {
    rerankSkipped = 'confident';
  } else if (ordered.length > 0) {
    const tr = clock();
    try {
      const docs = ordered.map((f) => ({ id: f.id, text: memories.get(f.id)?.text ?? '' }));
      const reranked = await withBudget(
        deps.rerank.rerank(text, docs, config.recall.returnK),
        config.recall.rerankBudgetMs,
      );
      if (reranked === TIMED_OUT) throw RERANK_TIMEOUT;
      const byId = new Map(ordered.map((f) => [f.id, f]));
      const next: typeof ordered = [];
      for (const r of reranked) {
        const f = byId.get(r.id);
        if (f === undefined) continue;
        rerankScores.set(r.id, r.score);
        next.push(f);
        byId.delete(r.id);
      }
      if (next.length === 0) {
        // Nothing usable came back (an empty list, or only unknown ids): keep the fused order.
        degraded.push('rerank-empty');
      } else {
        ordered = next;
      }
    } catch (e) {
      degraded.push(e === RERANK_TIMEOUT ? 'rerank-timeout' : 'rerank-failed');
      rerankScores.clear();
    }
    timings['rerankMs'] = clock() - tr;
  }

  // Relevance gate (CON-45): a reranker score when there is one, else query-word coverage or a
  // strong dense match. A threshold of 0 switches that test off.
  const { minRerankScore, minCoverage, minDenseScore } = config.recall;
  const candidates = ordered.slice(0, config.recall.returnK);
  const byRerank = rerankScores.size > 0;
  const relevant = (id: string): boolean => {
    const rs = rerankScores.get(id);
    if (rs !== undefined) return rs >= minRerankScore;
    if (minCoverage === 0) return true;
    if ((coverage.get(id) ?? 0) >= minCoverage) return true;
    return minDenseScore > 0 && (denseScore.get(id) ?? -1) >= minDenseScore;
  };
  const kept = candidates.filter((f) => relevant(f.id));
  const dropped = candidates.length - kept.length;

  const out: RecalledMemory[] = [];
  for (const f of kept) {
    const m = memories.get(f.id);
    if (m === undefined) continue;
    const lr = lexical.findIndex((h) => h.id === f.id);
    const dr = dense.findIndex((h) => h.id === f.id);
    const rs = rerankScores.get(f.id);
    const ds = denseScore.get(f.id);
    out.push({
      ...m,
      explanation: {
        ...(lr >= 0 ? { lexicalRank: lr + 1 } : {}),
        ...(dr >= 0 ? { denseRank: dr + 1 } : {}),
        fused: f.score,
        rrf: f.rrf,
        ...(rs !== undefined ? { reranked: rs } : {}),
        coverage: coverage.get(f.id) ?? 0,
        ...(ds !== undefined ? { dense: ds } : {}),
        activation: activation(m.accessLog, m.salience, now, config.activation),
        hydrated: hydratedIds.has(f.id),
      },
    });
  }

  await store.recordAccess(
    grant,
    out.map((m) => m.id),
    now,
  );
  const result =
    view.mode === 'history' ? await withChains(out, read, now, view, queryTokens, config) : out;
  for (const m of result) {
    if (isCurrent(m, now) && isStale(m, now, config.recall.staleAfterDays)) {
      m.explanation.stale = true;
    }
  }
  timings['totalMs'] = clock() - t0;
  return {
    memories: result,
    ...(degraded.length > 0 ? { degraded } : {}),
    ...(out.length === 0 && candidates.length > 0 ? { abstained: true as const } : {}),
    ...(dropped > 0
      ? {
          gate: {
            by: byRerank ? ('rerank' as const) : ('coverage' as const),
            threshold: byRerank ? minRerankScore : minCoverage,
            dropped,
          },
        }
      : {}),
    ...(rerankSkipped !== undefined ? { rerankSkipped } : {}),
    ...(embedSkipped !== undefined ? { embedSkipped } : {}),
    temporal,
    timings,
  };
}

/** The view a query asks for: explicit options first, else read from the query in code. */
function viewFor(
  q: RecallQuery,
  text: string,
  now: Date,
): { view: TemporalView; temporal: RecallTemporal; text: string } {
  const at = (iso: string | undefined) => iso ?? now.toISOString();
  let view: TemporalView;
  let inferred = false;
  let search = text;
  if (q.mode !== undefined) {
    view = { mode: q.mode };
    if (q.mode === 'as-of') view.asOf = at(q.asOf);
    if (q.mode === 'known-at') view.knownAt = at(q.knownAt);
  } else if (q.asOf !== undefined) {
    view = { mode: 'as-of', asOf: q.asOf };
  } else if (q.knownAt !== undefined) {
    view = { mode: 'known-at', knownAt: q.knownAt };
  } else {
    const i = temporalIntent(text, now);
    view = {
      mode: i.mode,
      ...(i.asOf !== undefined && { asOf: i.asOf }),
      ...(i.knownAt !== undefined && { knownAt: i.knownAt }),
    };
    inferred = true;
    search = i.text ?? text;
  }
  return { view, temporal: { ...view, inferred }, text: search };
}

/** Longest stretch of a supersede chain walked in each direction. */
const CHAIN_MAX = 8;

/**
 * History mode: each recalled fact with the rest of its supersede chain, oldest first, the
 * first-ranked chain first. Corrected versions are skipped (they were never true) but walked
 * through. Versions only the walk found are marked `chain`.
 */
async function withChains(
  out: RecalledMemory[],
  read: (id: string) => Promise<Memory | null>,
  now: Date,
  view: TemporalView,
  queryTokens: Set<string>,
  config: ResolvedConfig,
): Promise<RecalledMemory[]> {
  const byId = new Map(out.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const result: RecalledMemory[] = [];
  for (const head of out) {
    if (seen.has(head.id)) continue;
    const links: Memory[] = [head];
    for (const dir of ['supersedes', 'supersededBy'] as const) {
      let cur: Memory = head;
      for (let n = 0; n < CHAIN_MAX; n++) {
        const next = cur[dir];
        if (next === null || seen.has(next) || links.some((l) => l.id === next)) break;
        const m = await read(next);
        if (m === null) break;
        links.push(m);
        cur = m;
      }
    }
    links.sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom));
    for (const m of links) {
      seen.add(m.id);
      if (!isVisible(m, now, view)) continue;
      result.push(
        byId.get(m.id) ?? {
          ...m,
          explanation: {
            fused: 0,
            rrf: 0,
            coverage: queryCoverage(queryTokens, m),
            activation: activation(m.accessLog, m.salience, now, config.activation),
            hydrated: false,
            chain: true,
          },
        },
      );
    }
  }
  return result;
}

const TIMED_OUT = Symbol('timed-out');
const RERANK_TIMEOUT = new Error('rerank-timeout');

/** `p`, or `TIMED_OUT` after `ms` (0: no limit). A late result is dropped, never rejected. */
async function withBudget<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => {});
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((res) => {
        timer = setTimeout(() => res(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The lexical answer is clear enough to skip the query embedding when the query has at least two
 * informative words, the top lexical hit is valid now (or at `asOf`) and holds every one of them,
 * and the next hit holds clearly fewer. Dense search could only confirm such a result.
 */
async function lexicalIsConfident(
  lexical: Hit[],
  queryTokens: Set<string>,
  read: (id: string) => Promise<Memory | null>,
  now: Date,
  view: TemporalView,
): Promise<boolean> {
  if (queryTokens.size < 2) return false;
  const top = lexical[0];
  if (top === undefined) return false;
  const m = await read(top.id);
  if (m === null || !isVisible(m, now, view)) return false;
  if (queryCoverage(queryTokens, m) < 1) return false;
  const next = lexical[1];
  if (next === undefined) return true;
  const n = await read(next.id);
  if (n === null) return true;
  return queryCoverage(queryTokens, n) <= 1 - CONFIDENT_COVERAGE_GAP;
}

/**
 * Fusion is confident when the lexical top result is also the fused top, contains most of the
 * query's words, and the runner-up is clearly weaker on them. It must also be among the dense
 * top 3, unless it contains every query word. Rerank would only confirm it, at the cost of a
 * network round trip (CON-57).
 */
function isConfident(
  ordered: { id: string }[],
  lexical: Hit[],
  dense: Hit[],
  coverage: Map<string, number>,
): boolean {
  const top = ordered[0];
  if (top === undefined || lexical[0]?.id !== top.id) return false;
  const topCov = coverage.get(top.id) ?? 0;
  if (topCov < CONFIDENT_COVERAGE) return false;
  const denseAgrees = dense.slice(0, 3).some((h) => h.id === top.id);
  if (!denseAgrees && topCov < 1) return false;
  const second = ordered[1];
  if (second === undefined) return true;
  return (coverage.get(second.id) ?? 0) <= topCov - CONFIDENT_COVERAGE_GAP;
}

const ymd = (iso: string): string => iso.slice(0, 10);

/** How a memory is dated in the block: its age when current, else the interval it held. */
function when(m: Memory, now: Date): string {
  if (isCurrent(m, now)) return age(m.validFrom, now);
  const span = `${ymd(m.validFrom)} to ${m.validTo === null ? 'now' : ymd(m.validTo)}`;
  return m.endReason === 'corrected' ? `${span}, later corrected` : span;
}

function age(validFrom: string, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(validFrom)) / 86_400_000));
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Render recalled memories as an `<oort-memory>` block, whole lines only, within `budgetChars`.
 * Each memory's text is scrubbed again (spec §6.2, Stage 0): the last line of defence for a
 * memory stored before a rule existed, written by another tool, or missed by a regression.
 */
export function formatForInjection(r: RecallResult, budgetChars: number, now = new Date()): string {
  if (r.memories.length === 0) return '';
  const open = '<oort-memory>\n';
  const close = '\n</oort-memory>';
  let total = open.length + close.length;
  const lines: string[] = [];
  for (const m of r.memories) {
    const note =
      m.explanation.stale === true
        ? ` (may be outdated; last confirmed ${age(lastConfirmed(m), now)})`
        : '';
    const line = `- [${m.type}, ${when(m, now)}] ${scrub(m.text).text}${note}`;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (total + cost > budgetChars) break;
    lines.push(line);
    total += cost;
  }
  if (lines.length === 0) return '';
  return open + lines.join('\n') + close;
}
