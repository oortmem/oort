import { createHash, randomUUID } from 'node:crypto';
import type { Embedder, FeedbackWrite, MemoryStore } from './adapters.js';
import { addressOf, addressed, type Address, type Author } from './address.js';
import { INVISIBLE_SOURCE } from './display.js';
import { GrantError, grantReads, grantWrites, type Grant } from './grant.js';
import {
  isAgentVia,
  judgmentField,
  JudgmentInputError,
  JUDGMENT_LIMITS,
  projectPlacement,
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
 *   `helped` per memory and author (`by`) per UTC day, held by the store (`helpedKey`); later
 *   ones are kept, not applied.
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
 * capability), at the grant's home node and bound to the memory's project, so a grant reads it
 * only where it reads that project. Forgetting a memory removes every feedback row that names
 * it, at every address.
 *
 * A retire or supersede changes a memory, so it runs in three steps, each one guarded write: the
 * row is claimed (`resolving`, with the resolver and the action), the memory is changed, then the
 * row closes. Only the call that claimed the row (or a later call finishing the same claim) ever
 * changes the memory, so two resolves never undo each other; a call that stopped part way leaves
 * the row `resolving`, and the same command run again finishes it.
 */

export const FEEDBACK_SIGNALS = ['helped', 'wrong', 'stale', 'irrelevant'] as const;
export type FeedbackSignal = (typeof FEEDBACK_SIGNALS)[number];

/**
 * Where a feedback row stands:
 * - `pending`: recorded by an agent; changes nothing until a person confirms it;
 * - `recorded`: a `helped` (applied or not) or an `irrelevant`, kept;
 * - `open`: a `wrong` or `stale` correction; recall labels the memory contested;
 * - `resolving`: a person's retire or supersede is under way (`claim`); recall still labels it;
 * - `retired`: a person ended the memory; `superseded`: a person stored the right fact in its
 *   place; `dismissed`: a person set the feedback aside. These three are final.
 */
export const FEEDBACK_STATUSES = [
  'pending',
  'recorded',
  'open',
  'resolving',
  'retired',
  'superseded',
  'dismissed',
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** How feedback was recorded: `mcp` means an agent (pending until a person confirms it). */
export type FeedbackVia = Extract<JudgmentVia, 'cli' | 'mcp' | 'sdk'>;

/**
 * Why a `helped` was kept without adding accesses: one was applied for that memory and person
 * today, `feedback.helpedAccesses` is 0, or adding the accesses failed (the call then throws, and
 * the row says so).
 */
export type HelpedNotAppliedReason = 'already-helped-today' | 'disabled' | 'access-failed';

export const FEEDBACK_LIMITS = Object.freeze({
  /** `note` and `query` are kept to this many characters, on one line. */
  text: 500,
  /**
   * Pending (agent-recorded) rows one author keeps at its home node, across every project; above
   * it nothing is kept.
   */
  pending: 5000,
  /** Pending rows all authors together keep at one home node, across every project. */
  pendingAddress: 50_000,
  /** A memory id. */
  memoryId: 128,
});

export const FEEDBACK_DEFAULTS = Object.freeze({
  /** Accesses one applied `helped` adds (config `feedback.helpedAccesses`). */
  helpedAccesses: 2,
});

/** A person's retire or supersede, while it runs (`status: 'resolving'`). */
export interface FeedbackClaim {
  action: 'retired' | 'superseded';
  /** The person resolving it, when they claimed it, and a token for this claim. */
  by: string;
  at: string;
  token: string;
  /** Where the row goes back to if the claim is given up (the memory could not be changed). */
  from: 'open' | 'pending';
  /** `superseded`: the fact as it is stored, the secret kinds redacted, and the new memory id. */
  fact?: string;
  redacted?: string[];
  memoryId?: string;
}

/** One feedback record. */
export interface Feedback {
  id: string;
  /** Where it lives: the grant's home node, bound to the memory's project. Read with `addressOf`. */
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
  /**
   * An applied `helped`: `memoryId|by|YYYY-MM-DD` (UTC). The store keeps it unique, so one
   * memory and person count once a day however many calls run at once.
   */
  helpedKey?: string;
  /** Set when a person confirmed agent-recorded feedback. */
  confirmed?: { at: string; by: string };
  /** Set while a person's retire or supersede runs. */
  claim?: FeedbackClaim;
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
 * - `in-progress`: a retire or supersede of it is under way (or stopped part way); the same
 *   command run again finishes it;
 * - `conflict`: it changed while this call ran; `status` is where it stands now;
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
  | 'in-progress'
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
     * Set when a memory was changed and could not be put back: the message names what to check
     * (`oort inspect`). Running the call again does not fix it.
     */
    readonly memoryChanged?: true,
  ) {
    super(message);
  }
}

