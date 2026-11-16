import type {
  DecisionController,
  Embedder,
  Hit,
  MemoryStore,
  Reranker,
  ScopeFilter,
} from './adapters.js';
import type { ResolvedConfig } from './config.js';
import { activation } from './activation.js';
import { fuse, isVisible, type TemporalView } from './fusion.js';
import { addressOf, nodeKey, nodeOf, type NodeRef } from './address.js';
import {
  assertGrant,
  grantWrites,
  localGrant,
  narrowGrant,
  type Grant,
  type Home,
} from './grant.js';
import {
  contradicted,
  escapeLabelText,
  nodeLabel,
  nodesToRead,
  originOf,
  specificity,
  specificityFactor,
  type IncludeLevel,
  type MemoryOrigin,
} from './levels.js';
import { contestedOf, type Contested } from './feedback.js';
import { scrub } from './scrub.js';
import { isCurrent, type Memory } from './model.js';
import { episodeSession, type NeighbourKind } from './links.js';
import {
  checkSpatialFilter,
  hasSpatialFilter,
  matchesSpatial,
  placeDistance,
  SpatialUnsupportedError,
  type NearQuery,
  type SpatialFilter,
} from './place.js';
import { rangeWordsOut, temporalIntent, type RecallMode, type TimeShape } from './temporal.js';
import { PART_MIN_WORDS, PART_RERANK_FLOOR, subQueries } from './subqueries.js';
import { isEnumeration, spreadAcrossSources } from './enumeration.js';
import { formatRange, queryRange, type TimeRange } from './event-time.js';
import { readOccurrences, timeBoosted, timeList, timeScore } from './time-channel.js';
import { isStale, lastConfirmed } from './volatile.js';
import {
  CONFIDENT_COVERAGE,
  CONFIDENT_COVERAGE_GAP,
  informativeTokens,
  queryCoverage,
} from './relevance.js';

export interface RecallQuery {
  text: string;
  /**
   * Who recalls, as a pre-level filter: read with `localGrant(scope, { home })`, the person's
   * Planet plus this agent's own Star in these projects. Required unless `grant` is given.
   */
  scope?: ScopeFilter;
  /** The grant to read with, instead of one built from `scope` (multi-node grants, tests). */
  grant?: Grant;
  /** With `scope`: where this agent's memories land (`star` for an agent configured as a Star). */
  home?: Home;
  /**
   * Which levels to read (spec 7.1), intersected with the grant. A level the grant does not cover
   * rejects with `ScopeDeniedError`. Default: every node the grant reads.
   */
  include?: IncludeLevel[];
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
  /** Also return withdrawn judgments (CON-71), in any mode. Default false. */
  includeWithdrawn?: boolean;
  /**
   * Only memories whose place path contains this path, as whole segments (CON-84): `room:B`
   * keeps `site:hq/room:B/shelf:B3`, never `room:B2`. Filters inside the store, before k.
   */
  within?: string;
  /**
   * Only memories within `radius` metres of `pose` on the same map and frame (CON-84). Distance is
   * to the memory's region (0 inside it). Filters inside the store, before k. With `within`, both
   * must hold. Either needs a store with `spatial: true`, or recall rejects.
   */
  near?: NearQuery;
  /**
   * One hop along links (CON-149). `false`: take none, whatever the config says (the prompt
   * hook's `fast` and `lexical` modes). `true`: follow every kind for this recall, as with
   * `recall.links.enabled`. Default: the config (`recall.userLinks`, `recall.links`).
   */
  links?: boolean;
}

/** How a link brought a memory into a recall: the kind, the returned memory it came from. */
export interface RecallVia {
  kind: NeighbourKind;
  /** The id of the returned memory the link was followed from. */
  from: string;
  /** How strongly the links pointed at it, from 0 to 1, counting only what the reader may read. */
  weight: number;
}

/** The temporal view a recall used, and whether it was read from the query. */
export interface RecallTemporal {
  mode: RecallMode;
  asOf?: string;
  knownAt?: string;
  inferred: boolean;
  /**
   * The past time the query names, when it was read from the query. Recall ranked by it
   * (the time channel) and did not filter by it, unless `shape` is `state` (then `as-of` its end).
   */
  range?: TimeRange;
  /** What the query asks about `range`: `range`, `order`, `duration`, `count` or `state`. */
  shape?: TimeShape;
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
    /** Its 1-based rank in the time channel's list, when the query named a time. */
    timeRank?: number;
    /** How well when it happened fits the query's time, 0 to 1 (`timeScore`), with `timeRank`. */
    time?: number;
    activation: number;
    hydrated: boolean;
    /** History mode: found by walking the supersede chain, not by the search. */
    chain?: true;
    /** A volatile fact nobody confirmed within `recall.staleAfterDays`. */
    stale?: true;
    /**
     * A person said it is wrong or out of date (an open `wrong` or `stale` feedback): the
     * newest such feedback. It ranks as before; the label says it is contested.
     */
    contested?: Contested;
    /** With a spatial filter (CON-84): the memory's place path, when it has one. */
    placePath?: string;
    /** With `near` (CON-84): metres from the query point to the memory's region. */
    distanceM?: number;
    /**
     * Set on the best match for one part of a question about several things: the part's
     * number in `RecallResult.subQueries`, from 1. Such a memory keeps a place in the top k.
     */
    part?: number;
    /**
     * Set when the search did not return this memory and a link from a returned one did
     * (CON-149). It passed the same relevance gate as a hit; its text is no more trusted.
     */
    via?: RecallVia;
  };
  /** Where it came from: level, node, author, and whether a narrower memory overrides it. */
  origin?: MemoryOrigin;
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
  | 'hydrate-failed'
  /** Recording the access failed: the results stand, but their activation was not bumped. */
  | 'access-failed'
  /** The adaptive stop's question failed: recall widened into the cold matches, as without it. */
  | 'stop-failed'
  /** Following links took longer than `recall.links.budgetMs` (or failed): some were not read. */
  | 'links-skipped'
  /** The store's range read for the time channel failed: it ranked only what the searches found. */
  | 'time-failed'
  /** Reading open feedback failed: memories a person contested may be shown without the label. */
  | 'contested-failed';

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
  /**
   * The parts of a question about several things, each searched beside the whole question:
   * "which did I buy first, the desk or the chair?" gives two. Absent when the query was not
   * split.
   */
  subQueries?: string[];
  /** The nodes this recall read, as labels show them (`your Planet`, `Star cursor`). */
  read?: string[];
  /**
   * The adaptive stop (CON-17), when it was asked: cold memories passed the gate beside live
   * ones. `stopped`: the live set was enough, so the `cold` matches were left out and nothing was
   * hydrated. `by`: the decision model (`probability` is its answer) or the rule in code.
   */
  adaptiveStop?: { stopped: boolean; by: 'decide' | 'rule'; cold: number; probability?: number };
  /** The spatial filter this recall applied (CON-84), when it had one. */
  spatial?: SpatialFilter;
  timings: Record<string, number>;
}

