import { randomUUID } from 'node:crypto';
import type { Embedder, MemoryStore } from './adapters.js';
import type { Address, Author } from './address.js';
import { INVISIBLE_SOURCE } from './display.js';
import { GrantError, grantReads, grantWrites, type Grant } from './grant.js';
import {
  homePlacement,
  isAgentVia,
  judgmentField,
  JudgmentInputError,
  JUDGMENT_LIMITS,
  type JudgmentVia,
} from './judgment.js';
import { isCurrent, type Decision, type Memory, type Scope } from './model.js';
import { scrub } from './scrub.js';

/**
 * Recall feedback: a person says a recalled memory helped, was wrong, is out of date, or was not
 * relevant to a query.
 *
 * - `helped` adds `feedback.helpedAccesses` accesses at now to the memory's access log, so its
 *   activation rises as if it had been recalled that many more times. At most one applied
 *   `helped` per memory and author (`by`) per UTC day; later ones are kept, not applied.
 * - `wrong` and `stale` open a correction: recall labels the memory contested, with the signal and
 *   the note, until a person retires the memory (`retireFeedback`), supersedes it with the right
 *   fact (`supersedeFeedback`) or dismisses the feedback (`dismissFeedback`). Ranking does not
 *   change, and feedback alone never ends or deletes a memory.
 * - `irrelevant` keeps the (query, memory) pair. Recall does not use it.
 *
 * Feedback recorded by an agent (`via: 'mcp'`) is `pending`: it changes nothing (no access, no
 * label) until a person confirms it (`confirmFeedback`).
 *
 * Feedback is not a memory: it lives in the store's own feedback records (the `feedback`
 * capability), at the grant's home node, as judgments and predictions do. Forgetting a memory
 * removes every feedback row that names it, at every address.
 */

export const FEEDBACK_SIGNALS = ['helped', 'wrong', 'stale', 'irrelevant'] as const;
export type FeedbackSignal = (typeof FEEDBACK_SIGNALS)[number];

/**
 * Where a feedback row stands:
 * - `pending`: recorded by an agent; changes nothing until a person confirms it;
 * - `recorded`: a `helped` (applied or not) or an `irrelevant`, kept;
 * - `open`: a `wrong` or `stale` correction; recall labels the memory contested;
 * - `retired`: a person ended the memory; `superseded`: a person stored the right fact in its
 *   place; `dismissed`: a person set the feedback aside. These three are final.
 */
