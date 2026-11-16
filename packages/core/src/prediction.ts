import type { MemoryStore } from './adapters.js';
import type { Address, Author } from './address.js';
import { GrantError, grantWrites, type Grant } from './grant.js';
import {
  JudgmentInputError,
  confirmJudgment,
  isAgentVia,
  judgmentCriterion,
  judgmentDomain,
  judgmentField,
  judgmentLabel,
  JUDGMENT_LIMITS,
  normaliseJudgment,
  recordJudgment,
  undoRecordedJudgment,
  withdrawJudgment,
  type JudgeResult,
  type JudgmentInput,
  type JudgeWhy,
  type JudgmentVia,
  type RecordJudgmentDeps,
  type RecordJudgmentResult,
} from './judgment.js';
import type { Memory, Scope } from './model.js';
import { scrub } from './scrub.js';

/**
 * Predictions: what `judge()` proposed for an item, kept beside what a person then decided.
 *
 * Judging with `deps.keep` stores each result as a prediction (the item, the predicted verdict,
 * its probability and the precedents it used) and returns its id. A person resolves it with
 * their own verdict. When they disagree and give a reason, the reason becomes a new judgment,
 * word for word, so the next judging call cites it. Resolved predictions are the live record of
 * how often judging agrees with the expert, and how far its confidence can be trusted
 * (`evaluatePredictions`).
 *
 * A prediction is not a memory: it lives in the store's own prediction records (the
 * `predictions` capability), so recall, listings and exports of memories never see one. It sits
 * at the grant's home node, as judgments do.
 *
 * A resolve recorded by an agent (`via: 'mcp'`) is unconfirmed, as an agent-recorded judgment
 * is: the evaluation leaves it out, and the judgment it records does not count when judging,
 * until a person confirms it (`confirmResolution`).
 */

/** The item a prediction was made for, as judging saw it (secrets redacted). */
export interface PredictionItem {
  summary: string;
  details?: string;
  ref?: string;
  /** The domain judging was limited to. */
  domain?: string;
  /** The expert judging was limited to. */
  by?: string;
}

/** What a person decided about a predicted item. */
export interface PredictionResolution {
  /** The person's verdict, one of the prediction's `verdicts`. */
  verdict: string;
  /** Their reason, in their own words (secrets redacted). */
  reason?: string;
  /** Tags their reason relies on. */
  criteria: string[];
  /** Who decided: the expert's id. */
  by: string;
  at: string;
  /** How the decision was recorded (`mcp`: by an agent, unconfirmed until a person confirms it). */
  via: JudgmentVia;
  /** The person chose the predicted verdict. Null when judging predicted none. */
  agrees: boolean | null;
  /** The judgment this resolve recorded (a different verdict with a reason). */
  judgmentId?: string;
  /** Set when a person confirmed an agent-recorded resolve. */
  confirmed?: { at: string; by: string };
}

/** One kept judging result. */
export interface Prediction {
  id: string;
  /** Where it lives: the grant's home node, as for a judgment. Read with `addressOf`. */
  scope: Scope;
  address?: Address;
  author?: Author;
  item: PredictionItem;
  /** The item's domain, or the precedents' when they share one. */
  domain?: string;
  /** What judging answered. */
  outcome: JudgeResult['status'];
  why?: JudgeWhy;
  /** The predicted verdict; null when judging made no prediction. */
  verdict: string | null;
  /** Its probability; null when judging made no prediction. */
  probability: number | null;
  /** The verdicts a person may resolve it with: those of the precedents' verdict sets. */
  verdicts: string[];
  /** The judgments judging cited, nearest first. */
  precedentIds: string[];
  /** The criteria of the cited judgments. */
  criteria: string[];
  similarity: 'dense' | 'lexical';
  threshold: number;
  /** Raised by one on every write; the store's guard for a resolve that races another. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** After this time an unresolved prediction can no longer be resolved. */
  expiresAt: string;
  resolution?: PredictionResolution;
  /**
   * Agent-recorded resolves a person's resolve replaced, oldest first: who and when, and the
   * judgment each recorded (withdrawn when it was replaced). No reason or criteria.
   */
  superseded?: SupersededResolution[];
  /** Set when its text was purged (a cited judgment was withdrawn, purged or forgotten). */
  purged?: { at: string; by: string };
}