export interface RecallDeps {
  store: MemoryStore;
  embed?: Embedder;
  rerank?: Reranker;
  /** Answers the adaptive stop's question with `recall.adaptiveStop: 'decide'`. */
  decide?: DecisionController;
  config: ResolvedConfig;
  now?: Date;
}

const clock = (): number => performance.now();

/**
 * Hybrid recall: lexical + dense first stage, activation-aware fusion, optional
 * rerank, relevance gate, then (only for what is returned, within `budgetChars`
 * when set) cold hydration and the access record. One bounded hop along links
 * (CON-149) may add at most `recall.links.admit` memories beside the hits, each
 * through the same gate as a hit and marked `explanation.via`. Adapter failures degrade,
 * never throw; so do store failures in the dense search, in cold hydration and
 * in the access record (with the reason in `degraded`). The lexical search is
 * the floor: its failure rejects.
 */
export async function recall(q: RecallQuery, deps: RecallDeps): Promise<RecallResult> {
  const { store, config } = deps;
  // Checked before anything is read: a bad filter is the caller's error, and a store that cannot
  // filter would silently return every place (CON-84).
  const spatialQ =
    q.within === undefined && q.near === undefined
      ? undefined
      : checkSpatialFilter({
          ...(q.within !== undefined && { within: q.within }),
          ...(q.near !== undefined && { near: q.near }),
        });
  const spatial = hasSpatialFilter(spatialQ) ? spatialQ : undefined;
  if (spatial !== undefined && store.spatial !== true) throw new SpatialUnsupportedError();
  // Passed only with a filter, so a store from before spatial memory sees the calls it knows.
  const searchOpts = spatial === undefined ? [] : ([{ spatial }] as const);
  const full = grantOf(q);
  // The nodes to read: the grant intersected with `include` (a level it lacks rejects here,
  // before anything is read). Recall reads and hydrates only inside them; the store enforces it.
  const nodes = nodesToRead(full, q.include);
  const grant = narrowGrant(full, nodes);
  // First stage per node (spec 7.2), then nodes merged by fused score. One node: today's recall.
  const legs = nodes.map((n) => ({ node: n, grant: narrowGrant(full, [n]) }));
  const epsilon = config.recall.specificityPrior;
  const now = deps.now ?? new Date();
  // Scrub once: the query text reaches embedders and rerankers, which may be remote. Temporal
  // words ("on 2 April", "changed over time") pick the view and are not searched for.
  const said = scrub(q.text).text;
  const { view, temporal, text: asked, fast } = viewFor(q, said, now);
  if (q.includeWithdrawn === true) view.includeWithdrawn = true;
  // The time channel: a past time read from the query ranks, and never filters.
  const timeRange =
    temporal.inferred && view.mode === 'current' && config.recall.timeChannel
      ? temporal.range
      : undefined;
  if (timeRange === undefined && view.mode === 'current') {
    // Channel off: nothing was ranked by the range, so the result does not claim one.
    delete temporal.range;
    delete temporal.shape;
  }
  // A range keeps every word for the reranker to read. Without a reranker, the words that name it
  // ("last Saturday", "a week ago") are in no memory: they are not searched for, bar the calendar
  // names among them, and do not count against a memory's coverage at the gate.
  const rangeWords = timeRange !== undefined && !deps.rerank ? fast : undefined;
  const text = rangeWords?.text ?? asked;
  // A question about two or more things: each part is searched beside the whole question, and
  // its best match keeps a place in the top k. Rules in code, no model call; a query that does
  // not split takes exactly the path it always took. The parts are read from the question as
  // asked. With a range, a part's own gate never counts the words of a past time (the one it
  // names, or what the split left of the question's): its coverage is a word count, with or
  // without a reranker. Without a reranker its search drops them too, bar calendar names. A part
  // that is only a time ("in March 2024") is no part: nothing is left to search for or to gate
  // on, and the time channel ranks by it. A reader that fails leaves the parts as split.
  let parts = subQueries(asked);
  let partForms: { text?: string; gate?: string }[] = (parts ?? []).map(() => ({}));
  if (parts !== undefined && timeRange !== undefined) {
    try {
      const whole = queryRange(asked, now)?.text;
      const forms = parts.map((p) => rangeWordsOut(p, now, whole));
      const keep = forms.map((f) => f.timeOnly !== true);
      const left = parts.filter((_, i) => keep[i]);
      parts = left.length > 0 ? left : undefined;
      partForms = forms.filter((_, i) => keep[i]);
    } catch {
      // As split, unstripped.
    }
  }
  const partSearch = (parts ?? []).map((p, i) =>
    rangeWords === undefined ? p : (partForms[i]!.text ?? p),
  );
  // Never the search text: its calendar names are not what a part is about.
  const partGate = (parts ?? []).map((p, i) => partForms[i]!.gate ?? p);
  const searches = [text, ...partSearch];
  // A question that gathers many things ("how many charity events did I go to?") spreads its top
  // k across source sessions; see `spreadAcrossSources`, below the gate. Rules in code, no model
  // call; any other query takes exactly the path it always took.
  const perSource = config.recall.enumerationPerSource;
  const enumeration = perSource > 0 && isEnumeration(said);
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

  const queryTokens = informativeTokens(rangeWords?.gate ?? text);
  // Memories read while deciding, reused below so nothing is read twice.
  const prefetched = new Map<string, Memory | null>();
  const read = async (id: string): Promise<Memory | null> => {
    if (prefetched.has(id)) return prefetched.get(id) ?? null;
    const m = await store.get(grant, id);
    prefetched.set(id, m);
    return m;
  };

  // Per search (the whole query, then each part), per node.
  const lexicalAll = timed('lexicalMs', () =>
    Promise.all(
      searches.map((s) =>
        Promise.all(
          legs.map((l) => store.lexical(l.grant, s, config.recall.lexicalK, ...searchOpts)),
        ),
      ),
    ),
  );
  const lexicalP = lexicalAll.then((all) => all[0]!);
  // A failed embed must not leave the lexical promise unobserved.
  lexicalP.catch(() => {});
  const timeP =
    timeRange === undefined
      ? undefined
      : readOccurrences(
          store,
          legs.map((l) => l.grant),
          timeRange,
          searchOpts,
        );

  // Lexical first (CON-57): when the lexical answer is already clear, skip the embedding round
  // trip. Otherwise the lexical search has run while nothing else waited on it. Not for a split
  // question: one memory holding every word cannot answer a question about two things.
  let embedSkipped: RecallResult['embedSkipped'];
  if (deps.embed && config.recall.lexicalFirst && parts === undefined) {
    const first = byRank(await lexicalP);
    if (await lexicalIsConfident(first, queryTokens, read, now, view)) {
      embedSkipped = 'lexical-confident';
    }
  }

  // One embed request for the whole query and its parts.
  let vectors: (Int8Array | undefined)[] = searches.map(() => undefined);
  if (!deps.embed) {
    degraded.push('no-embedder');
  } else if (embedSkipped === undefined) {
    const t = clock();
    try {
      const got = await deps.embed.embed(searches, 'query');
      vectors = searches.map((_, i) => got[i]);
      if (vectors[0] === undefined) degraded.push('embed-failed');
    } catch {
      degraded.push('embed-failed');
    }
    timings['embedMs'] = clock() - t;
  }

  const v = vectors[0];
  let denseFailed = false;
  const noDense = (): Hit[][] => legs.map(() => []);
  const denseFor = (x: Int8Array | undefined): Promise<Hit[][]> =>
    x === undefined
      ? Promise.resolve(noDense())
      : Promise.all(
          legs.map((l) =>
            store.dense(l.grant, x, config.recall.denseK, ...searchOpts).catch((): Hit[] => {
              denseFailed = true;
              return [];
            }),
          ),
        );
  const [lexicalAllLegs, denseAllLegs] = await Promise.all([
    lexicalAll,
    vectors.every((x) => x === undefined)
      ? Promise.resolve(vectors.map(noDense))
      : timed('denseMs', () => Promise.all(vectors.map(denseFor))),
  ]);
  if (denseFailed) degraded.push('dense-failed');
  const lexicalLegs = lexicalAllLegs[0]!;
  const denseLegs = denseAllLegs[0]!;
  const timeRead = timeP === undefined ? undefined : await timeP;
  if (timeRead?.failed === true) degraded.push('time-failed');
  // Across nodes, by rank (one node: its own list). Used where one list is needed.
  const lexical = byRank(lexicalLegs);
  const dense = byRank(denseLegs);
  // Ranks are per node: each node's first stage ranks its own memories.
  const lexicalRank = rankWithin(lexicalLegs);
  const denseRank = rankWithin(denseLegs);

  // Live rows only: a cold row keeps its text, stub and entities, which is all fusion, the gate
  // and the reranker read. Hydration waits until we know what is returned (CON-47).
  const ids = [
    ...new Set(
      [...lexicalAllLegs.flat(2), ...denseAllLegs.flat(2), ...(timeRead?.hits.flat() ?? [])].map(
        (h) => h.id,
      ),
    ),
  ];
  const loaded = await Promise.all(ids.map((id) => read(id)));
  const memories = new Map<string, Memory>();
  for (const m of loaded) if (m !== null) memories.set(m.id, m);

  const tf = clock();
  // The time channel's list per node, over what the searches and the range read found.
  const timeLegs =
    timeRange === undefined
      ? undefined
      : legs.map((_, i) => {
          const pool = new Map<string, Memory>();
          for (const h of [...lexicalLegs[i]!, ...denseLegs[i]!, ...(timeRead?.hits[i] ?? [])]) {
            const m = memories.get(h.id);
            if (m !== undefined) pool.set(h.id, m);
          }
          return timeList(pool.values(), timeRange, (m) =>
            v !== undefined && m.embedding?.length === v.length
              ? cosine(v, m.embedding)
              : queryCoverage(queryTokens, m),
          );
        });
  const timeRank = timeLegs === undefined ? new Map<string, number>() : rankWithin(timeLegs);
  // Reciprocal rank fusion within each node as before, then the nodes merged by fused score,
  // each scaled by the specificity prior (off at ε = 0). A stable sort: one node keeps its order.
  // A split question fuses every search's lists, the whole query's and each part's, at once. The
  // time list is fused once, with the whole query's lists; a part's best match comes from its own
  // lexical and dense lists alone.
  const fuseSearches = (which: number[], withTime = false) =>
    legs
      .flatMap((l, i) =>
        fuse(
          [
            ...which.flatMap((s) => [lexicalAllLegs[s]![i]!, denseAllLegs[s]![i]!]),
            ...(withTime && timeLegs !== undefined ? [timeLegs[i]!] : []),
          ],
          memories,
          now,
          { activation: config.activation, view },
        ).map((f) =>
          epsilon === 0 ? f : { ...f, score: f.score * specificityFactor(l.node, epsilon) },
        ),
      )
      .sort((x, y) => y.score - x.score);
  const fused = fuseSearches(
    searches.map((_, s) => s),
    true,
  );
  // Each part's best match: the top of its own lists, fused. It keeps a place in the top k.
  const heads = (parts ?? []).map((_, p) => fuseSearches([p + 1])[0]?.id);
  timings['fuseMs'] = clock() - tf;

  const coverage = new Map<string, number>();
  for (const f of fused) {
    const m = memories.get(f.id);
    if (m !== undefined) coverage.set(f.id, queryCoverage(queryTokens, m));
  }
  const denseScore = new Map(dense.map((h) => [h.id, h.score]));

  // One hop along links (CON-149). `all`: every kind (`recall.links.enabled`, or `links: true`).
  // `user`: only explicit links confirmed at a terminal, and only on a recall that reranks.
  const linkCfg = config.recall.links;
  const mayHop = q.links !== false && typeof store.neighbours === 'function' && linkCfg.admit > 0;
  const followAll = mayHop && (q.links === true || linkCfg.enabled);
  const followUser = mayHop && config.recall.userLinks;
  const fusedById = new Map(fused.map((f) => [f.id, f]));
  const legOf = (m: Memory): number => {
    const key = nodeKey(nodeOfMemory(m));
    return legs.findIndex((l) => nodeKey(l.node) === key);
  };
  let linksSkipped = false;
  /**
   * The memories one link away from the top `seeds` of `from` in each node, best `pool` by spread,
   * loaded and checked. Ids come from the store under each node's own grant; each memory is then
   * read under that same grant, so nothing outside it, in another node or in a hive can come back.
   */
  const gatherLinked = async (
    from: readonly { id: string; score: number }[],
    which: 'all' | 'user',
    exclude: ReadonlySet<string>,
  ): Promise<Linked[]> => {
    const tl = clock();
    try {
      const kinds: NeighbourKind[] =
        which === 'user'
          ? ['explicit']
          : (['explicit', 'episode', 'about'] as const).filter(
              (k) => linkCfg.factors[k] > 0 || (k === 'explicit' && followUser),
            );
      // Explicit links an agent wrote count only with the kind's factor above 0.
      const userOnly = which === 'user' || linkCfg.factors.explicit <= 0;
      const factor = (k: NeighbourKind): number =>
        k === 'explicit' && userOnly ? 1 : linkCfg.factors[k];
      const found = new Map<string, Linked>();
      const top = Math.max(0, ...from.map((f) => f.score));
      for (const [i, leg] of legs.entries()) {
        if (leg.node.level === 'hive') continue;
        const seeds = from
          .filter((f) => {
            const m = memories.get(f.id);
            return m !== undefined && legOf(m) === i;
          })
          .slice(0, linkCfg.seeds);
        if (seeds.length === 0 || kinds.length === 0) continue;
        const left = linkCfg.budgetMs - (clock() - tl);
        if (left <= 0) {
          linksSkipped = true;
          break;
        }
        const r = await store.neighbours!(
          leg.grant,
          seeds.map((f) => f.id),
          {
            kinds,
            ...(userOnly && { explicitBy: 'user' as const }),
            currentOnly: view.mode === 'current',
            ...(spatial !== undefined && { spatial }),
            fMax: linkCfg.fMax,
            budgetMs: left,
          },
        );
        if (r.skipped === true) linksSkipped = true;
        for (const seed of seeds) {
          const rows = r.neighbours.filter(
            (n) =>
              n.from === seed.id &&
              n.id !== seed.id &&
              kinds.includes(n.kind) &&
              Number.isFinite(n.weight) &&
              n.weight > 0,
          );
          const fanout = new Set(rows.map((n) => n.id)).size;
          const strength = top > 0 ? seed.score / top : 1;
          for (const n of rows) {
            const part = (strength * factor(n.kind) * Math.min(1, n.weight)) / fanout;
            const l: Linked = found.get(n.id) ?? { id: n.id, leg: i, spread: 0, seeds: new Map() };
            if (n.kind === 'explicit' && n.assertedBy === 'user') l.byUser = true;
            if (l.leg !== i) continue;
            l.spread += part;
            const was = l.seeds.get(seed.id);
            if (was === undefined || part > was.part) l.seeds.set(seed.id, { part, kind: n.kind });
            found.set(n.id, l);
          }
        }
      }
      const best = [...found.values()]
        .filter((l) => !exclude.has(l.id))
        // At equal spread a link confirmed at a terminal goes first, so links an agent wrote on
        // the same memory cannot keep it out of the pool.
        .sort(
          (x, y) =>
            y.spread - x.spread ||
            Number(y.byUser === true) - Number(x.byUser === true) ||
            (x.id < y.id ? -1 : 1),
        )
        .slice(0, linkCfg.pool);
      const loaded: Linked[] = [];
      for (const l of best) {
        const leg = legs[l.leg]!;
        const m = await store.get(leg.grant, l.id);
        if (m === null || !isVisible(m, now, view)) continue;
        if (addressOf(m).level === 'hive' || legOf(m) !== l.leg) continue;
        if (spatial !== undefined && !matchesSpatial(m, spatial)) continue;
        memories.set(m.id, m);
        coverage.set(m.id, queryCoverage(queryTokens, m));
        loaded.push(l);
      }
      return loaded;
    } catch {
      // A store that cannot answer costs the linked memories, never the recall.
      linksSkipped = true;
      return [];
    } finally {
      timings['linksMs'] = (timings['linksMs'] ?? 0) + (clock() - tl);
    }
  };

  let ordered = withHeads(fused, heads, fusedById).slice(0, config.recall.rerankK);
  const rerankScores = new Map<string, number>();
  let rerankSkipped: RecallResult['rerankSkipped'];
  /** Linked memories that joined the rerank call; emptied when the rerank gives no answer. */
  let linked: Linked[] = [];
  if (!deps.rerank) {
    degraded.push('no-reranker');
  } else if (
    config.recall.skipRerankWhenConfident &&
    isConfident(ordered, lexical, dense, coverage)
  ) {
    rerankSkipped = 'confident';
  } else if (ordered.length > 0) {
    // The seeds are chosen before the rerank, so the linked memories join its one call.
    if (followAll || followUser) {
      linked = await gatherLinked(
        ordered,
        followAll ? 'all' : 'user',
        new Set(ordered.map((f) => f.id)),
      );
    }
    const tr = clock();
    try {
      const docs = [...ordered, ...linked].map((f) => ({
        id: f.id,
        text: memories.get(f.id)?.text ?? '',
      }));
      const reranked = await withBudget(
        deps.rerank.rerank(
          text,
          docs,
          // A split question asks for every score, so each part's best match has its own; with a
          // time range every score comes back, so the time boost below can reorder them; a
          // question that gathers many things needs the scores below the top `returnK` to spread
          // its top k. Else hits keep their `returnK` places: the linked memories are asked for on
          // top.
          parts !== undefined || timeRange !== undefined || enumeration
            ? docs.length
            : linked.length > 0
              ? config.recall.returnK + linkCfg.pool
              : config.recall.returnK,
        ),
        config.recall.rerankBudgetMs,
      );
      if (reranked === TIMED_OUT) throw RERANK_TIMEOUT;
      const byId = new Map(ordered.map((f) => [f.id, f]));
      const linkedIds = new Set(linked.map((l) => l.id));
      const next: typeof ordered = [];
      for (const r of reranked) {
        if (linkedIds.delete(r.id)) {
          rerankScores.set(r.id, r.score);
          continue;
        }
        const f = byId.get(r.id);
        if (f === undefined) continue;
        rerankScores.set(r.id, r.score);
        next.push(f);
        byId.delete(r.id);
      }
      if (next.length === 0) {
        // Nothing usable came back (an empty list, or only unknown ids): keep the fused order.
        degraded.push('rerank-empty');
        rerankScores.clear();
        linked = [];
      } else {
        // The time boost first, then each part's best match back in the top k: the reranker
        // scores against the whole question, which a note about one of the things asked answers
        // only in part, so it orders everything else and cannot push a part's head out.
        const boosted =
          timeRange === undefined ? next : timeBoosted(next, rerankScores, memories, timeRange);
        ordered = parts === undefined ? boosted : withHeads(boosted, heads, fusedById);
      }
    } catch (e) {
      degraded.push(e === RERANK_TIMEOUT ? 'rerank-timeout' : 'rerank-failed');
      rerankScores.clear();
      linked = [];
    }
    timings['rerankMs'] = clock() - tr;
  }

  // Relevance gate (CON-45): a reranker score when there is one, else query-word coverage or a
  // strong dense match. A threshold of 0 switches that test off.
  const { minRerankScore, minCoverage, minDenseScore } = config.recall;
  const byRerank = rerankScores.size > 0;
  const relevant = (id: string): boolean => {
    const rs = rerankScores.get(id);
    if (rs !== undefined) return rs >= minRerankScore;
    if (minCoverage === 0) return true;
    if ((coverage.get(id) ?? 0) >= minCoverage) return true;
    return minDenseScore > 0 && (denseScore.get(id) ?? -1) >= minDenseScore;
  };
  // A part's best match is judged against its part as well: it is about one of the things
  // asked, so it covers few of the whole question's words and a reranker scores it low against
  // the whole. It passes on the part's words (at least `minCoverage` of them, and at least
  // PART_MIN_WORDS) or on its closeness to the part (`minDenseScore`), and, when reranked, only
  // with a score of at least PART_RERANK_FLOOR × `minRerankScore`. One shared word, or a score
  // far below the threshold, never lets a memory in.
  const partOf = new Map<string, number>();
  heads.forEach((id, p) => {
    if (id !== undefined && !partOf.has(id)) partOf.set(id, p);
  });
  const partTokens = partGate.map((part) => informativeTokens(part));
  const partDense = (parts ?? []).map(
    (_, p) => new Map(byRank(denseAllLegs[p + 1]!).map((h) => [h.id, h.score])),
  );
  const relevantToPart = (id: string): boolean => {
    const p = partOf.get(id);
    if (p === undefined) return false;
    const rs = rerankScores.get(id);
    if (rs !== undefined && rs < minRerankScore * PART_RERANK_FLOOR) return false;
    if (minCoverage === 0) return true;
    const m = memories.get(id);
    if (m !== undefined) {
      const words = partTokens[p]!;
      const doc = informativeTokens([m.text, m.stub, ...m.entities].join(' '));
      const held = [...words].filter((t) => doc.has(t)).length;
      if (held >= PART_MIN_WORDS && queryCoverage(words, m) >= minCoverage) return true;
    }
    return minDenseScore > 0 && (partDense[p]!.get(id) ?? -1) >= minDenseScore;
  };
  // Two rules take a memory out before the top k is cut, so it never holds a place a hit that
  // passes the gate would have had (it would be dropped right after the cut):
  // 1. Time-only: a memory only the time channel found (no lexical or dense hit of any search,
  //    the whole query's or a part's) that fails the gate. A part's best match comes from its own
  //    lists, so it is never time-only.
  // 2. A failed head: a part's best match, put in the top k as one, that fails both the gate and
  //    its part's gate.
  // Every other memory is cut and gated as before. `dropped` counts all three: the two rules up
  // to the cut, and the gate after it.
  const searched = new Set([...lexicalAllLegs.flat(2), ...denseAllLegs.flat(2)].map((h) => h.id));
  const timeOnlyDropped = (id: string): boolean =>
    timeRange !== undefined && !searched.has(id) && !relevant(id);
  const headDropped = (id: string): boolean =>
    partOf.has(id) && !relevant(id) && !relevantToPart(id);
  // A question that gathers many things is gated over every candidate, not only the top k, and
  // then spread across sources and cut to `returnK`. The spread only reorders what passed the
  // gate, so a memory the gate took out never comes back. `dropped` counts what the two rules and
  // the gate took out of the first `returnK` places, as for any other query.
  const returnK = config.recall.returnK;
  const candidates: typeof ordered = [];
  let droppedEarly = 0;
  for (const f of ordered) {
    if (!enumeration && candidates.length >= returnK) break;
    if (timeOnlyDropped(f.id) || headDropped(f.id)) {
      if (candidates.length < returnK) droppedEarly++;
    } else candidates.push(f);
  }
  const passes = (f: { id: string }): boolean => relevant(f.id) || relevantToPart(f.id);
  let kept = candidates.filter(passes);
  const dropped = droppedEarly + candidates.slice(0, returnK).filter((f) => !passes(f)).length;
  if (enumeration) {
    // After the time boost and the part heads have set the order. A part's best match keeps its
    // place, whatever its source. A source is one session in one node: the same session id in
    // another node is another source. A memory with no session is a source of its own.
    kept = spreadAcrossSources(
      kept,
      (id) => {
        const m = memories.get(id);
        if (m === undefined) return undefined;
        const session = episodeSession(m);
        return session === undefined ? undefined : `${nodeKey(nodeOfMemory(m))} ${session}`;
      },
      perSource,
      returnK,
      new Set(partOf.keys()),
    );
  }

  // Linked memories never take a hit's place: at most `admit` are added beside the hits, each
  // through the gate a hit passes, and only from a hit that passed it too. They are chosen here
  // and attached after the adaptive stop, which is asked about the hits alone.
  const via = new Map<string, Linked>();
  const entryOf = (l: Linked) => fusedById.get(l.id) ?? { id: l.id, score: 0, rrf: 0 };
  let admitted: Linked[] = [];
  if (byRerank) {
    const passed = new Set(kept.map((f) => f.id));
    admitted = linked
      .filter((l) => relevant(l.id) && rerankScores.has(l.id))
      .filter((l) => [...l.seeds.keys()].some((s) => passed.has(s)))
      .sort((x, y) => rerankScores.get(y.id)! - rerankScores.get(x.id)!)
      .slice(0, linkCfg.admit);
  } else if (followAll && kept.length > 0) {
    // Without a rerank score (only with `recall.links.enabled`): the seeds are the kept hits, and
    // a linked memory needs the coverage or the dense similarity a hit needs. No embed call: the
    // similarity comes from its stored vector and the query vector already in hand.
    const found = await gatherLinked(kept, 'all', new Set(candidates.map((f) => f.id)));
    for (const l of found) {
      if (admitted.length >= linkCfg.admit) break;
      const m = memories.get(l.id);
      if (m === undefined) continue;
      if (!denseScore.has(l.id) && v !== undefined && m.embedding?.length === v.length) {
        denseScore.set(l.id, cosine(v, m.embedding));
      }
      if (relevant(l.id)) admitted.push(l);
    }
  }
  if (linksSkipped) degraded.push('links-skipped');

  // Adaptive stop (CON-17): with the live set enough, the cold matches are left out, unhydrated.
  let adaptiveStop: RecallResult['adaptiveStop'];
  if (config.recall.adaptiveStop !== 'off' && view.mode === 'current') {
    const isCold = (id: string) => memories.get(id)?.tier === 'cold';
    const live = kept.filter((f) => !isCold(f.id));
    const cold = kept.filter((f) => isCold(f.id));
    if (live.length > 0 && cold.length > 0) {
      const ask = config.recall.adaptiveStop === 'decide' ? deps.decide?.sufficient : undefined;
      let stopped = false;
      let probability: number | undefined;
      if (ask !== undefined) {
        try {
          const answer = await ask.call(deps.decide, {
            query: asked,
            memories: live.map((f) => {
              const rs = rerankScores.get(f.id);
              return {
                id: f.id,
                text: memories.get(f.id)?.text ?? '',
                ...(rs !== undefined && { score: rs }),
              };
            }),
            cold: cold.map((f) => ({ id: f.id, stub: memories.get(f.id)?.stub ?? '' })),
          });
          probability = answer.probability;
          stopped = probability >= config.recall.sufficientAt;
        } catch {
          degraded.push('stop-failed');
        }
      } else {
        stopped = liveIsEnough(kept[0]!.id, cold, isCold, coverage, queryTokens);
      }
      adaptiveStop = {
        stopped,
        by: ask !== undefined ? 'decide' : 'rule',
        cold: cold.length,
        ...(probability !== undefined && { probability }),
      };
      if (stopped) kept = live;
    }
  }
  // The stop has decided over the hits. A linked memory is attached only while a hit it was
  // reached from is still returned, and a cold one goes when the stop left the cold matches out.
  if (admitted.length > 0) {
    const hits = new Set(kept.map((f) => f.id));
    for (const l of admitted) {
      for (const s of [...l.seeds.keys()]) if (!hits.has(s)) l.seeds.delete(s);
      if (l.seeds.size === 0) continue;
      if (adaptiveStop?.stopped === true && memories.get(l.id)?.tier === 'cold') continue;
      via.set(l.id, l);
      if (!byRerank) {
        // Appended after every hit.
        kept.push(entryOf(l));
        continue;
      }
      // Merged by rerank score, after any memory that scored the same.
      const score = rerankScores.get(l.id)!;
      const at = kept.findIndex((f) => (rerankScores.get(f.id) ?? -Infinity) < score);
      kept.splice(at < 0 ? kept.length : at, 0, entryOf(l));
    }
  }

  let out: RecalledMemory[] = [];
  for (const f of kept) {
    const m = memories.get(f.id);
    if (m === undefined) continue;
    const lr = lexicalRank.get(f.id) ?? -1;
    const dr = denseRank.get(f.id) ?? -1;
    const rs = rerankScores.get(f.id);
    const ds = denseScore.get(f.id);
    const tr = timeRank.get(f.id) ?? -1;
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
        ...(tr >= 0 && timeRange !== undefined
          ? { timeRank: tr + 1, time: timeScore(m, timeRange) }
          : {}),
        activation: activation(m.accessLog, m.salience, now, config.activation),
        hydrated: false,
        ...(partOf.has(f.id) && { part: partOf.get(f.id)! + 1 }),
        ...viaOf(via.get(f.id)),
      },
      origin: originOf(m, full),
    });
  }
  out = withConflicts(out);

  let result =
    view.mode === 'history'
      ? await withChains(out, full, read, now, view, queryTokens, config)
      : out;
  for (const m of result) {
    if (isCurrent(m, now) && isStale(m, now, config.recall.staleAfterDays)) {
      m.explanation.stale = true;
    }
    if (spatial !== undefined) explainPlace(m, spatial);
  }
  // A memory a person said is wrong or out of date is labelled, never re-ranked. Before the
  // budget cut, since the label takes room in the block.
  try {
    const contested = await contestedOf(
      store,
      grant,
      result.map((m) => m.id),
    );
    for (const m of result) {
      const c = contested.get(m.id);
      if (c !== undefined) m.explanation.contested = c;
    }
  } catch {
    degraded.push('contested-failed');
  }
  // With a budget, return only what the injection block holds, so nothing cut is touched below.
  if (q.budgetChars !== undefined) result = fitForInjection(result, q.budgetChars, now).kept;
  // Touch only what is returned: the search's own hits (not chain-only versions). Cold ones that
  // are current come back to warm; a version that is no longer current is shown from its live row,
  // since consolidate would only send it back to cold.
  const returned = new Set(result.map((m) => m.id));
  const touched = new Set(out.filter((m) => returned.has(m.id)).map((m) => m.id));
  const th = clock();
  let hydrateFailed = false;
  result = await Promise.all(
    result.map(async (m): Promise<RecalledMemory> => {
      if (!touched.has(m.id) || m.tier !== 'cold' || !isCurrent(m, now)) return m;
      // Hydrating writes the memory back; a node this caller only reads (the Planet, for a Star
      // agent) is served from its live row, cold and lexical-only, and left as it is.
      if (!grantWrites(grant, m)) return m;
      try {
        const blob = await store.coldGet(grant, m.id);
        // A lost or torn blob: the memory stays cold, lexical-only.
        // TODO(Phase 2): re-embed on hydration when an embedder is present.
        if (!blob?.embedding) return m;
        const { explanation, ...live } = m;
        const hydrated: Memory = {
          ...live,
          text: blob.text,
          stub: blob.stub,
          entities: blob.entities,
          embedding: blob.embedding,
          tier: 'warm',
        };
        await store.upsert(grant, hydrated);
        return { ...hydrated, explanation: { ...explanation, hydrated: true } };
      } catch {
        hydrateFailed = true;
        return m;
      }
    }),
  );
  timings['hydrateMs'] = clock() - th;
  if (hydrateFailed) degraded.push('hydrate-failed');

  // Access drives tiering, so it is recorded for the returned memories only. A failed write (e.g.
  // SQLITE_BUSY) is reported, never a reason to lose the answer.
  if (touched.size > 0) {
    try {
      await store.recordAccess(grant, [...touched], now);
    } catch {
      degraded.push('access-failed');
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
    ...(adaptiveStop !== undefined ? { adaptiveStop } : {}),
    temporal,
    ...(parts !== undefined && { subQueries: parts }),
    read: nodes.map((n) => nodeLabel(n, full)),
    ...(spatial !== undefined && { spatial }),
    timings,
  };
}