export const FEEDBACK_STATUSES = [
  'pending',
  'recorded',
  'open',
  'retired',
  'superseded',
  'dismissed',
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** How feedback was recorded: `mcp` means an agent (pending until a person confirms it). */
export type FeedbackVia = Extract<JudgmentVia, 'cli' | 'mcp' | 'sdk'>;

/** Why a `helped` was kept without adding accesses. */
export type HelpedNotAppliedReason = 'already-helped-today' | 'disabled';

export const FEEDBACK_LIMITS = Object.freeze({
  /** `note` and `query` are kept to this many characters, on one line. */
  text: 500,
  /** Pending (agent-recorded) rows one author keeps at one address; above it nothing is kept. */
  pending: 5000,
  /** A memory id. */
  memoryId: 128,
});

export const FEEDBACK_DEFAULTS = Object.freeze({
  /** Accesses one applied `helped` adds (config `feedback.helpedAccesses`). */
  helpedAccesses: 2,
});

/** One feedback record. */
export interface Feedback {
  id: string;
  /** Where it lives: the grant's home node, as for a judgment. Read with `addressOf`. */
  scope: Scope;
  address?: Address;
  author?: Author;
  /** The memory it is about. */
  memoryId: string;
  signal: FeedbackSignal;
  /** Why, in the person's words: scrubbed, one line, at most 500 characters. */
  note?: string;
  /** The query the memory was recalled for: scrubbed, one line, at most 500 characters. */
  query?: string;
  /** Who gave it. */
  by: string;
  via: FeedbackVia;
  status: FeedbackStatus;
  /** `helped` only: whether its accesses were added, and when. */
  applied?: boolean;
  appliedAt?: string;
  /** `helped` only: why it was not applied. */
  reason?: HelpedNotAppliedReason;
  /** Set when a person confirmed agent-recorded feedback. */
  confirmed?: { at: string; by: string };
  /** Set when a person retired, superseded or dismissed it. */
  resolved?: { at: string; by: string; supersededBy?: string };
  /** Raised by one on every write; the store's guard for two writers at once. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** What `MemoryStore.listFeedback` filters by. */
export interface FeedbackListOptions {
  status?: FeedbackStatus | readonly FeedbackStatus[];
  /** Only rows about one of these memories. */
  memoryIds?: readonly string[];
  signal?: FeedbackSignal;
  /** Only rows whose id starts with this. */
  idPrefix?: string;
  limit?: number;
}

/** The rows `opts` selects from `rows`, newest first (`createdAt`, then `id`). For stores. */
export function selectFeedback(
  rows: readonly Feedback[],
  opts: FeedbackListOptions = {},
): Feedback[] {
  const statuses =
    opts.status === undefined
      ? undefined
      : new Set<FeedbackStatus>(typeof opts.status === 'string' ? [opts.status] : opts.status);
  const memories = opts.memoryIds === undefined ? undefined : new Set(opts.memoryIds);
  return rows
    .filter(
      (f) =>
        (statuses === undefined || statuses.has(f.status)) &&
        (memories === undefined || memories.has(f.memoryId)) &&
        (opts.signal === undefined || f.signal === opts.signal) &&
        (opts.idPrefix === undefined || f.id.startsWith(opts.idPrefix)),
    )
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id < b.id
          ? 1
          : a.id > b.id
            ? -1
            : 0
        : a.createdAt < b.createdAt
          ? 1
          : -1,
    )
    .slice(0, opts.limit ?? Infinity);
}

/**
 * Why feedback could not be recorded, confirmed or resolved. The message never holds the
 * feedback's text. Nothing was written, unless `memoryChanged` says otherwise.
 * - `invalid`: an input problem (the message names the field);
 * - `memory-not-found`: no memory with that id in this scope;
 * - `not-found`: no feedback with that id in this scope; `ambiguous`: an id prefix that matches
 *   more than one;
 * - `not-pending`: confirming feedback a person already gave or confirmed;
 * - `not-a-correction`: retiring or superseding feedback that is not `wrong` or `stale`;
 * - `already-resolved`: it was retired, superseded or dismissed (`status` says which);
 * - `memory-ended`: the memory is no longer current, so it cannot be retired or superseded;
 * - `conflict`: it, or its memory, changed while this call ran; `status` is where it stands now;
 * - `unsupported`: the store keeps no feedback.
 */
export type FeedbackErrorKind =
  | 'invalid'
  | 'memory-not-found'
  | 'not-found'
  | 'ambiguous'
  | 'not-pending'
  | 'not-a-correction'
  | 'already-resolved'
  | 'memory-ended'
  | 'conflict'
  | 'unsupported';

export class FeedbackError extends Error {
  override readonly name = 'FeedbackError';
  constructor(
    readonly kind: FeedbackErrorKind,
    message: string,
    /** Where the feedback stands now, for `already-resolved`, `not-pending` and `conflict`. */
    readonly status?: FeedbackStatus,
    /**
     * Set when the memory was changed and could not be put back after the feedback lost a race:
     * the person should look at the memory (`oort inspect`).
     */
    readonly memoryChanged?: true,
  ) {
    super(message);
  }
}

const MESSAGES: Record<Exclude<FeedbackErrorKind, 'invalid'>, string> = {
  'memory-not-found': 'No memory with that id in this scope.',
  'not-found': 'No feedback with that id in this scope.',
  ambiguous: 'That id prefix matches more than one feedback row; give more of the id.',
  'not-pending': 'That feedback is not waiting for a confirmation.',
  'not-a-correction': 'Only wrong or stale feedback can retire or supersede a memory.',
  'already-resolved': 'That feedback was already resolved.',
  'memory-ended': 'That memory is no longer current, so it cannot be retired or superseded.',
  conflict: 'That feedback or its memory changed while this ran; nothing was changed.',
  unsupported: 'This store keeps no feedback.',
};

const fail = (
  kind: Exclude<FeedbackErrorKind, 'invalid'>,
  status?: FeedbackStatus,
  memoryChanged?: true,
): FeedbackError => {
  const now = status === undefined ? '' : ` It is ${status} now.`;
  return new FeedbackError(kind, MESSAGES[kind] + now, status, memoryChanged);
};

const invalid = (message: string): FeedbackError => new FeedbackError('invalid', message);

type FeedbackStore = Required<
  Pick<
    MemoryStore,
    'putFeedback' | 'getFeedback' | 'listFeedback' | 'purgeFeedbackFor' | 'countPendingFeedback'
  >
>;

function feedbackOf(store: MemoryStore): FeedbackStore {
  if (
    store.feedback !== true ||
    store.putFeedback === undefined ||
    store.getFeedback === undefined ||
    store.listFeedback === undefined ||
    store.purgeFeedbackFor === undefined ||
    store.countPendingFeedback === undefined
  ) {
    throw fail('unsupported');
  }
  return store as MemoryStore & FeedbackStore;
}

/** True when the store keeps feedback. */
export function keepsFeedback(store: MemoryStore): boolean {
  try {
    feedbackOf(store);
    return true;
  } catch {
    return false;
  }
}

const INVISIBLE = new RegExp(INVISIBLE_SOURCE, 'g');
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Free text as feedback keeps it: scrubbed first (a secret is recognised in its own shape), then
 * one line (invisible characters dropped, controls and line breaks as spaces, runs of spaces as
 * one), then clipped to `FEEDBACK_LIMITS.text`. Undefined when nothing is left.
 */
export function feedbackText(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw invalid(`${field} must be text`);
  const t = scrub(v).text.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (t === '') return undefined;
  return t.length > FEEDBACK_LIMITS.text ? t.slice(0, FEEDBACK_LIMITS.text).trimEnd() : t;
}

/** Who gives feedback, checked as a judgment's `by` is, then scrubbed. */
export function feedbackBy(v: unknown): string {
  try {
    return scrub(judgmentField('by', v, JUDGMENT_LIMITS.by)).text;
  } catch (e) {
    if (e instanceof JudgmentInputError) throw invalid(e.message);
    throw e;
  }
}

function memoryIdOf(v: unknown): string {
  if (typeof v !== 'string') throw invalid('memoryId must be text');
  const t = v.trim();
  if (t === '' || t.length > FEEDBACK_LIMITS.memoryId || /[\s\u0000-\u001f\u007f-\u009f]/.test(t)) {
    throw invalid(`memoryId must be a memory id (1 to ${FEEDBACK_LIMITS.memoryId} characters)`);
  }
  return t;
}

function signalOf(v: unknown): FeedbackSignal {
  if (typeof v !== 'string' || !(FEEDBACK_SIGNALS as readonly string[]).includes(v)) {
    throw invalid(`signal must be one of: ${FEEDBACK_SIGNALS.join(', ')}`);
  }
  return v as FeedbackSignal;
}

function accessesOf(n: number | undefined): number {
  const v = n ?? FEEDBACK_DEFAULTS.helpedAccesses;
  if (!Number.isInteger(v) || v < 0 || v > 10) {
    throw invalid('feedback.helpedAccesses must be a whole number from 0 to 10');
  }
  return v;
}

const dayOf = (iso: string): string => iso.slice(0, 10);

/** What a caller hands in. */
export interface FeedbackInput {
  memoryId: string;
  signal: FeedbackSignal;
  note?: string;
  /** The query the memory was recalled for. Required for `irrelevant`. */
  query?: string;
  /** Who gives it: a person's id (the operator), or an agent's. */
  by: string;
}

export interface FeedbackDeps {
  store: MemoryStore;
  grant: Grant;
  /** The acting principal's scope; the row is kept at the grant's home node. */
  scope: Scope;
  /** `mcp`: an agent, so the row is pending. */
  via: FeedbackVia;
  /** Accesses an applied `helped` adds (config `feedback.helpedAccesses`, default 2). */
  helpedAccesses?: number;
  now?: Date;
}

export type FeedbackResult =
  | {
      kept: true;
      feedback: Feedback;
      /** `helped`: the accesses were added. */
      applied?: boolean;
      /** `helped`: why they were not. */
      reason?: HelpedNotAppliedReason;
    }
  | { kept: false; reason: 'pending-cap' };

/** True when an applied `helped` by `by` for `memoryId` is already kept for `day`. */
async function helpedOn(
  s: FeedbackStore,
  grant: Grant,
  memoryId: string,
  by: string,
  day: string,
): Promise<boolean> {
  const rows = await s.listFeedback(grant, {
    memoryIds: [memoryId],
    signal: 'helped',
    status: 'recorded',
  });
  return rows.some((f) => f.applied === true && f.by === by && dayOf(f.appliedAt ?? '') === day);
}

/**
 * Applies a person's `helped` that is stored as `row` (revision `row.revision`): decides whether
 * it may add accesses today, writes that in one guarded write, then adds them. Only the call
 * whose write lands adds accesses. Returns the row as written.
 */
async function applyHelped(
  s: FeedbackStore,
  store: MemoryStore,
  grant: Grant,
  row: Feedback,
  expect: number | null,
  accesses: number,
  now: Date,
): Promise<Feedback> {
  const iso = now.toISOString();
  const reason: HelpedNotAppliedReason | undefined =
    accesses === 0
      ? 'disabled'
      : (await helpedOn(s, grant, row.memoryId, row.by, dayOf(iso)))
        ? 'already-helped-today'
        : undefined;
  const { applied: _a, appliedAt: _t, reason: _r, ...base } = row;
  const next: Feedback = {
    ...base,
    status: 'recorded',
    applied: reason === undefined,
    ...(reason === undefined ? { appliedAt: iso } : { reason }),
    revision: expect === null ? row.revision : row.revision + 1,
    updatedAt: iso,
  };
  if (!(await s.putFeedback(grant, next, { revision: expect }))) {
    const current = await s.getFeedback(grant, row.id);
    throw fail('conflict', current?.status);
  }
  if (reason === undefined) {
    await store.recordAccess(
      grant,
      Array.from({ length: accesses }, () => row.memoryId),
      now,
    );
  }
  return next;
}

/**
 * Records feedback on one memory. Everything is checked first (`FeedbackError`): the signal, the
 * memory (it must be one the grant reads), `query` for `irrelevant`, and the text. Then:
 * - by an agent (`via: 'mcp'`): kept `pending`, unless the author already keeps
 *   `FEEDBACK_LIMITS.pending` pending rows at this address (`kept: false`, `pending-cap`);
 * - `helped` by a person: kept `recorded`, and its accesses added unless one was applied for the
 *   same memory and `by` today (`applied: false`, `already-helped-today`);
 * - `wrong` or `stale` by a person: kept `open`, so recall labels the memory contested;
 * - `irrelevant` by a person: kept `recorded`.
 */
export async function recordFeedback(
  input: FeedbackInput,
  deps: FeedbackDeps,
): Promise<FeedbackResult> {
  const s = feedbackOf(deps.store);
  const now = deps.now ?? new Date();
  if (typeof input !== 'object' || input === null) throw invalid('feedback must be an object');
  const memoryId = memoryIdOf(input.memoryId);
  const signal = signalOf(input.signal);
  const note = feedbackText(input.note, 'note');
  const query = feedbackText(input.query, 'query');
  if (signal === 'irrelevant' && query === undefined) {
    throw invalid('query is required for irrelevant: the query the memory was recalled for');
  }
  const by = feedbackBy(input.by);
  const accesses = accessesOf(deps.helpedAccesses);
  const memory = await deps.store.get(deps.grant, memoryId);
  if (memory === null) throw fail('memory-not-found');
  const agent = isAgentVia(deps.via);
  const iso = now.toISOString();
  const row: Feedback = {
    id: randomUUID(),
    ...homePlacement(deps.scope, deps.grant),
    memoryId,
    signal,
    ...(note !== undefined && { note }),
    ...(query !== undefined && { query }),
    by,
    via: deps.via,
    status: agent ? 'pending' : signal === 'wrong' || signal === 'stale' ? 'open' : 'recorded',
    revision: 0,
    createdAt: iso,
    updatedAt: iso,
  };
  if (!grantWrites(deps.grant, row)) throw new GrantError();
  if (agent) {
    if ((await s.countPendingFeedback(row)) >= FEEDBACK_LIMITS.pending) {
      return { kept: false, reason: 'pending-cap' };
    }
  }
  if (!agent && signal === 'helped') {
    const done = await applyHelped(s, deps.store, deps.grant, row, null, accesses, now);
    return {
      kept: true,
      feedback: done,
      applied: done.applied === true,
      ...(done.reason !== undefined && { reason: done.reason }),
    };
  }
  if (!(await s.putFeedback(deps.grant, row, { revision: null }))) throw fail('conflict');
  return { kept: true, feedback: row };
}

/** The feedback `id` (an exact id), or `not-found`. */
export async function getFeedback(store: MemoryStore, grant: Grant, id: string): Promise<Feedback> {
  const f = await feedbackOf(store).getFeedback(grant, id);
  if (f === null) throw fail('not-found');
  return f;
}

/** The feedback `ref` names: an exact id, else a unique id prefix. */
export async function findFeedback(
  store: MemoryStore,
  grant: Grant,
  ref: string,
): Promise<Feedback> {
  const s = feedbackOf(store);
  const exact = await s.getFeedback(grant, ref);
  if (exact !== null) return exact;
  if (ref.trim() === '') throw fail('not-found');
  const matches = await s.listFeedback(grant, { idPrefix: ref, limit: 2 });
  if (matches.length > 1) throw fail('ambiguous');
  if (matches.length === 0) throw fail('not-found');
  return matches[0]!;
}

/** The feedback the grant reads, newest first, at most `limit` (default 100, at most 1000). */
export async function listFeedback(
  store: MemoryStore,
  grant: Grant,
  opts: {
    status?: FeedbackStatus | readonly FeedbackStatus[];
    memoryId?: string;
    signal?: FeedbackSignal;
    limit?: number;
  } = {},
): Promise<Feedback[]> {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 100), 1000));
  if (opts.signal !== undefined) signalOf(opts.signal);
  const statuses =
    opts.status === undefined ? [] : typeof opts.status === 'string' ? [opts.status] : opts.status;
  for (const st of statuses) {
    if (!(FEEDBACK_STATUSES as readonly string[]).includes(st)) {
      throw invalid(`status must be one of: ${FEEDBACK_STATUSES.join(', ')}`);
    }
  }
  return feedbackOf(store).listFeedback(grant, {
    ...(opts.status !== undefined && { status: opts.status }),
    ...(opts.memoryId !== undefined && { memoryIds: [opts.memoryId] }),
    ...(opts.signal !== undefined && { signal: opts.signal }),
    limit,
  });
}