const MESSAGES: Record<Exclude<FeedbackErrorKind, 'invalid' | 'in-progress'>, string> = {
  'memory-not-found': 'No memory with that id in this scope.',
  'not-found': 'No feedback with that id in this scope.',
  ambiguous: 'That id prefix matches more than one feedback row; give more of the id.',
  'not-pending': 'That feedback is not waiting for a confirmation.',
  'not-a-correction': 'Only wrong or stale feedback can retire or supersede a memory.',
  'already-resolved': 'That feedback was already resolved.',
  'memory-ended': 'That memory is no longer current, so it cannot be retired or superseded.',
  conflict: 'That feedback changed while this ran; nothing was changed.',
  unsupported: 'This store keeps no feedback.',
};

const fail = (
  kind: Exclude<FeedbackErrorKind, 'invalid' | 'in-progress'>,
  status?: FeedbackStatus,
): FeedbackError => {
  const now = status === undefined ? '' : ` It is ${status} now.`;
  return new FeedbackError(kind, MESSAGES[kind] + now, status);
};

const invalid = (message: string): FeedbackError => new FeedbackError('invalid', message);

const COMMAND: Record<FeedbackClaim['action'], string> = {
  retired: 'retire',
  superseded: 'supersede (with the same fact)',
};

/** A retire or supersede of `f` is under way, or stopped part way. */
function inProgress(f: Feedback, why = 'Another call is resolving that feedback'): FeedbackError {
  const action = f.claim?.action ?? 'retired';
  return new FeedbackError(
    'in-progress',
    `${why} (${COMMAND[action].split(' ')[0]}). If it stopped, run ${COMMAND[action]} again to finish it.`,
    'resolving',
  );
}

type FeedbackStore = Required<
  Pick<MemoryStore, 'putFeedback' | 'getFeedback' | 'listFeedback' | 'purgeFeedbackFor'>
>;

