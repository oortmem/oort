import type { Decision, Memory, MemoryType, Scope, Tier } from './model.js';

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
}

/** Stage A: should this turn be stored, how salient is it, what type(s). */
export interface GateDecision {
  /** Probability in [0, 1] that the turn holds something worth storing. */
  shouldStore: number;
  /** Initial salience in [0, 1]. */
  salience: number;
  /** Probability per memory type; absent types are treated as 0. */
  types: Partial<Record<MemoryType, number>>;
  decisions: Decision[];
}

export type ReconcileAction = 'NOOP' | 'REINFORCE' | 'ADD' | 'UPDATE' | 'SUPERSEDE';

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

export interface MemoryStore {
  /** Insert or replace the memory with `m.id`. */
  upsert(m: Memory): Promise<void>;
  /** The current record, or null. Unscoped: callers obtain ids from scoped reads. */
  get(id: string): Promise<Memory | null>;
  /** Removes the memory everywhere (main record and cold copy). Never throws for an unknown id. */
  forget(id: string): Promise<void>;
  /**
   * Lexical search over text + stub + entities, scoped. Returns hot, warm and
   * cold hits; cold memories are only guaranteed to match on stub and entities.
   * Does not filter by temporal validity (fusion does), so as-of queries work.
   */
  lexical(q: string, scope: ScopeFilter, k: number): Promise<Hit[]>;
  /**
   * Nearest neighbours of `v` among scoped memories with an embedding, best
   * first. Never returns cold memories. Does not filter by temporal validity.
   *
   * Every implementation rejects with a `RangeError` whose message names both
   * dimensions when `v.length` differs from the store's dimension (a store
   * without a fixed dimension compares against its stored embeddings).
   */
  dense(v: Int8Array, scope: ScopeFilter, k: number): Promise<Hit[]>;
  /** Appends an access at `at` to each listed memory's access log; unknown ids are ignored. */
  recordAccess(ids: string[], at: Date): Promise<void>;
  /**
   * Scoped listing, newest `updatedAt` first. `validOnly` defaults to true
   * (only `validTo === null`); `tier` restricts to one tier.
   */
  list(scope: ScopeFilter, opts?: { tier?: Tier; validOnly?: boolean }): Promise<Memory[]>;
  /**
   * Demotes `m` to cold: stores the full record (embedding included) as the
   * cold copy, and replaces the main record with `m` minus its embedding and
   * with `tier: "cold"`. Stub and entities stay lexically searchable.
   */
  coldPut(m: Memory): Promise<void>;
  /**
   * The cold copy written by `coldPut` (a snapshot, embedding included), or
   * null. Fields that changed after `coldPut` (e.g. the access log) are not
   * reflected; hydration should take live fields from `get`.
   */
  coldGet(id: string): Promise<Memory | null>;
  /** Changes the tier only; unknown ids are ignored. */
  setTier(id: string, tier: Tier): Promise<void>;
  /** A stored cursor (e.g. a transcript import offset), or null when unset. */
  getCursor(key: string): Promise<string | null>;
  setCursor(key: string, value: string): Promise<void>;
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
}

/** System Two: authors the de-contextualised claim and its stub in one call. */
export interface MemoryWriter {
  write(
    obs: Observation,
    action: 'ADD' | 'UPDATE' | 'SUPERSEDE',
    prior?: Memory,
  ): Promise<{ text: string; stub: string; entities: string[]; type: MemoryType }>;
}