/** What a person resolving feedback hands in. */
export interface ResolveFeedbackDeps {
  store: MemoryStore;
  grant: Grant;
  /** The person: the operator's id. */
  by: string;
  helpedAccesses?: number;
  now?: Date;
}

/**
 * A person confirms agent-recorded (`pending`) feedback: from then on it counts as theirs would
 * have. A `helped` adds its accesses once (unless one was applied for that memory and author
 * today), a `wrong` or `stale` opens its correction (recall labels the memory), an `irrelevant`
 * is kept. One guarded write; `conflict` when another call changed it first.
 */
export async function confirmFeedback(id: string, deps: ResolveFeedbackDeps): Promise<Feedback> {
  const s = feedbackOf(deps.store);
  const now = deps.now ?? new Date();
  const who = feedbackBy(deps.by);
  const accesses = accessesOf(deps.helpedAccesses);
  const f = await s.getFeedback(deps.grant, id);
  if (f === null) throw fail('not-found');
  if (f.status !== 'pending') throw fail('not-pending', f.status);
  if (!grantWrites(deps.grant, f)) throw new GrantError();
  const iso = now.toISOString();
  const confirmed: Feedback = { ...f, confirmed: { at: iso, by: who } };
  if (f.signal === 'helped') {
    return applyHelped(s, deps.store, deps.grant, confirmed, f.revision, accesses, now);
  }
  const next: Feedback = {
    ...confirmed,
    status: f.signal === 'irrelevant' ? 'recorded' : 'open',
    revision: f.revision + 1,
    updatedAt: iso,
  };
  if (!(await s.putFeedback(deps.grant, next, { revision: f.revision }))) {
    throw fail('conflict', (await s.getFeedback(deps.grant, id))?.status);
  }
  return next;
}