/**
 * `list` with each part's best match (`heads`, in part order) right after the first entry, the
 * rest in their order. An id `list` lacks is taken from `all`. No heads: `list` itself.
 */
function withHeads<F extends { id: string }>(
  list: F[],
  heads: (string | undefined)[],
  all: Map<string, F>,
): F[] {
  if (heads.length === 0 || list.length === 0) return list;
  const out: F[] = [list[0]!];
  const seen = new Set([list[0]!.id]);
  const byId = new Map(list.map((f) => [f.id, f]));
  for (const id of heads) {
    if (id === undefined || seen.has(id)) continue;
    const f = byId.get(id) ?? all.get(id);
    if (f === undefined) continue;
    out.push(f);
    seen.add(id);
  }
  for (const f of list) if (!seen.has(f.id)) out.push(f);
  return out;
}

/** A memory a link leads to, before it is admitted: where it came from and how strongly. */
interface Linked {
  id: string;
  /** The node leg its seeds are in (a link never leaves a node). */
  leg: number;
  /** Σ over seeds of seed strength × kind factor × link weight ÷ the seed's fan-out. */
  spread: number;
  /** Reached by an explicit link asserted by `user`. */
  byUser?: true;
  /** Per seed: its largest single contribution, and the kind that made it. */
  seeds: Map<string, { part: number; kind: NeighbourKind }>;
}