function feedbackOf(store: MemoryStore): FeedbackStore {
  if (
    store.feedback !== true ||
    store.putFeedback === undefined ||
    store.getFeedback === undefined ||
    store.listFeedback === undefined ||
    store.purgeFeedbackFor === undefined
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

/**
 * Characters nobody sees: the bidi and invisible format characters, every
 * Default_Ignorable_Code_Point (zero-width joiners, variation selectors, fillers) and the Unicode
 * tag block, astral code points included.
 */
const UNSEEN = new RegExp(
  `${INVISIBLE_SOURCE}|[\\p{Default_Ignorable_Code_Point}\\u{E0000}-\\u{E007F}]`,
  'gu',
);
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** `s` without characters nobody sees, for text that is stored or shown. */
export function withoutInvisible(s: string): string {
  return s.replace(UNSEEN, '');
}

/** `v` as one visible line: invisible characters dropped, controls as spaces, runs as one. */
const oneLine = (v: string): string =>
  withoutInvisible(v).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();

/**
 * Free text as feedback keeps it: invisible characters dropped first (so a secret split by one
 * is seen whole), then one line, then scrubbed, then clipped to `FEEDBACK_LIMITS.text`.
 * Undefined when nothing is left.
 */
export function feedbackText(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw invalid(`${field} must be text`);
  const t = oneLine(scrub(oneLine(v)).text);
  if (t === '') return undefined;
  return t.length > FEEDBACK_LIMITS.text ? t.slice(0, FEEDBACK_LIMITS.text).trimEnd() : t;
}

/** Who gives feedback, checked as a judgment's `by` is, then scrubbed. */
export function feedbackBy(v: unknown): string {
  try {
    const raw = typeof v === 'string' ? withoutInvisible(v) : v;
    return scrub(judgmentField('by', raw, JUDGMENT_LIMITS.by)).text;
  } catch (e) {
    if (e instanceof JudgmentInputError) throw invalid(e.message);
    throw e;
  }
}

function memoryIdOf(v: unknown): string {
  if (typeof v !== 'string') throw invalid('memoryId must be text');
  const t = v.trim();
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
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

/** The key that keeps one applied `helped` per memory, person and UTC day. */
export const helpedKeyOf = (memoryId: string, by: string, at: Date): string =>
  `${memoryId}|${by}|${at.toISOString().slice(0, 10)}`;

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

/** What a write that did not land means for the caller. */
function refused(w: Exclude<FeedbackWrite, 'written'>, status?: FeedbackStatus): FeedbackError {
  return w === 'memory-gone' ? fail('memory-not-found') : fail('conflict', status);
}

/**
 * Applies a person's `helped` stored as `row` over `expect` (null: a new row): written applied,
 * holding today's `helpedKey`, then its accesses are added. When the store already holds the key
 * (another `helped` for that memory and person today, even one running right now), the row is
 * written not applied instead. When adding the accesses fails, the row is written back not
 * applied (`access-failed`, the key released) and the error is thrown.
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
  const { applied: _a, appliedAt: _t, reason: _r, helpedKey: _k, ...base } = row;
  const revision = expect === null ? row.revision : row.revision + 1;
  const notApplied = (reason: HelpedNotAppliedReason, rev = revision): Feedback => ({
    ...base,
    status: 'recorded',
    applied: false,
    reason,
    revision: rev,
    updatedAt: iso,
  });
  const write = async (next: Feedback, over: number | null): Promise<Feedback> => {
    const w = await s.putFeedback(grant, next, { revision: over });
    if (w === 'written') return next;
    throw refused(w, (await s.getFeedback(grant, row.id))?.status);
  };
  if (accesses === 0) return write(notApplied('disabled'), expect);
  const applied: Feedback = {
    ...base,
    status: 'recorded',
    applied: true,
    appliedAt: iso,
    helpedKey: helpedKeyOf(row.memoryId, row.by, now),
    revision,
    updatedAt: iso,
  };
  const w = await s.putFeedback(grant, applied, { revision: expect });
  if (w === 'helped-today') return write(notApplied('already-helped-today'), expect);
  if (w !== 'written') throw refused(w, (await s.getFeedback(grant, row.id))?.status);
  try {
    await store.recordAccess(
      grant,
      Array.from({ length: accesses }, () => row.memoryId),
      now,
    );
  } catch (e) {
    await s
      .putFeedback(grant, notApplied('access-failed', revision + 1), { revision })
      .catch(() => undefined);
    throw e;
  }
  return applied;
}

/**
 * Records feedback on one memory. Everything is checked first (`FeedbackError`): the signal, the
 * memory (it must be one the grant reads), `query` for `irrelevant`, and the text. The row is
 * kept at the grant's home node, bound to the memory's project. Then:
 * - by an agent (`via: 'mcp'`): kept `pending`, unless the author already keeps
 *   `FEEDBACK_LIMITS.pending` pending rows at that address (`kept: false`, `pending-cap`; the
 *   store counts inside the write);
 * - `helped` by a person: kept `recorded`, and its accesses added unless one was applied for the
 *   same memory and `by` today (`applied: false`, `already-helped-today`);
 * - `wrong` or `stale` by a person: kept `open`, so recall labels the memory contested;
 * - `irrelevant` by a person: kept `recorded`.
 * A memory forgotten while this runs is `memory-not-found`: the store refuses a row about a
 * memory it no longer holds.
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
    ...projectPlacement(deps.scope, deps.grant, addressOf(memory).projectId),
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
  if (!agent && signal === 'helped') {
    const done = await applyHelped(s, deps.store, deps.grant, row, null, accesses, now);
    return {
      kept: true,
      feedback: done,
      applied: done.applied === true,
      ...(done.reason !== undefined && { reason: done.reason }),
    };
  }
  const w = await s.putFeedback(
    deps.grant,
    row,
    { revision: null },
    agent
      ? { pendingCap: FEEDBACK_LIMITS.pending, addressPendingCap: FEEDBACK_LIMITS.pendingAddress }
      : undefined,
  );
  if (w === 'pending-cap') return { kept: false, reason: 'pending-cap' };
  if (w !== 'written') throw refused(w);
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

/** Where a row stands after a guarded write on it did not land, as the error to report. */
async function lostTo(s: FeedbackStore, grant: Grant, id: string): Promise<FeedbackError> {
  const now = await s.getFeedback(grant, id);
  if (now === null) return fail('not-found');
  if (isFinal(now.status)) return fail('already-resolved', now.status);
  if (now.status === 'resolving') return inProgress(now);
  return fail('conflict', now.status);
}

const isFinal = (st: FeedbackStatus): boolean =>
  st === 'retired' || st === 'superseded' || st === 'dismissed';

/**
 * A person confirms agent-recorded (`pending`) feedback: from then on it counts as theirs would
 * have. A `helped` adds its accesses once (unless one was applied for that memory and author
 * today), a `wrong` or `stale` opens its correction (recall labels the memory), an `irrelevant`
 * is kept. One guarded write; a lost race fails with where the row stands.
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
  if ((await s.putFeedback(deps.grant, next, { revision: f.revision })) !== 'written') {
    throw await lostTo(s, deps.grant, id);
  }
  return next;
}

/** The decision a feedback resolve leaves on the memory it changed. */
const feedbackDecision = (question: string, f: Feedback): Decision => ({
  stage: 'feedback',
  question,
  answer: f.id,
  probability: 1,
});

/** True when `m` already carries this feedback's `question` (an earlier call of the claim did it). */
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

/** When an ended memory stops holding: `at`, or its own end when that already passed. */
function closeAt(m: Pick<Memory, 'validFrom' | 'validTo'>, at: Date): string {
  if (m.validTo !== null && Date.parse(m.validTo) <= at.getTime()) return m.validTo;
  return new Date(Math.max(at.getTime(), Date.parse(m.validFrom))).toISOString();
}

/** The full memory as stored: its cold copy when cold (the main row has no embedding). */
async function fullMemory(store: MemoryStore, grant: Grant, m: Memory): Promise<Memory> {
  if (m.tier !== 'cold') return m;
  return (await store.coldGet(grant, m.id)) ?? m;
}

/** How often a memory change is tried again when the memory changed under it (an access). */
const MEMORY_TRIES = 4;

/**
 * The correction `ref` names, for `action`, claimed for this call: an open (or pending) row is
 * claimed in one guarded write; a row already `resolving` with the same action (and for a
 * supersede, the same fact) is taken over, so a call that stopped part way is finished. Anything
 * else is refused with where it stands.
 */
async function claimed(
  s: FeedbackStore,
  deps: ResolveFeedbackDeps,
  id: string,
  action: FeedbackClaim['action'],
  extra: (
    f: Feedback,
    m: Memory,
  ) => Pick<FeedbackClaim, 'fact' | 'redacted' | 'memoryId'> = () => ({}),
): Promise<{ f: Feedback; c: FeedbackClaim; by: string }> {
  const now = deps.now ?? new Date();
  const by = feedbackBy(deps.by);
  const f = await s.getFeedback(deps.grant, id);
  if (f === null) throw fail('not-found');
  if (isFinal(f.status)) throw fail('already-resolved', f.status);
  if (f.signal !== 'wrong' && f.signal !== 'stale') throw fail('not-a-correction');
  if (!grantWrites(deps.grant, f)) throw new GrantError();
  const m = await deps.store.get(deps.grant, f.memoryId);
  if (m === null || !grantReads(deps.grant, m)) throw fail('memory-not-found');
  if (!grantWrites(deps.grant, m)) throw new GrantError();
  if (f.status === 'resolving') {
    const c = f.claim;
    const want = extra(f, m);
    if (
      c === undefined ||
      c.action !== action ||
      (want.fact !== undefined && want.fact !== c.fact)
    ) {
      throw inProgress(f, 'That feedback is being resolved another way');
    }
    return { f, c, by };
  }
  if (f.status !== 'open' && f.status !== 'pending') throw fail('already-resolved', f.status);
  if (!isCurrent(m, now)) throw fail('memory-ended');
  const c: FeedbackClaim = {
    action,
    by,
    at: now.toISOString(),
    token: randomUUID(),
    from: f.status,
    ...extra(f, m),
  };
  const next: Feedback = {
    ...f,
    status: 'resolving',
    claim: c,
    revision: f.revision + 1,
    updatedAt: c.at,
  };
  if ((await s.putFeedback(deps.grant, next, { revision: f.revision })) !== 'written') {
    throw await lostTo(s, deps.grant, id);
  }
  return { f: next, c, by };
}

/**
 * Gives a claim up when the memory cannot be changed (it ended, or is gone): the row goes back to
 * where it was. Throws `fail(kind)` either way; a row that moved on meanwhile is left as it is.
 */
async function release(
  s: FeedbackStore,
  grant: Grant,
  f: Feedback,
  c: FeedbackClaim,
  kind: 'memory-ended' | 'memory-not-found',
  now: Date,
): Promise<never> {
  const { claim: _c, ...rest } = f;
  await s
    .putFeedback(
      grant,
      { ...rest, status: c.from, revision: f.revision + 1, updatedAt: now.toISOString() },
      { revision: f.revision },
    )
    .catch(() => undefined);
  throw fail(kind);
}

/** Closes a claimed row as `c.action`; a lost race (another call finished it) is reported. */
async function finish(
  s: FeedbackStore,
  grant: Grant,
  f: Feedback,
  c: FeedbackClaim,
  by: string,
  now: Date,
): Promise<Feedback> {
  const { claim: _c, ...rest } = f;
  const iso = now.toISOString();
  const done: Feedback = {
    ...rest,
    status: c.action,
    resolved: {
      at: iso,
      by,
      ...(c.memoryId !== undefined && { supersededBy: c.memoryId }),
    },
    revision: f.revision + 1,
    updatedAt: iso,
  };
  if ((await s.putFeedback(grant, done, { revision: f.revision })) !== 'written') {
    throw await lostTo(s, grant, f.id);
  }
  return done;
}

export interface RetireResult {
  feedback: Feedback;
  /** The memory as it was ended. */
  memory: Memory;
  endReason: 'corrected' | 'expired';
}

/**
 * A person ends the memory a `wrong` or `stale` feedback names, with `endReason` `corrected`
 * (wrong: it never held, as observe's CORRECT retracts a prior) or `expired` (stale: it held until
 * the retire). The feedback closes `retired`.
 *
 * The row is claimed (`resolving`), the memory is ended in one guarded write that records this
 * feedback in its decisions, and the row closes. A retire that stopped part way is finished by
 * running it again. When two run at once, one closes the row and the other fails
 * `already-resolved` (or `in-progress`), and the memory is ended once.
 */
export async function retireFeedback(id: string, deps: ResolveFeedbackDeps): Promise<RetireResult> {
  const s = feedbackOf(deps.store);
  const now = deps.now ?? new Date();
  const { f, c, by } = await claimed(s, deps, id, 'retired');
  const endReason = f.signal === 'wrong' ? 'corrected' : 'expired';
  const at = new Date(c.at);
  let ended: Memory | undefined;
  for (let i = 0; i < MEMORY_TRIES && ended === undefined; i++) {
    const m = await deps.store.get(deps.grant, f.memoryId);
    if (m === null) return release(s, deps.grant, f, c, 'memory-not-found', now);
    if (changedBy(m, 'retired', f)) {
      ended = m;
      break;
    }
    if (!isCurrent(m, now)) return release(s, deps.grant, f, c, 'memory-ended', now);
    const full = await fullMemory(deps.store, deps.grant, m);
    const next: Memory = {
      ...full,
      expiredAt: c.at,
      endReason,
      // Wrong: it never held, so its valid interval is left as it was (as observe's CORRECT).
      ...(endReason === 'expired' && { validTo: closeAt(m, at) }),
      updatedAt: c.at,
      source: {
        ...full.source,
        decisions: [...full.source.decisions, feedbackDecision('retired', f)],
      },
    };
    if ((await guarded(deps.store, deps.grant, [{ next, was: m }])).length === 0) ended = next;
  }
  if (ended === undefined) throw inProgress(f, 'Its memory kept changing while this ran');
  return { feedback: await finish(s, deps.grant, f, c, by, now), memory: ended, endReason };
}

export interface SupersedeFeedbackDeps extends ResolveFeedbackDeps {
  /** The person's scope: the new memory is theirs (its author), in the old memory's node. */
  scope: Scope;
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
 * The id of the memory a supersede of feedback `feedbackId` writes: the same on every try, so a
 * call that stopped part way, or two at once, never leave two new memories.
 */
export function supersedingId(feedbackId: string): string {
  const h = createHash('sha256').update(`oort.feedback.supersede\n${feedbackId}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The fact a person supersedes with, as it is stored, or an `invalid` error. */
function factOf(fact: unknown): { text: string; redacted: string[] } {
  if (typeof fact !== 'string') throw invalid('the fact must be text');
  if (/[\r\n\u2028\u2029]/.test(fact.trim())) throw invalid('the fact must be one line');
  const visible = oneLine(fact);
  if (visible === '') throw invalid('the fact is empty');
  if (visible.length > FEEDBACK_LIMITS.text) {
    throw invalid(`the fact is longer than ${FEEDBACK_LIMITS.text} characters`);
  }
  const scrubbed = scrub(visible);
  if (scrubbed.secretRatio > 0.5) throw invalid('the fact is mostly a secret; nothing was stored');
  const text = feedbackText(visible, 'fact');
  if (text === undefined) throw invalid('the fact is empty');
  return { text, redacted: [...new Set(scrubbed.redactions.map((r) => r.kind))] };
}

/**
 * A person replaces the memory a `wrong` or `stale` feedback names with the right fact, the way a
 * supersede on the write path does: a new memory in the old one's node and project (same type),
 * written by this person's agent (its author), `supersedes` the old one, and the old one closes
 * where the new one starts, `superseded`. The fact must be one line of at most 500 characters,
 * and is scrubbed. The feedback closes `superseded`, naming the new memory.
 *
 * The row is claimed with the fact and the new memory's id (`supersedingId`, the same on every
 * try), the new memory is written unless it is there already, the old one is closed in one
 * guarded write, and the row closes. A supersede that stopped part way is finished by running it
 * again with the same fact. When the old memory ended meanwhile (another way), the new memory is
 * removed if it is still as written and the claim is given up (`memory-ended`).
 */
export async function supersedeFeedback(
  id: string,
  fact: string,
  deps: SupersedeFeedbackDeps,
): Promise<SupersedeFeedbackResult> {
  const s = feedbackOf(deps.store);
  const now = deps.now ?? new Date();
  const asStored = factOf(fact);
  const { f, c, by } = await claimed(s, deps, id, 'superseded', (row) => ({
    fact: asStored.text,
    redacted: asStored.redacted,
    memoryId: supersedingId(row.id),
  }));
  const text = c.fact!;
  const newId = c.memoryId!;
  const at = new Date(c.at);
  const decision = feedbackDecision('superseded', f);

  let written = await deps.store.get(deps.grant, newId);
  const removeNew = async (): Promise<void> => {
    // Only the memory this claim wrote, while nothing else changed it.
    const live = await deps.store.get(deps.grant, newId);
    if (live === null) return;
    if (
      live.supersedes !== f.memoryId ||
      live.updatedAt !== c.at ||
      !changedBy(live, 'superseded', f)
    ) {
      throw new FeedbackError(
        'memory-ended',
        `${MESSAGES['memory-ended']} The new memory ${newId.slice(0, 8)} was changed meanwhile, so it was kept; check it with \`oort inspect ${newId.slice(0, 8)}\`.`,
        'resolving',
        true,
      );
    }
    await deps.store.forget(deps.grant, newId);
  };
  const giveUp = async (kind: 'memory-ended' | 'memory-not-found'): Promise<never> => {
    try {
      await removeNew();
    } catch (e) {
      if (e instanceof FeedbackError) throw e;
      throw new FeedbackError(
        kind,
        `${MESSAGES[kind]} The new memory ${newId.slice(0, 8)} written for it could not be removed; check it with \`oort inspect ${newId.slice(0, 8)}\`.`,
        'resolving',
        true,
      );
    }
    return release(s, deps.grant, f, c, kind, now);
  };

  let old: Memory | undefined;
  for (let i = 0; i < MEMORY_TRIES && old === undefined; i++) {
    const m = await deps.store.get(deps.grant, f.memoryId);
    if (m === null) return giveUp('memory-not-found');
    if (m.supersededBy === newId && changedBy(m, 'superseded', f)) {
      old = m;
      break;
    }
    if (!isCurrent(m, now)) return giveUp('memory-ended');
    if (written === null) {
      let embedding: Int8Array | undefined;
      try {
        embedding = (await deps.embed?.embed([text], 'document'))?.[0];
      } catch {
        embedding = undefined;
      }
      const words = new Set(text.toLowerCase().split(/[^\p{L}\p{N}._/-]+/u));
      const next: Memory = {
        id: newId,
        // In the old memory's node and project, written by this person's agent.
        ...addressed(addressOf(m), { agentId: deps.scope.agentId }),
        type: m.type,
        text,
        stub: text.length > 80 ? `${text.slice(0, 79)}…` : text,
        // What both are about: the old entities the new fact still names.
        entities: m.entities.filter((e) => words.has(e.toLowerCase())),
        salience: m.salience,
        pinned: m.pinned,
        tier: m.tier === 'cold' ? 'warm' : m.tier,
        accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
        validFrom: c.at,
        validTo: null,
        expiredAt: null,
        endReason: null,
        lastConfirmedAt: c.at,
        supersedes: m.id,
        supersededBy: null,
        ...(m.place !== undefined && { place: structuredClone(m.place) }),
        ...(embedding !== undefined && { embedding }),
        source: { harness: deps.harness, decisions: [decision] },
        createdAt: c.at,
        updatedAt: c.at,
      };
      if (!grantWrites(deps.grant, next)) throw new GrantError();
      await deps.store.upsert(deps.grant, next);
      written = next;
    }
    const full = await fullMemory(deps.store, deps.grant, m);
    const closedOld: Memory = {
      ...full,
      validTo: closeAt(m, at),
      expiredAt: c.at,
      endReason: 'superseded',
      supersededBy: newId,
      updatedAt: c.at,
      source: { ...full.source, decisions: [...full.source.decisions, decision] },
    };
    if ((await guarded(deps.store, deps.grant, [{ next: closedOld, was: m }])).length === 0) {
      old = closedOld;
    }
  }
  if (old === undefined || written === null) {
    throw inProgress(f, 'Its memory kept changing while this ran');
  }
  return {
    feedback: await finish(s, deps.grant, f, c, by, now),
    memory: written,
    supersedes: f.memoryId,
    redacted: c.redacted ?? [],
  };
}

/**
 * A person sets feedback aside: a pending row (an agent's) or an open correction closes
 * `dismissed`, and recall stops labelling the memory. The memory is not touched. One guarded
 * write; a lost race fails with where the row stands. A row being retired or superseded is
 * refused (`in-progress`).
 */
export async function dismissFeedback(id: string, deps: ResolveFeedbackDeps): Promise<Feedback> {
  const s = feedbackOf(deps.store);
  const now = deps.now ?? new Date();
  const by = feedbackBy(deps.by);
  const f = await s.getFeedback(deps.grant, id);
  if (f === null) throw fail('not-found');
  if (isFinal(f.status)) throw fail('already-resolved', f.status);
  if (f.status === 'resolving') throw inProgress(f);
  if (f.status !== 'pending' && f.status !== 'open') throw fail('already-resolved', f.status);
  if (!grantWrites(deps.grant, f)) throw new GrantError();
  const iso = now.toISOString();
  const next: Feedback = {
    ...f,
    status: 'dismissed',
    resolved: { at: iso, by },
    revision: f.revision + 1,
    updatedAt: iso,
  };
  if ((await s.putFeedback(deps.grant, next, { revision: f.revision })) !== 'written') {
    throw await lostTo(s, deps.grant, id);
  }
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
 * The open corrections (`wrong` or `stale`, `open` or being resolved) the grant reads about
 * `memoryIds`: per memory, the newest. A store without feedback has none. Stores look these up by
 * memory id, never by scanning the grant's rows.
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
    status: ['open', 'resolving'],
  });
  for (const f of rows) {
    if (out.has(f.memoryId) || (f.signal !== 'wrong' && f.signal !== 'stale')) continue;
    out.set(f.memoryId, {
      feedbackId: f.id,
      signal: f.signal,
      // Rows from before invisible characters were stripped on the way in lose them here.
      ...(f.note !== undefined && { note: withoutInvisible(f.note) }),
      by: withoutInvisible(f.by),
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
 * included), as a forget does before it removes the memory. Only for a memory the grant may
 * change (`GrantError` otherwise); a memory the grant does not read is left alone (its rows go
 * when the store next opens, if the memory is gone). Throws `FeedbackPurgeError` naming the rows
 * it could not remove. Does nothing on a store without feedback.
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
  const m = await store.get(grant, memoryId);
  if (m === null) return [];
  if (!grantWrites(grant, m)) throw new GrantError();
  const r = await store.purgeFeedbackFor(grant, memoryId);
  if (r.leftover.length > 0) throw new FeedbackPurgeError([...new Set(r.leftover)]);
  return r.removed;
}