/** A row that is still waiting for a person's resolve: pending, or an open correction. */
function resolvable(f: Feedback): void {
  if (f.status === 'retired' || f.status === 'superseded' || f.status === 'dismissed') {
    throw fail('already-resolved', f.status);
  }
}

/** The row closed as `status` by `by`. */
function closed(
  f: Feedback,
  status: 'retired' | 'superseded' | 'dismissed',
  by: string,
  now: Date,
  supersededBy?: string,
): Feedback {
  const iso = now.toISOString();
  return {
    ...f,
    status,
    resolved: { at: iso, by, ...(supersededBy !== undefined && { supersededBy }) },
    revision: f.revision + 1,
    updatedAt: iso,
  };
}

/** Writes `next` over `f` (guarded); on a lost race, the state it lost to. */
async function closeRow(s: FeedbackStore, grant: Grant, f: Feedback, next: Feedback) {
  if (await s.putFeedback(grant, next, { revision: f.revision })) return undefined;
  const now = await s.getFeedback(grant, f.id);
  return now?.status ?? 'dismissed';
}

/** The correction `id` and its memory, checked before anything is written. */
async function correction(
  s: FeedbackStore,
  deps: ResolveFeedbackDeps,
  id: string,
): Promise<{ f: Feedback; m: Memory; now: Date; by: string }> {
  const now = deps.now ?? new Date();
  const by = feedbackBy(deps.by);
  const f = await s.getFeedback(deps.grant, id);
  if (f === null) throw fail('not-found');
  resolvable(f);
  if (f.signal !== 'wrong' && f.signal !== 'stale') throw fail('not-a-correction');
  if (f.status !== 'open' && f.status !== 'pending') throw fail('already-resolved', f.status);
  if (!grantWrites(deps.grant, f)) throw new GrantError();
  const m = await deps.store.get(deps.grant, f.memoryId);
  if (m === null || !grantReads(deps.grant, m)) throw fail('memory-not-found');
  if (!grantWrites(deps.grant, m)) throw new GrantError();
  return { f, m, now, by };
}

