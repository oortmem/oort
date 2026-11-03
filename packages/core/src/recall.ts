import type { Embedder, Hit, MemoryStore, Reranker, ScopeFilter } from './adapters.js';
import type { ResolvedConfig } from './config.js';
import { activation } from './activation.js';
import { fuse } from './fusion.js';
import { scrub } from './scrub.js';
import type { Memory } from './model.js';

export interface RecallQuery {
  text: string;
  scope: ScopeFilter;
  budgetChars?: number;
  /** ISO timestamp: recall what was true then. */
  asOf?: string;
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
    activation: number;
    hydrated: boolean;
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
  /** Reading or promoting a cold copy failed: those memories stay cold, unhydrated. */
  | 'hydrate-failed';

export interface RecallResult {
  memories: RecalledMemory[];
  /** Reserved for the hook layer (gate decision); `recall` never sets it. */
  skipped?: string;
  degraded?: Degradation[];
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
  // Scrub once: the query text reaches embedders and rerankers, which may be remote.
  const text = scrub(q.text).text;
  const now = deps.now ?? new Date();
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

  let vector: Int8Array | undefined;
  if (!deps.embed) {
    degraded.push('no-embedder');
  } else {
    const t = clock();
    try {
      vector = (await deps.embed.embed([text], 'query'))[0];
      if (vector === undefined) degraded.push('embed-failed');
    } catch {
      degraded.push('embed-failed');
    }
    timings['embedMs'] = clock() - t;
  }

  const timed = async <T>(key: string, p: () => Promise<T>): Promise<T> => {
    const t = clock();
    try {
      return await p();
    } finally {
      timings[key] = clock() - t;
    }
  };
  const v = vector;
  const [lexical, dense] = await Promise.all([
    timed('lexicalMs', () => store.lexical(text, q.scope, config.recall.lexicalK)),
    v === undefined
      ? Promise.resolve<Hit[]>([])
      : timed('denseMs', () =>
          store.dense(v, q.scope, config.recall.denseK).catch((): Hit[] => {
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
      const live = await store.get(id);
      if (live === null) return null;
      if (live.tier !== 'cold' && !coldIds.has(id)) return live;
      try {
        const blob = await store.coldGet(id);
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
        await store.upsert(hydrated);
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
  const fused = fuse([lexical, dense], memories, now, {
    activation: config.activation,
    ...(q.asOf !== undefined ? { asOf: q.asOf } : {}),
  });
  timings['fuseMs'] = clock() - tf;

  let ordered = fused.slice(0, config.recall.rerankK);
  const rerankScores = new Map<string, number>();
  if (!deps.rerank) {
    degraded.push('no-reranker');
  } else if (ordered.length > 0) {
    const tr = clock();
    try {
      const docs = ordered.map((f) => ({ id: f.id, text: memories.get(f.id)?.text ?? '' }));
      const reranked = await deps.rerank.rerank(text, docs, config.recall.returnK);
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
    } catch {
      degraded.push('rerank-failed');
      rerankScores.clear();
    }
    timings['rerankMs'] = clock() - tr;
  }

  const out: RecalledMemory[] = [];
  for (const f of ordered.slice(0, config.recall.returnK)) {
    const m = memories.get(f.id);
    if (m === undefined) continue;
    const lr = lexical.findIndex((h) => h.id === f.id);
    const dr = dense.findIndex((h) => h.id === f.id);
    const rs = rerankScores.get(f.id);
    out.push({
      ...m,
      explanation: {
        ...(lr >= 0 ? { lexicalRank: lr + 1 } : {}),
        ...(dr >= 0 ? { denseRank: dr + 1 } : {}),
        fused: f.score,
        rrf: f.rrf,
        ...(rs !== undefined ? { reranked: rs } : {}),
        activation: activation(m.accessLog, m.salience, now, config.activation),
        hydrated: hydratedIds.has(f.id),
      },
    });
  }

  await store.recordAccess(
    out.map((m) => m.id),
    now,
  );
  timings['totalMs'] = clock() - t0;
  return { memories: out, ...(degraded.length > 0 ? { degraded } : {}), timings };
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
    const line = `- [${m.type}, ${age(m.validFrom, now)}] ${scrub(m.text).text}`;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (total + cost > budgetChars) break;
    lines.push(line);
    total += cost;
  }
  if (lines.length === 0) return '';
  return open + lines.join('\n') + close;
}