/** `explanation.via` of an admitted linked memory: its largest contributor among what is returned. */
function viaOf(l: Linked | undefined): { via?: RecallVia } {
  if (l === undefined) return {};
  let best: [string, { part: number; kind: NeighbourKind }] | undefined;
  for (const e of l.seeds) if (best === undefined || e[1].part > best[1].part) best = e;
  if (best === undefined) return {};
  return { via: { kind: best[1].kind, from: best[0], weight: Math.min(1, l.spread) } };
}

/** Cosine similarity of two int8 vectors of one length: what a store's dense search scores by. */
function cosine(a: Int8Array, b: Int8Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The grant a query reads with: its own, or the local grant for its scope and home. */
function grantOf(q: RecallQuery): Grant {
  if (q.grant !== undefined) {
    assertGrant(q.grant);
    return q.grant;
  }
  if (q.scope === undefined) throw new TypeError('recall needs a scope or a grant');
  return localGrant(q.scope, q.home === undefined ? {} : { home: q.home });
}

/**
 * Per-node hit lists as one list, by rank: every node's first hit, then every node's second, in
 * node order. With one non-empty node it is exactly that node's list.
 */
function byRank(lists: Hit[][]): Hit[] {
  if (lists.length === 1) return lists[0]!;
  const out: Hit[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let r = 0; r < longest; r++) {
    for (const l of lists) {
      const h = l[r];
      if (h !== undefined && !seen.has(h.id)) {
        seen.add(h.id);
        out.push(h);
      }
    }
  }
  return out;
}

/** Each id's 0-based rank within its own node's list. */
function rankWithin(lists: Hit[][]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lists) {
    l.forEach((h, i) => {
      if (!out.has(h.id)) out.set(h.id, i);
    });
  }
  return out;
}