/** The decision a feedback resolve leaves on the memory it changed. */
const feedbackDecision = (question: string, f: Feedback): Decision => ({
  stage: 'feedback',
  question,
  answer: f.id,
  probability: 1,
});

/** True when an earlier, interrupted call of the same resolve already changed `m`. */
const changedBy = (m: Memory, question: string, f: Feedback): boolean =>
  m.source.decisions.some(
    (d) => d.stage === 'feedback' && d.question === question && d.answer === f.id,
  );

/**
 * Writes `writes` only while each memory is as the caller read it (`was`). With the store's
 * guarded write that is one atomic check; without it, a re-read just before writing. Returns the
 * ids skipped.
 */
async function guarded(
  store: MemoryStore,
  grant: Grant,
  writes: { next: Memory; was: Memory }[],
): Promise<string[]> {
  if (store.upsertManyIfUnchanged !== undefined) {
    return (await store.upsertManyIfUnchanged(grant, writes)).skipped;
  }
  const fresh = await Promise.all(writes.map((x) => store.get(grant, x.was.id)));
  const stale = writes.filter(
    (x, i) => fresh[i]?.updatedAt !== x.was.updatedAt || fresh[i]?.tier !== x.was.tier,
  );
  if (stale.length > 0) return stale.map((x) => x.was.id);
  await store.upsertMany(
    grant,
    writes.map((x) => x.next),
  );
  return [];
}