/** An agent-recorded resolve a person's resolve replaced. */
export interface SupersededResolution {
  verdict: string;
  by: string;
  at: string;
  via: JudgmentVia;
  judgmentId?: string;
}

/** What `MemoryStore.listPredictions` filters by. */
export interface PredictionListOptions {
  /** `pending`: not resolved. `resolved`: resolved. Default: both. */
  status?: 'pending' | 'resolved';
  /** Only predictions citing this judgment id, as a precedent or as `resolution.judgmentId`. */
  citing?: string;
  /** Only predictions whose id starts with this (an id or the start of one). */
  idPrefix?: string;
  /** Only predictions of this domain. */
  domain?: string;
  /** With `status: 'pending'`: only those whose `expiresAt` is after this ISO time. */
  unexpiredAt?: string;
  limit?: number;
}

/** A prediction's state at a time: waiting for a person, decided, or past its expiry. */
export type PredictionState = 'pending' | 'resolved' | 'expired';

export function predictionState(p: Prediction, now: Date): PredictionState {
  if (p.resolution !== undefined) return 'resolved';
  return Date.parse(p.expiresAt) <= now.getTime() ? 'expired' : 'pending';
}

/** True when `p` cites `id`, as a precedent or as the judgment its resolve recorded. */
export function predictionCites(p: Prediction, id: string): boolean {
  return p.precedentIds.includes(id) || p.resolution?.judgmentId === id;
}

/**
 * `opts` applied to `rows` the way every store applies it: status and citing filters, newest
 * first (`createdAt`, then `id`), at most `limit`. For store implementations.
 */