const nodeOfMemory = (m: Memory): NodeRef => nodeOf(addressOf(m));

/**
 * The conflict rule (spec 7.2), always on: when a returned memory contradicts a returned memory in
 * another node (recorded by observe as a `level`/`contradicts` decision), the narrower of the two
 * ranks first and the wider one stays, its origin naming what overrides it. Equally specific: the
 * memory that recorded the contradiction wins.
 */
function withConflicts(out: RecalledMemory[]): RecalledMemory[] {
  const byId = new Map(out.map((m) => [m.id, m]));
  const list = [...out];
  for (const m of out) {
    for (const otherId of contradicted(m)) {
      const other = byId.get(otherId);
      if (other === undefined || other === m) continue;
      const [a, b] = [nodeOfMemory(m), nodeOfMemory(other)];
      if (nodeKey(a) === nodeKey(b)) continue;
      const [winner, loser] = specificity(b) > specificity(a) ? [other, m] : [m, other];
      const iw = list.indexOf(winner);
      const il = list.indexOf(loser);
      if (iw > il) {
        list.splice(iw, 1);
        list.splice(il, 0, winner);
      }
      if (loser.origin !== undefined && winner.origin !== undefined) {
        loser.origin = {
          ...loser.origin,
          overriddenBy: { id: winner.id, node: winner.origin.node },
        };
      }
    }
  }
  return list;
}

