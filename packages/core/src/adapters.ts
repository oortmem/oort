import type { Grant } from './grant.js';
import type { LinkOptions, LinkResult, LinksOf, UnlinkResult } from './links.js';
import type { Decision, Memory, MemoryType, Scope, Tier } from './model.js';
import type { Place, SpatialFilter } from './place.js';

/**
 * The adapter seam. Every pluggable piece of Oort (stores, embedders, rerankers,
 * System One controllers, System Two writers) implements one of the five
 * interfaces below; the engine only ever talks to these.
 */

/** One harness turn, as seen by the write path. */
export interface Observation {
  userText: string;
  assistantText: string;
  /** Structured tool-call summaries (file edits, exit codes, API responses). */
  toolSummaries: string[];
  sessionId?: string;
  turnRef?: string;
  projectId?: string;
  /** ISO timestamp of the turn. */
  at: string;
  /**
   * Where the turn's facts are (CON-84): every memory the turn writes carries it, and a REFINE
   * gives it to the memory it rewrites. Checked with `checkPlace` before anything is written.
   */
  place?: Place;
}

/** Stage A: should this turn be stored, how salient is it, what type(s). */
export interface GateDecision {
  /** Probability in [0, 1] that the turn holds something worth storing. */
  shouldStore: number;
  /** Initial salience in [0, 1]. */
  salience: number;
  /** Probability per memory type; absent types are treated as 0. */
  types: Partial<Record<MemoryType, number>>;
  /**
   * Probability that the fact is likely to change within weeks (a status, a current version).
   * Optional; a controller that sets it also records a `gate`/`volatile` decision, which is how
   * the stored memory remembers it.
   */
  volatile?: number;
  decisions: Decision[];
}

/**
 * Stage C actions (CON-49). REFINE adds detail to the same fact and rewrites it in place.
 * SUPERSEDE means the situation changed: the old fact was true until the new one starts.
 * CORRECT means the old fact was wrong from the start: it is retracted in transaction time and
 * the correction takes its place in valid time. UPDATE is the earlier name for REFINE.
 */
export type ReconcileAction =
  'NOOP' | 'REINFORCE' | 'ADD' | 'REFINE' | 'SUPERSEDE' | 'CORRECT' | 'UPDATE';

/** Stage C: what to do with the observation relative to one candidate. */
export interface ReconcileDecision {
  /** The existing memory this decision concerns; `null` for a standalone ADD. */
  candidateId: string | null;
  action: ReconcileAction;
  probability: number;
  decisions: Decision[];
}

/**
 * Which memories a read may see. Scope filtering is the isolation boundary:
 * every store enforces it internally; callers never post-filter.
 */
export interface ScopeFilter {
  orgId: string;
  customerId: string;
  agentId: string;
  /** Project ids this read may see; `null` means global memories (no project). */
  projectIds: (string | null)[];
}

export interface Hit {
  id: string;
  /** Store-specific relevance; only comparable within one result list. */
  score: number;
  /** The memory's current tier. */
  tier: Tier;
}

/** True iff a memory with `scope` is visible through `filter`. */
export function scopeMatches(scope: Scope, filter: ScopeFilter): boolean {
  return (
    scope.orgId === filter.orgId &&
    scope.customerId === filter.customerId &&
    scope.agentId === filter.agentId &&
    filter.projectIds.includes(scope.projectId ?? null)
  );
}

/**
 * The outcome of a guarded write. A guarded write is computed from snapshots
 * (records as read from the store, e.g. by `list`) and applies to a record
 * only while it still matches its snapshot: it exists, with the same
 * `updatedAt` and the same `tier`. Anything else means another writer got
 * there first (a supersede, a forget, another consolidation), so the record
 * is left exactly as it is and its id is listed in `skipped`.
 */
export interface GuardedWriteResult {
  skipped: string[];
}

/**
 * The storage contract. Every method takes a `Grant` first and enforces it
 * inside the store: reads see only `grant.read`, changes touch only
 * `grant.write`, and cursors belong to the grant's principal. An id outside
 * the grant behaves exactly like an unknown id (null, false, skipped or a
 * silent no-op), so a caller learns nothing about records it cannot see.
 * Callers never post-filter.
 */
/** Filters and shape for `MemoryStore.list`. */
export interface ListOptions {
  tier?: Tier;
  validOnly?: boolean;
  /** true: pinned memories only. */
  pinned?: boolean;
  /** false: skip reading embeddings (default true). */
  embeddings?: boolean;
}