export function selectPredictions(
  rows: readonly Prediction[],
  opts: PredictionListOptions = {},
): Prediction[] {
  const citing = opts.citing;
  const unexpired = opts.unexpiredAt === undefined ? undefined : Date.parse(opts.unexpiredAt);
  return rows
    .filter(
      (p) =>
        (opts.status === undefined ||
          (opts.status === 'resolved') === (p.resolution !== undefined)) &&
        (citing === undefined || predictionCites(p, citing)) &&
        (opts.idPrefix === undefined || p.id.startsWith(opts.idPrefix)) &&
        (opts.domain === undefined || p.domain === opts.domain) &&
        (unexpired === undefined ||
          p.resolution !== undefined ||
          Date.parse(p.expiresAt) > unexpired),
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
 * Why a prediction cannot be resolved or confirmed. The message never holds the prediction's
 * text. Nothing was written.
 * - `not-found`: no prediction with that id in this scope;
 * - `expired`: it waited past `expiresAt`;
 * - `already-resolved`: a person already decided it;
 * - `purged`: its text was purged;
 * - `not-resolved`: confirming, but nobody resolved it yet;
 * - `ambiguous`: an id prefix that matches more than one prediction;
 * - `conflict`: it changed while this call ran (another resolve or confirm landed first); any
 *   judgment this call recorded was withdrawn and purged again, so try again;
 * - `unsupported`: the store keeps no predictions.
 */
export type PredictionErrorKind =
  | 'not-found'
  | 'ambiguous'
  | 'expired'
  | 'already-resolved'
  | 'purged'
  | 'not-resolved'
  | 'conflict'
  | 'unsupported';

export class PredictionError extends Error {
  override readonly name = 'PredictionError';
  constructor(
    readonly kind: PredictionErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const MESSAGES: Record<PredictionErrorKind, string> = {
  'not-found': 'No prediction with that id in this scope.',
  expired: 'That prediction expired before anyone resolved it.',
  'already-resolved': 'That prediction is already resolved.',
  purged: 'That prediction was purged: a judgment it cited was withdrawn or forgotten.',
  'not-resolved': 'That prediction is not resolved yet.',
  ambiguous: 'That id prefix matches more than one prediction; give more of the id.',
  conflict: 'That prediction changed while this ran; nothing was kept. Try again.',
  unsupported: 'This store keeps no predictions.',
};

const fail = (kind: PredictionErrorKind): PredictionError =>
  new PredictionError(kind, MESSAGES[kind]);

type PredictionStore = Required<
  Pick<MemoryStore, 'putPrediction' | 'getPrediction' | 'listPredictions' | 'forgetPrediction'>
>;

function predictionsOf(store: MemoryStore): PredictionStore {
  if (
    store.predictions !== true ||
    store.putPrediction === undefined ||
    store.getPrediction === undefined ||
    store.listPredictions === undefined ||
    store.forgetPrediction === undefined
  ) {
    throw fail('unsupported');
  }
  return store as MemoryStore & PredictionStore;
}

/** The prediction `id` (an exact id), or `not-found`. */
export async function getPrediction(
  store: MemoryStore,
  grant: Grant,
  id: string,
): Promise<Prediction> {
  const p = await predictionsOf(store).getPrediction(grant, id);
  if (p === null) throw fail('not-found');
  return p;
}

/** The prediction `ref` names: an exact id, else a unique id prefix. */
export async function findPrediction(
  store: MemoryStore,
  grant: Grant,
  ref: string,
): Promise<Prediction> {
  const s = predictionsOf(store);
  const exact = await s.getPrediction(grant, ref);
  if (exact !== null) return exact;
  const matches = await s.listPredictions(grant, { idPrefix: ref, limit: 2 });
  if (matches.length > 1) throw fail('ambiguous');
  if (matches.length === 0) throw fail('not-found');
  return matches[0]!;
}

/**
 * How `ref` names a prediction: `exact` (a prediction's whole id), `prefix` (the start of one or
 * more ids) or `none`. A store without predictions has none. Lets a command that takes a memory
 * id or a prediction id refuse a prefix that matches both.
 */
export async function predictionMatch(
  store: MemoryStore,
  grant: Grant,
  ref: string,
): Promise<'exact' | 'prefix' | 'none'> {
  if (!keepsPredictions(store)) return 'none';
  const s = predictionsOf(store);
  if ((await s.getPrediction(grant, ref)) !== null) return 'exact';
  return (await s.listPredictions(grant, { idPrefix: ref, limit: 1 })).length > 0
    ? 'prefix'
    : 'none';
}

/** True when the store keeps predictions. */
export function keepsPredictions(store: MemoryStore): boolean {
  try {
    predictionsOf(store);
    return true;
  } catch {
    return false;
  }
}

/**
 * The predictions the grant reads, newest first. `pending` leaves out expired ones (nobody can
 * resolve them); `resolved` lists decided ones. Without `status`, every one. At most `limit`
 * (default 100, at most 1000).
 */
export async function listPredictions(
  store: MemoryStore,
  grant: Grant,
  opts: { status?: 'pending' | 'resolved'; limit?: number; domain?: string } = {},
  now = new Date(),
): Promise<Prediction[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  return predictionsOf(store).listPredictions(grant, {
    ...(opts.status !== undefined && { status: opts.status }),
    ...(opts.status === 'pending' && { unexpiredAt: now.toISOString() }),
    ...(opts.domain !== undefined && { domain: judgmentDomain(opts.domain) }),
    limit,
  });
}

/** What a person decided, as a caller hands it in. */
export interface ResolveInput {
  /** One of the prediction's `verdicts`. */
  verdict: string;
  /** Why, in their own words. Kept verbatim (secrets redacted). */
  reason?: string;
  /** Tags the reason relies on. */
  criteria?: readonly string[];
  /** Who decided: the expert's id. */
  by: string;
  /** The domain for the judgment a disagreement records, when the prediction has none. */
  domain?: string;
}

export interface ResolveResult {
  prediction: Prediction;
  /** The person chose the predicted verdict; null when judging predicted none. */
  agrees: boolean | null;
  /** The judgment the resolve recorded: a verdict other than the predicted one, with a reason. */
  judgment?: RecordJudgmentResult;
  /**
   * A person's resolve replaced an agent's, but could not withdraw the judgment the agent's
   * recorded: it is outside the person's grant (`not-writable`, for instance in that agent's own
   * Star). It stays as it was, unconfirmed, so judging leaves it out.
   */
  agentJudgmentKept?: string;
  agentJudgmentKeptReason?: 'not-writable';
}

/**
 * True when resolving `p` with `input` would record a judgment: a reason, and a verdict other
 * than the predicted one (or none was predicted). Never throws; for a caller that must reserve
 * something first.
 */
export function resolveRecordsJudgment(
  p: Prediction,
  input: Pick<ResolveInput, 'verdict' | 'reason'>,
): boolean {
  if (typeof input.reason !== 'string' || input.reason.trim() === '') return false;
  try {
    return p.verdict === null || judgmentLabel('verdict', input.verdict) !== p.verdict;
  } catch {
    return false;
  }
}

/** True for a resolve an agent recorded that no person has confirmed. */
function unconfirmedAgentResolve(r: PredictionResolution | undefined): boolean {
  return r !== undefined && isAgentVia(r.via) && r.confirmed === undefined;
}

/**
 * Records a person's decision on prediction `id` (an exact id). When their verdict is not the
 * predicted one (or judging predicted none) and they give a reason, the reason is recorded as a
 * new judgment of the item, verbatim, by `input.by`, so the next judging call can cite it.
 * `deps.via` says how it was recorded: `mcp` (an agent) leaves both the resolve and the judgment
 * unconfirmed.
 *
 * Everything is checked before anything is written: `PredictionError` (`not-found`, `purged`,
 * `already-resolved`, `expired`, `unsupported`) or `JudgmentInputError`. Then the judgment is
 * recorded, and one guarded write sets the resolution with the judgment's id. When that write
 * loses a race the judgment is withdrawn and purged and the call fails `conflict`.
 *
 * A person's resolve (any `via` but `mcp`) replaces an agent's unconfirmed one: the agent's
 * resolve moves to `superseded`, and the judgment it recorded is withdrawn, before the person's
 * is recorded.
 */
export async function resolvePrediction(
  id: string,
  input: ResolveInput,
  deps: RecordJudgmentDeps & { via: JudgmentVia },
): Promise<ResolveResult> {
  const store = predictionsOf(deps.store);
  const now = deps.now ?? new Date();
  let p = await store.getPrediction(deps.grant, id);
  if (p === null) throw fail('not-found');
  if (p.purged !== undefined) throw fail('purged');
  const supersede = !isAgentVia(deps.via) && unconfirmedAgentResolve(p.resolution);
  if (p.resolution !== undefined && !supersede) throw fail('already-resolved');
  if (Date.parse(p.expiresAt) <= now.getTime()) throw fail('expired');
  // Checked now, so the guarded writes below never fail on the grant after a change.
  if (!grantWrites(deps.grant, p)) throw new GrantError();

  if (typeof input !== 'object' || input === null) {
    throw new JudgmentInputError('a resolve must be an object');
  }
  const verdict = judgmentLabel('verdict', input.verdict);
  if (!p.verdicts.includes(verdict)) {
    throw new JudgmentInputError(`verdict must be one of: ${p.verdicts.join(', ')}`);
  }
  const by = scrub(judgmentField('by', input.by, JUDGMENT_LIMITS.by)).text;
  const reason =
    input.reason === undefined || (typeof input.reason === 'string' && input.reason.trim() === '')
      ? undefined
      : scrub(judgmentField('reason', input.reason, JUDGMENT_LIMITS.reason, true)).text;
  if (input.criteria !== undefined && !Array.isArray(input.criteria)) {
    throw new JudgmentInputError('criteria must be a list');
  }
  if ((input.criteria?.length ?? 0) > JUDGMENT_LIMITS.criteria) {
    throw new JudgmentInputError(`criteria has more than ${JUDGMENT_LIMITS.criteria} entries`);
  }
  const criteria = [...new Set((input.criteria ?? []).map((c) => judgmentCriterion(c)))];
  const agrees = p.verdict === null ? null : verdict === p.verdict;
  const records = reason !== undefined && agrees !== true;
  const domain =
    input.domain !== undefined ? judgmentDomain(input.domain) : (p.domain ?? p.item.domain);
  if (records && domain === undefined) {
    throw new JudgmentInputError(
      'domain is needed to record the reason as a judgment: the prediction has none',
    );
  }
  const iso = now.toISOString();
  const judgmentInput: JudgmentInput | undefined = records
    ? {
        subject: p.item.summary,
        ...(p.item.ref !== undefined && { ref: p.item.ref }),
        verdict,
        verdicts: p.verdicts,
        reason: reason!,
        criteria,
        domain: domain!,
        by,
        decidedAt: iso,
      }
    : undefined;
  // The judgment's own checks, before anything is written.
  if (judgmentInput !== undefined) normaliseJudgment(judgmentInput, now);

  let kept: string | undefined;
  if (supersede) ({ p, kept } = await supersedeAgentResolve(deps, p, by, now));

  let judgment: RecordJudgmentResult | undefined;
  if (judgmentInput !== undefined) judgment = await recordJudgment(judgmentInput, deps);
  const done: Prediction = {
    ...p,
    resolution: {
      verdict,
      ...(reason !== undefined && { reason }),
      criteria,
      by,
      at: iso,
      via: deps.via,
      agrees,
      ...(judgment !== undefined && { judgmentId: judgment.memory.id }),
    },
    revision: p.revision + 1,
    updatedAt: iso,
  };
  let landed = false;
  try {
    landed = await store.putPrediction(deps.grant, done, { revision: p.revision });
  } finally {
    if (!landed && judgment !== undefined) {
      await undoRecordedJudgment(deps.store, deps.grant, judgment, by, now);
    }
  }
  if (!landed) throw fail('conflict');
  return {
    prediction: done,
    agrees,
    ...(judgment !== undefined && { judgment }),
    ...(kept !== undefined && {
      agentJudgmentKept: kept,
      agentJudgmentKeptReason: 'not-writable' as const,
    }),
  };
}

/**
 * A person's resolve replacing an agent's unconfirmed one: the agent's resolve moves to
 * `superseded` (no reason or criteria kept) and the prediction is pending again, then the
 * judgment that resolve recorded is withdrawn, and so is any a superseded resolve recorded that
 * an earlier, interrupted call left current. A judgment outside the person's grant is left as it
 * is (unconfirmed, so judging leaves it out) and named in `kept`; this is decided before any
 * write. Returns the prediction as now stored.
 */
async function supersedeAgentResolve(
  deps: RecordJudgmentDeps,
  p: Prediction,
  by: string,
  now: Date,
): Promise<{ p: Prediction; kept?: string }> {
  const store = predictionsOf(deps.store);
  const r = p.resolution!;
  const iso = now.toISOString();
  const history = [
    ...(p.superseded ?? []),
    {
      verdict: r.verdict,
      by: r.by,
      at: r.at,
      via: r.via,
      ...(r.judgmentId !== undefined && { judgmentId: r.judgmentId }),
    },
  ];
  // Which of their judgments this grant can withdraw, before anything changes.
  const withdraw: Memory[] = [];
  let kept: string | undefined;
  for (const s of history) {
    if (s.judgmentId === undefined) continue;
    const m = await deps.store.get(deps.grant, s.judgmentId);
    if (m !== null && m.judgment?.withdrawn !== undefined) continue;
    if (m === null || !grantWrites(deps.grant, m)) {
      if (s === history[history.length - 1]) kept = s.judgmentId;
      continue;
    }
    withdraw.push(m);
  }
  const { resolution: _r, ...rest } = p;
  const reopened: Prediction = {
    ...rest,
    superseded: history,
    revision: p.revision + 1,
    updatedAt: iso,
  };
  if (!(await store.putPrediction(deps.grant, reopened, { revision: p.revision }))) {
    throw fail('conflict');
  }
  for (const m of withdraw) await withdrawJudgment(deps.store, deps.grant, m, by, now);
  return { p: reopened, ...(kept !== undefined && { kept }) };
}

/**
 * Confirms an agent-recorded resolve: a person (`by`, the operator) vouches that the expert
 * decided it. The judgment it recorded, if any, is confirmed first, then the resolve, so a call
 * that stopped half way is finished by the next one. The evaluation counts it from then on.
 * Returns false when the resolve was not agent-recorded or is already confirmed; fails
 * `conflict` when the prediction changed meanwhile.
 */
export async function confirmResolution(
  store: MemoryStore,
  grant: Grant,
  id: string,
  by: string,
  now = new Date(),
): Promise<boolean> {
  const s = predictionsOf(store);
  const who = scrub(judgmentField('by', by, JUDGMENT_LIMITS.by)).text;
  const p = await s.getPrediction(grant, id);
  if (p === null) throw fail('not-found');
  const r = p.resolution;
  if (r === undefined) throw fail('not-resolved');
  if (!isAgentVia(r.via) || r.confirmed !== undefined) return false;
  if (r.judgmentId !== undefined) {
    const m = await store.get(grant, r.judgmentId);
    if (m !== null) await confirmJudgment(store, grant, m, who, now);
  }
  const iso = now.toISOString();
  const ok = await s.putPrediction(
    grant,
    {
      ...p,
      resolution: { ...r, confirmed: { at: iso, by: who } },
      revision: p.revision + 1,
      updatedAt: iso,
    },
    { revision: p.revision },
  );
  if (!ok) throw fail('conflict');
  return true;
}

/** Deletes prediction `id` with its text. False for an unknown id or one outside the grant. */
export async function forgetPrediction(
  store: MemoryStore,
  grant: Grant,
  id: string,
): Promise<boolean> {
  return predictionsOf(store).forgetPrediction(grant, id);
}

// ---------------------------------------------------------------------------------------------
// Live evaluation: agreement and calibration from resolved predictions
// ---------------------------------------------------------------------------------------------

/** The lower edges of the confidence bands; each band runs to the next edge, the last to 1. */
export const CALIBRATION_BANDS: readonly number[] = Object.freeze([0, 0.5, 0.6, 0.7, 0.8, 0.9]);

/** Agreement among resolved predictions whose probability falls in [from, to). */
export interface CalibrationBand {
  from: number;
  /** Exclusive, except the last band, which includes 1. */
  to: number;
  /** Resolved predictions in the band. */
  predicted: number;
  /** Of those, how many the person agreed with. */
  agreed: number;
  /** `agreed / predicted`; null when the band is empty. */
  agreement: number | null;
  /** The mean predicted probability in the band; null when it is empty. Compare with `agreement`. */
  meanProbability: number | null;
}

export interface AgreementCount {
  /** Resolved predictions that had a predicted verdict. */
  predicted: number;
  agreed: number;
  /** `agreed / predicted`; null when none. */
  agreement: number | null;
}

/** How often people overruled predictions that leaned on a criterion. */
export interface CriterionDisagreement {
  criterion: string;
  /** Resolved predictions with a predicted verdict that carried the criterion. */
  predicted: number;
  disagreed: number;
  /** `disagreed / predicted`. */
  disagreement: number;
}

export interface LiveEvalReport {
  /** Resolves counted. */
  resolved: number;
  /** Agreement over every counted resolve with a predicted verdict. */
  overall: AgreementCount;
  /** Agreement over the ones judging suggested (at or above its threshold). */
  suggested: AgreementCount;
  /** Of the counted resolves, the share judging suggested a verdict for. */
  coverage: number | null;
  bands: CalibrationBand[];
  /** The criteria people overruled most, most disagreements first (at most `topCriteria`). */
  criteria: CriterionDisagreement[];
  /** The same numbers per domain (resolves without a domain under `(none)`). */
  domains: Record<string, AgreementCount & { resolved: number }>;
  /** Predictions still waiting for a person. */
  pending: number;
  /** Agent-recorded resolves nobody confirmed, left out (`includeAgentResolved` false). */
  agentResolvedExcluded: number;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

function counted(rows: readonly Prediction[]): AgreementCount {
  const predicted = rows.filter((p) => p.verdict !== null && p.resolution?.agrees !== null);
  const agreed = predicted.filter((p) => p.resolution?.agrees === true).length;
  return {
    predicted: predicted.length,
    agreed,
    agreement: predicted.length === 0 ? null : round(agreed / predicted.length),
  };
}

/**
 * Agreement, calibration and the most overruled criteria from `predictions` (pure: the records
 * in, the report out). Only resolved ones count; an agent-recorded resolve nobody confirmed is
 * left out unless `includeAgentResolved`. Probabilities are bucketed by `bands` (lower edges).
 */
export function evaluatePredictions(
  predictions: readonly Prediction[],
  opts: {
    now?: Date;
    domain?: string;
    includeAgentResolved?: boolean;
    bands?: readonly number[];
    topCriteria?: number;
  } = {},
): LiveEvalReport {
  const now = opts.now ?? new Date();
  const domain = opts.domain === undefined ? undefined : judgmentDomain(opts.domain);
  const inDomain = predictions.filter((p) => domain === undefined || p.domain === domain);
  const resolved = inDomain.filter((p) => p.resolution !== undefined);
  const unconfirmed = (p: Prediction) =>
    isAgentVia(p.resolution!.via) && p.resolution!.confirmed === undefined;
  const rows =
    opts.includeAgentResolved === true ? resolved : resolved.filter((p) => !unconfirmed(p));
  const edges = [...(opts.bands ?? CALIBRATION_BANDS)].sort((a, b) => a - b);
  const bands = edges.map((from, i): CalibrationBand => {
    const to = edges[i + 1] ?? 1;
    const last = i === edges.length - 1;
    const inBand = rows.filter(
      (p) =>
        p.probability !== null &&
        p.verdict !== null &&
        p.probability >= from &&
        (last ? p.probability <= to : p.probability < to),
    );
    const agreed = inBand.filter((p) => p.resolution!.agrees === true).length;
    return {
      from,
      to,
      predicted: inBand.length,
      agreed,
      agreement: inBand.length === 0 ? null : round(agreed / inBand.length),
      meanProbability:
        inBand.length === 0
          ? null
          : round(inBand.reduce((s, p) => s + p.probability!, 0) / inBand.length),
    };
  });
  const tally = new Map<string, { predicted: number; disagreed: number }>();
  for (const p of rows) {
    if (p.verdict === null) continue;
    for (const c of new Set([...p.criteria, ...p.resolution!.criteria])) {
      const t = tally.get(c) ?? { predicted: 0, disagreed: 0 };
      t.predicted++;
      if (p.resolution!.agrees === false) t.disagreed++;
      tally.set(c, t);
    }
  }
  const criteria = [...tally]
    .filter(([, t]) => t.disagreed > 0)
    .map(([criterion, t]) => ({
      criterion,
      predicted: t.predicted,
      disagreed: t.disagreed,
      disagreement: round(t.disagreed / t.predicted),
    }))
    .sort(
      (a, b) =>
        b.disagreed - a.disagreed ||
        b.disagreement - a.disagreement ||
        (a.criterion < b.criterion ? -1 : 1),
    )
    .slice(0, opts.topCriteria ?? 5);
  const domains: LiveEvalReport['domains'] = {};
  for (const d of [...new Set(rows.map((p) => p.domain ?? '(none)'))].sort()) {
    const ds = rows.filter((p) => (p.domain ?? '(none)') === d);
    domains[d] = { resolved: ds.length, ...counted(ds) };
  }
  const suggestedRows = rows.filter((p) => p.outcome === 'suggested');
  return {
    resolved: rows.length,
    overall: counted(rows),
    suggested: counted(suggestedRows),
    coverage: rows.length === 0 ? null : round(suggestedRows.length / rows.length),
    bands,
    criteria,
    domains,
    pending: inDomain.filter((p) => predictionState(p, now) === 'pending').length,
    agentResolvedExcluded: resolved.length - rows.length,
  };
}

/** `evaluatePredictions` over every prediction the grant reads. */
export async function evaluateLive(
  store: MemoryStore,
  grant: Grant,
  opts: Parameters<typeof evaluatePredictions>[1] = {},
): Promise<LiveEvalReport> {
  return evaluatePredictions(await predictionsOf(store).listPredictions(grant), opts);
}