/** The view a query asks for: explicit options first, else read from the query in code. */
function viewFor(
  q: RecallQuery,
  text: string,
  now: Date,
): {
  view: TemporalView;
  temporal: RecallTemporal;
  text: string;
  fast?: { text?: string; gate?: string };
} {
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
    if (i.range !== undefined) {
      const temporal: RecallTemporal = { ...view, inferred, range: i.range };
      if (i.shape !== undefined) temporal.shape = i.shape;
      const fast = {
        ...(i.fastText !== undefined && { text: i.fastText }),
        ...(i.fastGate !== undefined && { gate: i.fastGate }),
      };
      return { view, temporal, text: search, fast };
    }
  }
  return { view, temporal: { ...view, inferred }, text: search };
}

/** Why a memory passed the spatial filter: its place path and, with `near`, its distance. */
function explainPlace(m: RecalledMemory, f: SpatialFilter): void {
  if (m.place?.nodeId !== undefined) m.explanation.placePath = m.place.nodeId;
  const d = f.near === undefined ? undefined : placeDistance(m.place, f.near);
  if (d !== undefined) m.explanation.distanceM = d;
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
  grantFor: Grant,
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
          origin: originOf(m, grantFor),
        },
      );
    }
  }
  return result;
}

/**
 * The adaptive stop's rule, for when no decision model answers (CON-17): the live set is enough
 * when the query has at least two informative words, the top memory is live and holds every one
 * of them, and every cold match holds clearly fewer. The same test as `lexicalIsConfident`: an
 * exact lookup the live memories already answer.
 */