/** Options of `MemoryStore.lexical` and `dense`. */
export interface SearchOptions {
  /**
   * Keep only memories that pass this filter (CON-84), applied inside the search before `k` is
   * taken, like the grant. Only a store with `spatial: true` takes it; recall never passes one to
   * another store.
   */
  spatial?: SpatialFilter;
}

export interface MemoryStore {
  /**
   * True when the store keeps `Memory.place` and applies `SearchOptions.spatial` (spatial memory,
   * CON-84; `spatialConformance` proves it). Absent: places are not stored and recall refuses a
   * spatial query (`SpatialUnsupportedError`) rather than return unfiltered rows.
   */
  readonly spatial?: true;
  /**
   * True when the store keeps memory relationships (CON-148; `linksConformance` proves it) and
   * has `link`, `unlink` and `linksOf`. Absent: none of the three exist, and every surface refuses
   * `link` rather than pretend it held.
   */
  readonly links?: true;
  /**
   * Links `a` and `b` explicitly, asserted by `opts.assertedBy`, and removes any block on the
   * pair. Needs `grant.write` on both, both in one node, and that node not at level `hive`;
   * anything else (an unknown id, one outside the grant, two nodes, a hive node, `a === b`)
   * resolves to null, changing nothing, exactly as for a missing id. Linking a linked pair again
   * changes nothing, except that a person's assertion (`user`) replaces an agent's.
   */
  link?(grant: Grant, a: string, b: string, opts: LinkOptions): Promise<LinkResult | null>;
  /**
   * Removes the `explicit` and `recalledWith` links between `a` and `b`. When there was no
   * explicit link, or the two share an entity or a session (a pair an index forms), it also
   * writes a `blocked` row, so nothing forms the pair again until `link` removes the block. The
   * same rules as `link`; null for anything it refuses.
   */
  unlink?(grant: Grant, a: string, b: string, opts: LinkOptions): Promise<UnlinkResult | null>;
  /**
   * The stored links of `id` whose other end `grant` reads, the blocks likewise, and how many
   * stored link rows lead to memories it cannot read. Null when `grant` does not read `id`.
   */
  linksOf?(grant: Grant, id: string): Promise<LinksOf | null>;
  /**
   * Insert or replace the memory with `m.id`. When `m.tier` is not `cold`, any
   * cold copy of `m.id` is dropped (a hydrated memory leaves no orphan blob).
   * An all-zero `m.embedding` has no direction and is not kept: the memory is
   * stored without one, so only lexical search finds it (CON-141).
   * Rejects with `GrantError`, writing nothing, when `m.scope` is outside
   * `grant.write` or a record with `m.id` already exists at another address.
   * A store with `links` rewrites the memory in place, so it keeps its links, and rewrites its
   * entity index rows (none once it is expired or superseded).
   */
  upsert(grant: Grant, m: Memory): Promise<void>;
  /**
   * `upsert` for each memory, in order, atomically: either every write lands or
   * none does (a rejection, a `GrantError` included, leaves the store as it
   * was). Used where several records must change together, e.g. a supersede.
   */
  upsertMany(grant: Grant, ms: Memory[]): Promise<void>;
  /**
   * `upsertMany`, then `link` for each pair, all in one transaction: a store with `links` has it,
   * so an import never leaves memories without the links that came with them. A pair `link`
   * would refuse is skipped. Returns how many links were written.
   */
  upsertManyLinked?(
    grant: Grant,
    ms: Memory[],
    pairs: readonly (readonly [string, string])[],
    opts: LinkOptions,
  ): Promise<{ linked: number }>;
  /** The current record if it is inside `grant.read`, else null. */
  get(grant: Grant, id: string): Promise<Memory | null>;
  /**
   * Removes the memory everywhere (main record and cold copy) when it is inside
   * `grant.write`. Never throws for an unknown or out-of-grant id. A store with `links` removes
   * every link, block and entity index row of the memory in the same transaction.
   */
  forget(grant: Grant, id: string): Promise<void>;
  /**
   * Lexical search over text + stub + entities within `grant.read`. Returns
   * hot, warm and cold hits; cold memories are only guaranteed to match on stub
   * and entities. Does not filter by temporal validity (fusion does), so as-of
   * queries work. With `opts.spatial`, only memories that pass it (see `SearchOptions`).
   */
  lexical(grant: Grant, q: string, k: number, opts?: SearchOptions): Promise<Hit[]>;
  /**
   * Nearest neighbours of `v` among memories with an embedding within
   * `grant.read`, best first. Never returns cold memories. Does not filter by
   * temporal validity.
   *
   * Every implementation rejects with a `RangeError` whose message names both
   * dimensions when `v.length` differs from the store's dimension (a store
   * without a fixed dimension compares against its stored embeddings).
   * An all-zero `v` matches nothing: it resolves to `[]` (CON-141).
   * With `opts.spatial`, only memories that pass it (see `SearchOptions`).
   */
  dense(grant: Grant, v: Int8Array, k: number, opts?: SearchOptions): Promise<Hit[]>;
  /**
   * Appends an access at `at` to each listed memory's access log; unknown ids
   * and ids outside `grant.read` are ignored.
   */
  recordAccess(grant: Grant, ids: string[], at: Date): Promise<void>;
  /**
   * Listing within `grant.read`, newest `updatedAt` first. `validOnly`
   * defaults to true (only memories for which `isCurrent(m, now)` holds);
   * `tier` restricts to one tier and `pinned: true` to pinned memories (both
   * filtered in the store). `embeddings: false` leaves `embedding` unset, for
   * callers that read only text and metadata.
   */
  list(grant: Grant, opts?: ListOptions): Promise<Memory[]>;
  /**
   * Marks each snapshot's record expired: sets `expiredAt = at`, and
   * `endReason = "expired"` where it is null. No other field is written.
   * Guarded (see `GuardedWriteResult`); a record already expired, or outside
   * `grant.write`, is skipped too. Atomic per call. An empty list is a no-op.
   */
  expireMany(grant: Grant, snapshots: Memory[], at: Date): Promise<GuardedWriteResult>;
  /** `coldPutMany(grant, [snapshot])`. */
  coldPut(grant: Grant, snapshot: Memory): Promise<GuardedWriteResult>;
  /**
   * Demotes each snapshot's record to cold. The cold copy becomes the
   * snapshot (embedding included); the main record gets `tier: "cold"` and
   * loses its embedding, and no other field is written (stub and entities stay
   * lexically searchable). Guarded (see `GuardedWriteResult`); a cold snapshot,
   * or a record outside `grant.write`, is skipped too. A skipped entry leaves
   * no cold copy behind. Only the last entry for an id counts.
   *
   * Atomic per call: if any entry fails (as opposed to being skipped), none is
   * applied and every previous cold copy stays readable. Previous cold copies
   * are discarded only after the whole batch has committed. An empty list is
   * a no-op.
   */
  coldPutMany(grant: Grant, snapshots: Memory[]): Promise<GuardedWriteResult>;
  /**
   * `upsert` for each `next`, applied only while the record still matches `was` (the snapshot it
   * was computed from: same `updatedAt` and `tier`, see `GuardedWriteResult`); one that does
   * not, or is gone, is skipped and listed. The writes that apply land in one transaction.
   * Optional; `forgetMemory` uses it so a rewrite never overwrites a change made meanwhile.
   */
  upsertManyIfUnchanged?(
    grant: Grant,
    writes: { next: Memory; was: Pick<Memory, 'id' | 'updatedAt' | 'tier'> }[],
  ): Promise<GuardedWriteResult>;
  /**
   * The cold copy written by `coldPut` (a snapshot, embedding included), or
   * null, including for a record outside `grant.read`. Fields that changed
   * after `coldPut` (e.g. the access log) are not reflected; hydration should
   * take live fields from `get`.
   */
  coldGet(grant: Grant, id: string): Promise<Memory | null>;
  /**
   * Changes the tier only. With `snapshot`, guarded: applies only while the
   * record's `updatedAt` and `tier` still equal the snapshot's. Resolves true
   * when the tier was written, false for an unknown id, an id outside
   * `grant.write` or a failed guard.
   */
  setTier(
    grant: Grant,
    id: string,
    tier: Tier,
    snapshot?: Pick<Memory, 'updatedAt' | 'tier'>,
  ): Promise<boolean>;
  /** The grant principal's cursor `key` (e.g. a transcript import offset), or null when unset. */
  getCursor(grant: Grant, key: string): Promise<string | null>;
  setCursor(grant: Grant, key: string, value: string): Promise<void>;
  /**
   * Releases resources. Idempotent: closing again resolves. Every other
   * operation after `close` rejects.
   */
  close(): Promise<void>;
}