/** When an ended memory stops holding: now, or its own end when that already passed. */
function closeAt(m: Pick<Memory, 'validFrom' | 'validTo'>, now: Date): string {
  if (m.validTo !== null && Date.parse(m.validTo) <= now.getTime()) return m.validTo;
  return new Date(Math.max(now.getTime(), Date.parse(m.validFrom))).toISOString();
}

/** The full memory as stored: its cold copy when cold (the main row has no embedding). */
async function fullMemory(store: MemoryStore, grant: Grant, m: Memory): Promise<Memory> {
  if (m.tier !== 'cold') return m;
  return (await store.coldGet(grant, m.id)) ?? m;
}

export interface RetireResult {
  feedback: Feedback;
  /** The memory as it was ended. */
  memory: Memory;
  endReason: 'corrected' | 'expired';
}

/**
 * A person ends the memory a `wrong` or `stale` feedback names: now, with `endReason`
 * `corrected` (wrong: it never held, as observe's CORRECT retracts a prior) or `expired` (stale:
 * it held until now). The feedback closes `retired`.
 *
 * The memory is ended in one guarded write (skipped when it changed since it was read), then the
 * feedback closes in one guarded write. When that second write loses a race (another resolve
 * landed first), the memory is put back as it was and the call fails with the state it lost to;
 * if the memory changed again meanwhile it is left ended and the error says so (`memoryChanged`).
 */
export async function retireFeedback(id: string, deps: ResolveFeedbackDeps): Promise<RetireResult> {
  const s = feedbackOf(deps.store);
  const { f, m, now, by } = await correction(s, deps, id);
  const endReason = f.signal === 'wrong' ? 'corrected' : 'expired';
  const iso = now.toISOString();
  let ended: Memory = m;
  let changed = false;
  if (!changedBy(m, 'retired', f)) {
    if (!isCurrent(m, now)) throw fail('memory-ended');
    const full = await fullMemory(deps.store, deps.grant, m);
    ended = {
      ...full,
      expiredAt: iso,
      endReason,
      // Wrong: it never held, so its valid interval is left as it was (as observe's CORRECT).
      ...(endReason === 'expired' && { validTo: closeAt(m, now) }),
      updatedAt: iso,
      source: {
        ...full.source,
        decisions: [...full.source.decisions, feedbackDecision('retired', f)],
      },
    };
    const skipped = await guarded(deps.store, deps.grant, [{ next: ended, was: m }]);
    if (skipped.length > 0) throw fail('conflict', f.status);
    changed = true;
  }
  const lost = await closeRow(s, deps.grant, f, closed(f, 'retired', by, now));
  if (lost !== undefined) {
    if (!changed) throw fail('conflict', lost);
    const back = await guarded(deps.store, deps.grant, [
      { next: await fullMemory(deps.store, deps.grant, m), was: ended },
    ]).catch(() => [m.id]);
    throw back.length === 0 ? fail('conflict', lost) : fail('conflict', lost, true);
  }
  return { feedback: closed(f, 'retired', by, now), memory: ended, endReason };
}