function liveIsEnough(
  topId: string,
  cold: { id: string }[],
  isCold: (id: string) => boolean,
  coverage: Map<string, number>,
  queryTokens: Set<string>,
): boolean {
  if (queryTokens.size < 2 || isCold(topId)) return false;
  const top = coverage.get(topId) ?? 0;
  if (top < 1) return false;
  return cold.every((f) => (coverage.get(f.id) ?? 0) <= top - CONFIDENT_COVERAGE_GAP);
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
  const { lines } = fitForInjection(r.memories, budgetChars, now);
  if (lines.length === 0) return '';
  return INJECT_OPEN + lines.join('\n') + INJECT_CLOSE;
}

const INJECT_OPEN = '<oort-memory>\n';
const INJECT_CLOSE = '\n</oort-memory>';

/**
 * The memories `formatForInjection` renders within `budgetChars`, in order, with their lines:
 * whole lines only. The search's hits are a prefix (stopping at the first that does not fit);
 * linked memories use only what the hits leave, each beside the memory it was reached from.
 */
export function fitForInjection<M extends RecalledMemory>(
  memories: M[],
  budgetChars: number,
  now = new Date(),
): { kept: M[]; lines: string[] } {
  let total = INJECT_OPEN.length + INJECT_CLOSE.length;
  let hive = 0;
  // Levels are named only when something comes from outside the reader's home node: a recall of
  // one node reads exactly as before levels existed.
  const labelled = memories.some((m) => m.origin !== undefined && !m.origin.home);
  const lineOf = (m: M): string => {
    const note =
      m.explanation.stale === true
        ? ` (may be outdated; last confirmed ${age(lastConfirmed(m), now)})`
        : '';
    return `- [${labelFor(m, labelled, now)}] ${injectableText(m.text)}${note}${contestedNote(m)}`;
  };
  const fitted = new Map<M, string>();
  // Whether `line` fits now, and if so takes its place. A line after the first costs a newline.
  // Hive memories (Constellation, Galaxy) take at most HIVE_QUOTA of the budget, so a large team
  // cannot crowd out the person's own memory.
  const take = (m: M, line: string): 'taken' | 'over-quota' | 'no-room' => {
    const cost = line.length + (fitted.size > 0 ? 1 : 0);
    const fromHive = m.origin?.level === 'hive';
    if (fromHive && hive + cost > HIVE_QUOTA * budgetChars) return 'over-quota';
    if (total + cost > budgetChars) return 'no-room';
    fitted.set(m, line);
    total += cost;
    if (fromHive) hive += cost;
    return 'taken';
  };
  // The search's own hits first, in order, stopping at the first that does not fit (a hive
  // memory past its quota is skipped, not the end of the block).
  for (const m of memories) {
    if (m.explanation.via !== undefined) continue;
    if (take(m, lineOf(m)) === 'no-room') break;
  }
  // Then memories a link brought in (CON-149), with what is left: one never takes a hit's place,
  // and is never shown without the memory it was reached from.
  const shown = new Set([...fitted.keys()].map((m) => m.id));
  for (const m of memories) {
    const from = m.explanation.via?.from;
    if (from === undefined || !shown.has(from)) continue;
    take(m, lineOf(m));
  }
  const kept = memories.filter((m) => fitted.has(m));
  const lines = kept.map((m) => fitted.get(m) as string);
  return { kept, lines };
}