export interface Embedder {
  readonly dimension: number;
  embed(texts: string[], kind: 'query' | 'document'): Promise<Int8Array[]>;
}

export interface Reranker {
  rerank(
    query: string,
    docs: { id: string; text: string }[],
    topK: number,
  ): Promise<{ id: string; score: number }[]>;
}

/** System One: typed questions over structured state, returning calibrated probabilities. */
export interface DecisionController {
  gate(obs: Observation): Promise<GateDecision>;
  reconcile(obs: Observation, candidates: Memory[]): Promise<ReconcileDecision[]>;
  /**
   * `reconcile` for several facts in one call, in order: the result at index i answers
   * `items[i]`. Optional; observe falls back to one `reconcile` per fact.
   */
  reconcileMany?(
    items: { obs: Observation; candidates: Memory[] }[],
  ): Promise<ReconcileDecision[][]>;
  /**
   * Judgment memory (CON-71): which verdict the expert behind `req.precedents` would most likely
   * give `req.item`, as a choice over `req.verdicts` with a probability per verdict. Optional; a
   * controller without it leaves judging at precedents only.
   */
  judge?(req: JudgeRequest): Promise<JudgeChoice>;
  /**
   * The read path's adaptive stop (CON-17, 0.9.0 or newer): the probability that the reranked
   * live memories already answer `req.query`, so recall need not widen into the cold memories
   * whose stubs also matched (and hydrate them). Optional; without it recall decides with a rule
   * in code (see `RecallResult.adaptiveStop`).
   */
  sufficient?(req: SufficiencyRequest): Promise<SufficiencyDecision>;
}