export interface SupersedeFeedbackDeps extends ResolveFeedbackDeps {
  /** Embeds the new fact; without it (or when it fails) the new memory is kept without a vector. */
  embed?: Embedder;
  /** The harness the new memory records as its source (`cli`, `sdk`). */
  harness: string;
}

export interface SupersedeFeedbackResult {
  feedback: Feedback;
  /** The new memory, which supersedes the old one. */
  memory: Memory;
  /** The old memory's id; it ends `superseded`. */
  supersedes: string;
  /** Secret kinds redacted from the new fact before it was stored. */
  redacted: string[];
}

/**
 * A person replaces the memory a `wrong` or `stale` feedback names with the right fact, the way a
 * supersede on the write path does: a new memory in the old one's node and project (same type),
 * `supersedes` the old one, and the old one closes where the new one starts, `superseded`. The
 * fact is scrubbed first and must be one line of at most 500 characters. The feedback closes
 * `superseded`, naming the new memory.
 *
 * The new memory is written, then the old one is closed in one guarded write (when it changed
 * since it was read, the new memory is forgotten and the call fails `conflict`), then the
 * feedback closes in one guarded write. When that loses a race, both memory writes are undone
 * and the call fails with the state it lost to.
 */
export async function supersedeFeedback(
  id: string,
  fact: string,
  deps: SupersedeFeedbackDeps,
): Promise<SupersedeFeedbackResult> {
  const s = feedbackOf(deps.store);
  if (typeof fact !== 'string') throw invalid('the fact must be text');
  if (/[\r\n\u2028\u2029]/.test(fact.trim())) throw invalid('the fact must be one line');
  const scrubbed = scrub(fact.trim());
  const text = feedbackText(fact, 'fact');
  if (text === undefined) throw invalid('the fact is empty');
  if (fact.trim().length > FEEDBACK_LIMITS.text) {
    throw invalid(`the fact is longer than ${FEEDBACK_LIMITS.text} characters`);
  }
  if (scrubbed.secretRatio > 0.5) throw invalid('the fact is mostly a secret; nothing was stored');
  const { f, m, now, by } = await correction(s, deps, id);
  if (!isCurrent(m, now)) throw fail('memory-ended');
  const iso = now.toISOString();
  let embedding: Int8Array | undefined;
  try {
    embedding = (await deps.embed?.embed([text], 'document'))?.[0];
  } catch {
    embedding = undefined;
  }
  const words = new Set(text.toLowerCase().split(/[^\p{L}\p{N}._/-]+/u));
  const newId = randomUUID();
  const decision = feedbackDecision('superseded', f);
  const next: Memory = {
    id: newId,
    scope: m.scope,
    ...(m.address !== undefined && { address: m.address }),
    ...(m.author !== undefined && { author: m.author }),
    type: m.type,
    text,
    stub: text.length > 80 ? `${text.slice(0, 79)}…` : text,
    // What both are about: the old entities the new fact still names.
    entities: m.entities.filter((e) => words.has(e.toLowerCase())),
    salience: m.salience,
    pinned: m.pinned,
    tier: m.tier === 'cold' ? 'warm' : m.tier,
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom: iso,
    validTo: null,
    expiredAt: null,
    endReason: null,
    lastConfirmedAt: iso,
    supersedes: m.id,
    supersededBy: null,
    ...(m.place !== undefined && { place: structuredClone(m.place) }),
    ...(embedding !== undefined && { embedding }),
    source: { harness: deps.harness, decisions: [decision] },
    createdAt: iso,
    updatedAt: iso,
  };
  const full = await fullMemory(deps.store, deps.grant, m);
  const old: Memory = {
    ...full,
    validTo: closeAt(m, now),
    expiredAt: iso,
    endReason: 'superseded',
    supersededBy: newId,
    updatedAt: iso,
    source: { ...full.source, decisions: [...full.source.decisions, decision] },
  };
  await deps.store.upsert(deps.grant, next);
  let skipped: string[];
  try {
    skipped = await guarded(deps.store, deps.grant, [{ next: old, was: m }]);
  } catch (e) {
    await deps.store.forget(deps.grant, newId);
    throw e;
  }
  if (skipped.length > 0) {
    await deps.store.forget(deps.grant, newId);
    throw fail('conflict', f.status);
  }
  const done = closed(f, 'superseded', by, now, newId);
  const lost = await closeRow(s, deps.grant, f, done);
  if (lost !== undefined) {
    const back = await guarded(deps.store, deps.grant, [{ next: full, was: old }]).catch(() => [
      m.id,
    ]);
    if (back.length === 0) await deps.store.forget(deps.grant, newId);
    throw back.length === 0 ? fail('conflict', lost) : fail('conflict', lost, true);
  }
  return {
    feedback: done,
    memory: next,
    supersedes: m.id,
    redacted: [...new Set(scrubbed.redactions.map((r) => r.kind))],
  };
}