/**
 * The block's note for a contested memory: ` (contested: wrong, note: "…")`. The signal comes
 * from code; the note is a person's words, scrubbed and escaped as memory text is.
 */
export function contestedNote(m: Pick<RecalledMemory, 'explanation'>): string {
  const c = m.explanation.contested;
  if (c === undefined) return '';
  const signal = c.signal === 'wrong' ? 'wrong' : 'stale';
  return c.note === undefined
    ? ` (contested: ${signal})`
    : ` (contested: ${signal}, note: "${injectableText(c.note)}")`;
}

/**
 * Memory text with any `<oort-…` or `</oort-…` tag opening written as `&lt;`, so a memory cannot
 * close the `<oort-memory>` block (or open another) and have what follows read as the prompt.
 */
/**
 * Memory text as it goes into the block: scrubbed first, then escaped. Scrubbing after escaping let
 * secrets through (escaping `[` hid an array value from the env-secret rule), so the order matters.
 * The redaction markers scrubbing adds stay readable; every other bracket is escaped.
 */
export function injectableText(text: string): string {
  return scrub(text)
    .text.split(/(\[REDACTED:[a-z0-9-]+\])/)
    .map((part, i) => (i % 2 === 1 ? part : escapeBlockTags(escapeLabelText(part))))
    .join('');
}

export function escapeBlockTags(text: string): string {
  return text.replace(/<(?=\s*\/?\s*oort-)/gi, '&lt;');
}

/** The share of an injection budget hive memories may take (spec 7.2). */
export const HIVE_QUOTA = 0.4;

/**
 * A memory's label, built by code from structured fields only: `semantic, 2d ago`, or with levels
 * named `semantic, Star cursor, 5h ago`, `, linked` when a link brought it in (CON-149), and
 * `, overridden by Star cursor` when a narrower memory in the result contradicts it. Memory text never reaches it (and its brackets are escaped).
 */
function labelFor(m: RecalledMemory, labelled: boolean, now: Date): string {
  const parts: string[] = [m.type];
  if (labelled && m.origin !== undefined) parts.push(m.origin.node);
  parts.push(when(m, now));
  // When what it tells of happened, when it states a date: the reader need not work it
  // out from "last Friday".
  const happened = (m.occurred ?? []).filter((o) => o.source !== 'mention').slice(0, 2);
  if (happened.length > 0) parts.push(`happened ${happened.map(formatRange).join(', ')}`);
  // Reached through a link, not by the search: said in the label, never with the entity's name.
  if (m.explanation.via !== undefined) parts.push('linked');
  if (m.origin?.overriddenBy !== undefined)
    parts.push(`overridden by ${m.origin.overriddenBy.node}`);
  return parts.join(', ');
}