/** What `DecisionController.sufficient` is asked. */
export interface SufficiencyRequest {
  /** The query as recall searched for it (scrubbed, temporal words removed). */
  query: string;
  /** The reranked hot and warm memories recall would return, best first. Never empty. */
  memories: { id: string; text: string; score?: number }[];
  /** The cold memories that also passed the relevance gate: their stubs only. Never empty. */
  cold: { id: string; stub: string }[];
}

/** The controller's answer: how likely `memories` alone answer the query. */
export interface SufficiencyDecision {
  probability: number;
  decisions: Decision[];
}

/** One past decision as the controller sees it: the expert's reason verbatim. */
export interface JudgePrecedent {
  subject: string;
  ref?: string;
  verdict: string;
  reason: string;
  criteria: string[];
  decidedAt: string;
  /** How close it is to the item, 0 to 1 (dense cosine, or lexical overlap). */
  similarity: number;
}

/** What `DecisionController.judge` is asked. */
export interface JudgeRequest {
  item: { summary: string; details?: string; ref?: string; domain?: string };
  /** The verdicts to choose from; the precedents' own verdicts are among them. */
  verdicts: string[];
  /** Nearest first. Never empty. */
  precedents: JudgePrecedent[];
}

/** The controller's answer: the likeliest verdict, its probability, and every verdict's. */
export interface JudgeChoice {
  verdict: string;
  probability: number;
  probabilities: Record<string, number>;
  decisions: Decision[];
}

/** One memory as the writer authors it. */
export interface WrittenMemory {
  text: string;
  stub: string;
  entities: string[];
  type: MemoryType;
}

/** System Two: authors the de-contextualised claim and its stub in one call. */
export interface MemoryWriter {
  write(
    obs: Observation,
    action: 'ADD' | 'UPDATE' | 'SUPERSEDE',
    prior?: Memory,
  ): Promise<WrittenMemory>;
  /**
   * The observation as 1 to `max` separate memories, one fact each, in one call. Optional;
   * when present, observe writes first and reconciles each memory on its own (CON-56).
   */
  writeMany?(obs: Observation, max: number): Promise<WrittenMemory[]>;
  /**
   * `memory` restated as its current fact only, without history or earlier values ("The port
   * changed from 3000 to 8080" becomes "The port is 8080"), in its own words and language; a
   * memory with no history comes back unchanged. It is given this memory alone (CON-144):
   * `forgetMemory` calls it for the later memories that restate a forgotten one, never sends the
   * forgotten one, and keeps the answer only when it adds no word. Optional; without it,
   * `forgetMemory` reports those memories.
   */
  rewriteCurrent?(memory: Memory): Promise<WrittenMemory>;
}
