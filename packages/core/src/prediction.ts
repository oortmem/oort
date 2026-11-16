import type { MemoryStore } from './adapters.js';
import type { Address, Author } from './address.js';
import type { Grant } from './grant.js';
import {
  JudgmentInputError,
  confirmJudgment,
  isAgentVia,
  judgmentCriterion,
  judgmentDomain,
  judgmentField,
  judgmentLabel,
  JUDGMENT_LIMITS,
  recordJudgment,
  type JudgeResult,
  type JudgeWhy,
  type JudgmentVia,
  type RecordJudgmentDeps,
  type RecordJudgmentResult,
} from './judgment.js';
import type { Scope } from './model.js';
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
  /** Set when its text was purged (a cited judgment was withdrawn, purged or forgotten). */
  purged?: { at: string; by: string };
}

/** What `MemoryStore.listPredictions` filters by. */
export interface PredictionListOptions {
  /** `pending`: not resolved. `resolved`: resolved. Default: both. */
  status?: 'pending' | 'resolved';
  /** Only predictions citing this judgment id, as a precedent or as `resolution.judgmentId`. */
  citing?: string;
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
  return rows
    .filter(
      (p) =>
        (opts.status === undefined ||
          (opts.status === 'resolved') === (p.resolution !== undefined)) &&
        (citing === undefined || predictionCites(p, citing)),
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
 * - `unsupported`: the store keeps no predictions.
 */
export type PredictionErrorKind =
  | 'not-found'
  | 'ambiguous'
  | 'expired'
  | 'already-resolved'
  | 'purged'
  | 'not-resolved'
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
  const matches = (await s.listPredictions(grant)).filter((p) => p.id.startsWith(ref));
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
  return (await s.listPredictions(grant)).some((p) => p.id.startsWith(ref)) ? 'prefix' : 'none';
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
  const domain = opts.domain === undefined ? undefined : judgmentDomain(opts.domain);
  const all = await predictionsOf(store).listPredictions(grant, {
    ...(opts.status !== undefined && { status: opts.status }),
  });
  return all
    .filter(
      (p) =>
        (opts.status !== 'pending' || predictionState(p, now) === 'pending') &&
        (domain === undefined || p.domain === domain),
    )
    .slice(0, limit);
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
}

/**
 * Records a person's decision on prediction `id`. When their verdict is not the predicted one
 * (or judging predicted none) and they give a reason, the reason is recorded as a new judgment
 * of the item, verbatim, by `input.by`, so the next judging call can cite it. `deps.via` says how
 * it was recorded: `mcp` (an agent) leaves both the resolve and the judgment unconfirmed.
 *
 * Fails with `PredictionError` (`not-found`, `purged`, `already-resolved`, `expired`,
 * `unsupported`) or `JudgmentInputError` before writing anything. Two resolves of one
 * prediction never both land: the second fails `already-resolved`.
 */
export async function resolvePrediction(
  id: string,
  input: ResolveInput,
  deps: RecordJudgmentDeps & { via: JudgmentVia },
): Promise<ResolveResult> {
  const store = predictionsOf(deps.store);
  const now = deps.now ?? new Date();
  const p = await store.getPrediction(deps.grant, id);
  if (p === null) throw fail('not-found');
  if (p.purged !== undefined) throw fail('purged');
  if (p.resolution !== undefined) throw fail('already-resolved');
  if (predictionState(p, now) === 'expired') throw fail('expired');

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
  const resolution: PredictionResolution = {
    verdict,
    ...(reason !== undefined && { reason }),
    criteria,
    by,
    at: iso,
    via: deps.via,
    agrees,
  };
  const claimed: Prediction = { ...p, resolution, revision: p.revision + 1, updatedAt: iso };
  if (!(await store.putPrediction(deps.grant, claimed, { revision: p.revision }))) {
    const now2 = await store.getPrediction(deps.grant, id);
    throw fail(
      now2 === null ? 'not-found' : now2.purged !== undefined ? 'purged' : 'already-resolved',
    );
  }
  if (!records) return { prediction: claimed, agrees };

  let judgment: RecordJudgmentResult;
  try {
    judgment = await recordJudgment(
      {
        subject: p.item.summary,
        ...(p.item.ref !== undefined && { ref: p.item.ref }),
        verdict,
        verdicts: p.verdicts,
        reason: reason!,
        criteria,
        domain: domain!,
        by,
        decidedAt: iso,
      },
      deps,
    );
  } catch (e) {
    // Put the prediction back as it was: a failed resolve writes nothing.
    await store.putPrediction(
      deps.grant,
      { ...p, revision: claimed.revision + 1, updatedAt: iso },
      { revision: claimed.revision },
    );
    throw e;
  }
  const done: Prediction = {
    ...claimed,
    resolution: { ...resolution, judgmentId: judgment.memory.id },
    revision: claimed.revision + 1,
  };
  const linked = await store.putPrediction(deps.grant, done, { revision: claimed.revision });
  return { prediction: linked ? done : claimed, agrees, judgment };
}

/**
 * Confirms an agent-recorded resolve: a person (`by`, the operator) vouches that the expert
 * decided it. The evaluation counts it from then on, and the judgment it recorded, if any, is
 * confirmed too. Returns false when the resolve was not agent-recorded or is already confirmed.
 */
export async function confirmResolution(
  store: MemoryStore,
  grant: Grant,
  id: string,
  by: string,
  now = new Date(),
): Promise<boolean> {
  const s = predictionsOf(store);
  const p = await s.getPrediction(grant, id);
  if (p === null) throw fail('not-found');
  const r = p.resolution;
  if (r === undefined) throw fail('not-resolved');
  if (!isAgentVia(r.via) || r.confirmed !== undefined) return false;
  const iso = now.toISOString();
  const ok = await s.putPrediction(
    grant,
    {
      ...p,
      resolution: { ...r, confirmed: { at: iso, by } },
      revision: p.revision + 1,
      updatedAt: iso,
    },
    { revision: p.revision },
  );
  if (!ok) throw fail('not-found');
  if (r.judgmentId !== undefined) {
    const m = await store.get(grant, r.judgmentId);
    if (m !== null) {
      await confirmJudgment(store, grant, m, by, now);
    }
  }
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