/**
 * A person sets feedback aside: a pending row (an agent's) or an open correction closes
 * `dismissed`, and recall stops labelling the memory. The memory is not touched. One guarded
 * write; a lost race fails with the state it lost to.
 */
export async function dismissFeedback(id: string, deps: ResolveFeedbackDeps): Promise<Feedback> {
  const s = feedbackOf(deps.store);
  const now = deps.now ?? new Date();
  const by = feedbackBy(deps.by);
  const f = await s.getFeedback(deps.grant, id);
  if (f === null) throw fail('not-found');
  resolvable(f);
  if (f.status !== 'pending' && f.status !== 'open') throw fail('already-resolved', f.status);
  if (!grantWrites(deps.grant, f)) throw new GrantError();
  const next = closed(f, 'dismissed', by, now);
  const lost = await closeRow(s, deps.grant, f, next);
  if (lost !== undefined) throw fail(lost === 'dismissed' ? 'already-resolved' : 'conflict', lost);
  return next;
}

/** How recall labels a contested memory: the newest open correction about it. */
export interface Contested {
  feedbackId: string;
  signal: 'wrong' | 'stale';
  /** The scrubbed note, when one was given. */
  note?: string;
  /** Who gave it, and when. */
  by: string;
  at: string;
}

/**
 * The open corrections (`wrong` or `stale`) the grant reads about `memoryIds`: per memory, the
 * newest. A store without feedback has none.
 */
export async function contestedOf(
  store: MemoryStore,
  grant: Grant,
  memoryIds: readonly string[],
): Promise<Map<string, Contested>> {
  const out = new Map<string, Contested>();
  if (!keepsFeedback(store) || memoryIds.length === 0) return out;
  const rows = await store.listFeedback!(grant, {
    memoryIds: [...new Set(memoryIds)],
    status: 'open',
  });
  for (const f of rows) {
    if (out.has(f.memoryId) || (f.signal !== 'wrong' && f.signal !== 'stale')) continue;
    out.set(f.memoryId, {
      feedbackId: f.id,
      signal: f.signal,
      ...(f.note !== undefined && { note: f.note }),
      by: f.by,
      at: f.confirmed?.at ?? f.createdAt,
    });
  }
  return out;
}

/**
 * Feedback rows that name a forgotten memory and could not be removed (`leftover`). The memory
 * was left as it was, so the same forget can be tried again.
 */
export class FeedbackPurgeError extends Error {
  override readonly name = 'FeedbackPurgeError';
  constructor(readonly leftover: readonly string[]) {
    super(`${leftover.length} feedback row(s) about this memory could not be removed; try again.`);
  }
}

/**
 * Removes every feedback row about `memoryId`, at every address (rows other principals wrote
 * included), as a forget does before it removes the memory. Throws `FeedbackPurgeError` naming
 * the rows it could not remove. Does nothing on a store without feedback.
 */
export async function purgeFeedbackFor(
  store: MemoryStore,
  grant: Grant,
  memoryId: string,
): Promise<string[]> {
  if (store.feedback !== true) return [];
  if (store.purgeFeedbackFor === undefined) {
    throw new Error('a store with feedback must implement purgeFeedbackFor');
  }
  const r = await store.purgeFeedbackFor(grant, memoryId);
  if (r.leftover.length > 0) throw new FeedbackPurgeError([...new Set(r.leftover)]);
  return r.removed;
}
