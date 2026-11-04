import type { Grant } from './grant.js';
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
export interface MemoryStore {
  /**
   * Insert or replace the memory with `m.id`. When `m.tier` is not `cold`, any
   * cold copy of `m.id` is dropped (a hydrated memory leaves no orphan blob).
   * Rejects with `GrantError`, writing nothing, when `m.scope` is outside
   * `grant.write` or a record with `m.id` already exists at another address.
   */
  upsert(grant: Grant, m: Memory): Promise<void>;
  /**
   * `upsert` for each memory, in order, atomically: either every write lands or
   * none does (a rejection, a `GrantError` included, leaves the store as it
   * was). Used where several records must change together, e.g. a supersede.
   */
  upsertMany(grant: Grant, ms: Memory[]): Promise<void>;
  /** The current record if it is inside `grant.read`, else null. */
  get(grant: Grant, id: string): Promise<Memory | null>;
  /**
   * Removes the memory everywhere (main record and cold copy) when it is inside
   * `grant.write`. Never throws for an unknown or out-of-grant id.
   */
  forget(grant: Grant, id: string): Promise<void>;
  /**
   * Lexical search over text + stub + entities within `grant.read`. Returns
   * hot, warm and cold hits; cold memories are only guaranteed to match on stub
   * and entities. Does not filter by temporal validity (fusion does), so as-of
   * queries work.
   */
  lexical(grant: Grant, q: string, k: number): Promise<Hit[]>;
  /**
   * Nearest neighbours of `v` among memories with an embedding within
   * `grant.read`, best first. Never returns cold memories. Does not filter by
   * temporal validity.
   *
   * Every implementation rejects with a `RangeError` whose message names both
   * dimensions when `v.length` differs from the store's dimension (a store
   * without a fixed dimension compares against its stored embeddings).
   */
  dense(grant: Grant, v: Int8Array, k: number): Promise<Hit[]>;
  /**
   * Appends an access at `at` to each listed memory's access log; unknown ids
   * and ids outside `grant.read` are ignored.
   */
  recordAccess(grant: Grant, ids: string[], at: Date): Promise<void>;
  /**
   * Listing within `grant.read`, newest `updatedAt` first. `validOnly`
   * defaults to true (only memories for which `isCurrent(m, now)` holds);
   * `tier` restricts to one tier.
   */
  list(grant: Grant, opts?: { tier?: Tier; validOnly?: boolean }): Promise<Memory[]>;
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
}
