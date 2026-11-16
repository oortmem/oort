import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryStore } from './adapters.js';
import { withoutInvisible, type Feedback } from './feedback.js';
import type { Grant } from './grant.js';
import {
  isLabelOrigin,
  isUnconfirmedAgentJudgment,
  isAgentVia,
  labelOrigin,
  LABEL_ORIGINS,
  proposedOriginOf,
  type Judgment,
  type LabelOrigin,
  type LabelProvenance,
} from './judgment.js';
import { isCurrent, type Memory } from './model.js';
import type { Prediction, PredictionItem } from './prediction.js';
import { scrub } from './scrub.js';

/**
 * Training export: the labels people gave in Oort (judgments, resolves of predictions, recall
 * feedback) as JSON Lines a fine-tuning job reads. It collects nothing new; it reads the records
 * the caller's grant reads, leaves out what no person stands behind, and writes one file per kind
 * plus a manifest that counts every row it left out and why.
 *
 * - `sft`: one chat row per judgment a person made (`messages`: the item, then the verdict and
 *   the reason as the expert gave them);
 * - `preference`: one row per resolved prediction where the person chose another verdict than
 *   the one proposed (`prompt`, `chosen`: the person's verdict, `rejected`: the proposal;
 *   `preferenceReasons` adds the person's reason to `chosen`);
 * - `retrieval`: rows from recall feedback (`query`, `positive`, `negative`): an `irrelevant`
 *   row is a hard negative for its query, a `helped` row with a query a positive.
 *
 * Every row carries `origin` (how the label arrived) and, when set, `proposedOrigin` and
 * `reviewer`. Agent labels nobody confirmed never leave.
 */

export const TRAINING_KINDS = ['sft', 'preference', 'retrieval'] as const;
export type TrainingKind = (typeof TRAINING_KINDS)[number];

/** The format version a training export's manifest names. */
export const TRAINING_EXPORT_VERSION = 1;

/** The origins exported unless the caller adds `integration` or removes one. */
export const TRAINING_DEFAULT_ORIGINS: readonly LabelOrigin[] = Object.freeze([
  'interactive',
  'dashboard',
  'connector',
]);

/** The manifest's file name in the output directory. */
export const TRAINING_MANIFEST = 'manifest.json';

/**
 * Why a record was left out, by kind. Stable keys: tools may read them.
 * - `purged`: its text was purged (a judgment, or a prediction whose judgment was withdrawn or
 *   forgotten);
 * - `withdrawn`: a withdrawn judgment;
 * - `corrected`: a judgment the same expert later corrected;
 * - `not-current`: a judgment no longer (or not yet) current for another reason;
 * - `agent-unconfirmed`: an agent's label no person confirmed;
 * - `imported-from-pack`: a judgment imported from a pack or an export file, which names its
 *   expert only as the file states it;
 * - `pending`: a prediction nobody resolved yet, or feedback an agent gave that waits for a
 *   person;
 * - `expired`: a prediction nobody resolved before it expired;
 * - `no-proposal`: a resolved prediction for which judging proposed no verdict;
 * - `agreed`: the person chose the proposed verdict (no preference to learn);
 * - `dismissed`: feedback a person set aside;
 * - `not-a-retrieval-signal`: `wrong` or `stale` feedback, which says the memory is untrue, not
 *   that it was irrelevant;
 * - `helped-without-query`: `helped` feedback recorded without the query;
 * - `irrelevant-without-query`: `irrelevant` feedback without its query (only in a store edited
 *   by hand: Oort requires the query);
 * - `memory-forgotten`: feedback about a memory that is gone, or that the grant does not read;
 *   a resolve whose recorded judgment is gone;
 * - `contradictory`: `helped` and `irrelevant` feedback on the same memory for the same query;
 * - `invalid-time`: a label whose time is not an ISO date and time (a store edited by hand);
 * - `expert-not-selected`, `before-since`, `origin-not-selected`: left out by the filters.
 *
 * A resolve that recorded a judgment is left out when that judgment would be: `corrected`,
 * `withdrawn`, `purged`, `not-current`, or `memory-forgotten` when it is gone.
 */
export const TRAINING_EXCLUSIONS = [
  'purged',
  'withdrawn',
  'corrected',
  'not-current',
  'agent-unconfirmed',
  'imported-from-pack',
  'pending',
  'expired',
  'no-proposal',
  'agreed',
  'dismissed',
  'not-a-retrieval-signal',
  'helped-without-query',
  'irrelevant-without-query',
  'memory-forgotten',
  'contradictory',
  'invalid-time',
  'expert-not-selected',
  'before-since',
  'origin-not-selected',
] as const;
export type TrainingExclusion = (typeof TRAINING_EXCLUSIONS)[number];

/** A training export request that cannot run, or an output directory it will not write to. */
export class TrainingExportError extends Error {
  override readonly name = 'TrainingExportError';
  constructor(
    /**
     * `invalid`: an option is wrong (the message names it). `exists`: the directory holds files
     * of an earlier export (pass `force`). `not-a-directory`: the path is a file or a symlink.
     * `unsafe-directory`: an existing directory that other users can write to.
     * `store-changing`: the labels kept changing while the export ran (retry it).
     */
    readonly kind: 'invalid' | 'exists' | 'not-a-directory' | 'unsafe-directory' | 'store-changing',
    message: string,
  ) {
    super(message);
  }
}

const invalid = (m: string): TrainingExportError => new TrainingExportError('invalid', m);

export interface TrainingExportOptions {
  /** One kind, or `all`. */
  kind: TrainingKind | 'all';
  /** Only labels by this expert (a judgment's or a resolve's `by`, a feedback row's `by`). */
  expert?: string;
  /** Only labels made at or after this ISO time. */
  since?: string;
  /** `time:<fraction>`: the earliest `fraction` of each kind's rows to train, the rest to eval. */
  split?: string;
  /** Origins added to the default set; only `integration` adds anything. `agent` is refused. */
  include?: readonly string[];
  /** Origins removed from the set (mainly `interactive`). */
  exclude?: readonly string[];
  /**
   * Add the person's reason to a preference row's `chosen`. Off by default: `rejected` (the
   * proposal) has no reason, so a reason on one side only is a length cue, not a judgment.
   */
  preferenceReasons?: boolean;
}

/** The filters as checked: what the manifest records. */
export interface TrainingFilters {
  kind: TrainingKind | 'all';
  kinds: TrainingKind[];
  /** The origins exported. */
  origins: LabelOrigin[];
  include: LabelOrigin[];
  exclude: LabelOrigin[];
  expert: string | null;
  since: string | null;
  split: { by: 'time'; train: number } | null;
  /** `chosen` in preference rows holds the person's reason too. */
  preferenceReasons: boolean;
}

/** Checks `opts`; throws `TrainingExportError` (`invalid`) naming the option. */
export function trainingFilters(opts: TrainingExportOptions): TrainingFilters {
  if (typeof opts !== 'object' || opts === null) throw invalid('the options must be an object');
  const kind = opts.kind;
  if (kind !== 'all' && !(TRAINING_KINDS as readonly string[]).includes(kind)) {
    throw invalid(`kind must be one of: ${[...TRAINING_KINDS, 'all'].join(', ')}`);
  }
  const origins = (field: string, xs: readonly string[] | undefined): LabelOrigin[] => {
    if (xs === undefined) return [];
    if (!Array.isArray(xs)) throw invalid(`${field} must be a list of origins`);
    for (const x of xs) {
      if (!isLabelOrigin(x)) throw invalid(`${field} takes origins: ${LABEL_ORIGINS.join(', ')}`);
    }
    return [...new Set(xs as LabelOrigin[])];
  };
  const include = origins('include', opts.include);
  const exclude = origins('exclude', opts.exclude);
  if (include.includes('agent')) {
    throw invalid('agent labels are never exported: a person has not confirmed them');
  }
  const chosen = new Set<LabelOrigin>([...TRAINING_DEFAULT_ORIGINS, ...include]);
  for (const o of exclude) chosen.delete(o);
  let since: string | null = null;
  if (opts.since !== undefined) {
    const t = typeof opts.since === 'string' ? Date.parse(opts.since) : NaN;
    if (Number.isNaN(t)) throw invalid('since must be an ISO date or time');
    since = new Date(t).toISOString();
  }
  let expert: string | null = null;
  if (opts.expert !== undefined) {
    if (typeof opts.expert !== 'string' || opts.expert.trim() === '') {
      throw invalid('expert must name an expert');
    }
    // Cleaned as row text is: it is written to the manifest.
    expert = trainingText(opts.expert.trim());
  }
  return {
    kind,
    kinds: kind === 'all' ? [...TRAINING_KINDS] : [kind],
    origins: LABEL_ORIGINS.filter((o) => chosen.has(o)),
    include,
    exclude,
    expert,
    since,
    split: opts.split === undefined ? null : { by: 'time', train: trainingSplit(opts.split) },
    preferenceReasons: opts.preferenceReasons === true,
  };
}

/** The train fraction of `time:<fraction>` (above 0, below 1). */
export function trainingSplit(raw: string): number {
  const m = typeof raw === 'string' ? /^time:(0?\.\d+)$/.exec(raw.trim()) : null;
  const f = m === null ? NaN : Number(m[1]);
  if (!(f > 0 && f < 1)) {
    throw invalid('split must be time:<fraction>, the share to train on, above 0 and below 1');
  }
  return f;
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

/** How a row's label arrived, as every row carries it. */
interface LabelFields {
  origin: LabelOrigin;
  proposedOrigin?: LabelOrigin;
  reviewer?: string;
}

export interface SftRow extends LabelFields {
  messages: [{ role: 'user'; content: string }, { role: 'assistant'; content: string }];
  /** The judgment's id. */
  id: string;
  /** When the expert decided. */
  at: string;
  domain: string;
}

export interface PreferenceRow extends LabelFields {
  prompt: string;
  /** The person's verdict, with their reason when they gave one. */
  chosen: string;
  /** The verdict judging proposed. */
  rejected: string;
  /** The prediction's id. */
  id: string;
  /** When the person resolved it. */
  at: string;
  domain?: string;
}

export interface RetrievalRow extends LabelFields {
  query: string;
  /** A memory that helped for the query; null when no `helped` row has the same query. */
  positive: string | null;
  /** A memory that was irrelevant to the query; null for a positive with no negative left. */
  negative: string | null;
  /** The feedback row behind `negative` (or behind `positive`, when there is no negative). */
  id: string;
  /** The later of the two labels' times. */
  at: string;
  /** The `helped` row behind `positive`, when the row has both. */
  positiveId?: string;
  /** How that `helped` row arrived, when the row has both (`origin` is the negative's). */
  positiveOrigin?: LabelOrigin;
  positiveProposedOrigin?: LabelOrigin;
  positiveReviewer?: string;
}

type Row = (SftRow | PreferenceRow | RetrievalRow) & { at: string; id: string };

// oxlint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Text as a training row holds it: invisible, bidi and tag characters dropped first (so a secret
 * split by one is seen whole), line breaks as `\n`, other control characters dropped, then
 * scrubbed with the same scrubber the write path uses. Line breaks and tabs stay: a reason is
 * kept as the expert wrote it.
 */
export function trainingText(s: string): string {
  const visible = withoutInvisible(s)
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(CONTROL, '');
  return withoutInvisible(scrub(visible).text).replace(CONTROL, '');
}

/** One row's text fields cleaned, and whether any changed. */
class Cleaner {
  changed = false;
  text(s: string): string {
    const t = trainingText(s);
    if (t !== s) this.changed = true;
    return t;
  }
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A label's time as `toISOString` writes it, or undefined when it is not an ISO date and time. */
function isoTime(s: unknown): string | undefined {
  if (typeof s !== 'string' || !ISO_TIME.test(s)) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Why a judgment memory is not a label a person stands behind now, if it is not. */
function judgmentExclusion(m: Memory, now: Date): TrainingExclusion | undefined {
  const j = m.judgment!;
  return j.purged !== undefined
    ? 'purged'
    : j.withdrawn !== undefined
      ? 'withdrawn'
      : isUnconfirmedAgentJudgment(j)
        ? 'agent-unconfirmed'
        : j.pack !== undefined
          ? 'imported-from-pack'
          : m.endReason === 'corrected'
            ? 'corrected'
            : !isCurrent(m, now)
              ? 'not-current'
              : undefined;
}

/** A label's origin fields, cleaned (`reviewer` is stored text). */
function labelFields(r: LabelProvenance & { via?: string; confirmed?: unknown }, c: Cleaner) {
  const proposed = proposedOriginOf(r);
  return {
    origin: labelOrigin(r),
    ...(proposed !== undefined && { proposedOrigin: proposed }),
    ...(typeof r.reviewer === 'string' && { reviewer: c.text(r.reviewer) }),
  };
}

/** The item as a prompt: its summary, then its details and link when it has them. */
function itemText(item: Pick<PredictionItem, 'summary' | 'details' | 'ref'>, c: Cleaner): string {
  return [
    c.text(item.summary),
    ...(item.details !== undefined ? [c.text(item.details)] : []),
    ...(item.ref !== undefined ? [`Ref: ${c.text(item.ref)}`] : []),
  ].join('\n\n');
}

/** A decision as an answer: the verdict, then the reason as given. */
function decisionText(verdict: string, reason: string | undefined, c: Cleaner): string {
  const v = `Verdict: ${c.text(verdict)}`;
  return reason === undefined ? v : `${v}\nReason: ${c.text(reason)}`;
}

/** Counts by key, in a stable order when written. */
type Tally = Record<string, number>;
const bump = (t: Tally, k: string): void => {
  t[k] = (t[k] ?? 0) + 1;
};

/** What reading one kind found: its rows, what it left out and why, rows the cleaning changed. */
interface KindResult {
  rows: Row[];
  excluded: Tally;
  scrubbed: number;
}

/** Shared by the three kinds: the filters every label passes after its own checks. */
function filtered(
  f: TrainingFilters,
  label: { by: string; at: string; origin: LabelOrigin },
): TrainingExclusion | undefined {
  if (label.origin === 'agent') return 'agent-unconfirmed';
  if (f.expert !== null && label.by.trim() !== f.expert) return 'expert-not-selected';
  if (f.since !== null && !(Date.parse(label.at) >= Date.parse(f.since))) return 'before-since';
  if (!f.origins.includes(label.origin)) return 'origin-not-selected';
  return undefined;
}

function sftRows(memories: readonly Memory[], f: TrainingFilters, now: Date): KindResult {
  const out: KindResult = { rows: [], excluded: {}, scrubbed: 0 };
  for (const m of memories) {
    if (m.type !== 'judgment' || m.judgment === undefined) continue;
    const j: Judgment = m.judgment;
    const at = isoTime(j.decidedAt);
    const why: TrainingExclusion | undefined =
      judgmentExclusion(m, now) ??
      (at === undefined ? 'invalid-time' : filtered(f, { by: j.by, at, origin: labelOrigin(j) }));
    if (why !== undefined || at === undefined) {
      bump(out.excluded, why ?? 'invalid-time');
      continue;
    }
    const c = new Cleaner();
    const subject = itemText(j.subject, c);
    const row: SftRow = {
      messages: [
        { role: 'user', content: subject },
        { role: 'assistant', content: decisionText(j.verdict, j.reason, c) },
      ],
      id: m.id,
      at,
      domain: c.text(j.domain),
      ...labelFields(j, c),
    };
    if (c.changed) out.scrubbed++;
    out.rows.push(row);
  }
  return out;
}

function preferenceRows(
  predictions: readonly Prediction[],
  judgments: ReadonlyMap<string, Memory>,
  f: TrainingFilters,
  now: Date,
): KindResult {
  const out: KindResult = { rows: [], excluded: {}, scrubbed: 0 };
  for (const p of predictions) {
    const r = p.resolution;
    const at = r === undefined ? undefined : isoTime(r.at);
    // The judgment the resolve recorded speaks for it: a correction or withdrawal since wins.
    const recorded = r?.judgmentId === undefined ? undefined : judgments.get(r.judgmentId);
    const why: TrainingExclusion | undefined =
      p.purged !== undefined
        ? 'purged'
        : r === undefined
          ? Date.parse(p.expiresAt) <= now.getTime()
            ? 'expired'
            : 'pending'
          : isAgentVia(r.via) && r.confirmed === undefined
            ? 'agent-unconfirmed'
            : p.verdict === null || r.agrees === null
              ? 'no-proposal'
              : r.agrees
                ? 'agreed'
                : r.judgmentId !== undefined && recorded === undefined
                  ? 'memory-forgotten'
                  : ((recorded === undefined ? undefined : judgmentExclusion(recorded, now)) ??
                    (at === undefined
                      ? 'invalid-time'
                      : filtered(f, { by: r.by, at, origin: labelOrigin(r) })));
    if (why !== undefined || r === undefined || p.verdict === null || at === undefined) {
      bump(out.excluded, why ?? 'pending');
      continue;
    }
    const c = new Cleaner();
    const row: PreferenceRow = {
      prompt: itemText(p.item, c),
      chosen: decisionText(r.verdict, f.preferenceReasons ? r.reason : undefined, c),
      rejected: decisionText(p.verdict, undefined, c),
      id: p.id,
      at,
      ...(p.domain !== undefined && { domain: c.text(p.domain) }),
      ...labelFields(r, c),
    };
    if (c.changed) out.scrubbed++;
    out.rows.push(row);
  }
  return out;
}

/** A feedback row that passed every check, with its memory's text and its query, cleaned. */
interface Labelled {
  f: Feedback;
  /** The feedback's time, as `toISOString` writes it. */
  at: string;
  query: string;
  memory: string;
  label: LabelFields;
  changed: boolean;
}

async function retrievalRows(
  feedback: readonly Feedback[],
  memoryText: (id: string) => Promise<string | null>,
  f: TrainingFilters,
): Promise<KindResult> {
  const out: KindResult = { rows: [], excluded: {}, scrubbed: 0 };
  const negatives = new Map<string, Labelled[]>();
  const positives = new Map<string, Labelled[]>();
  for (const fb of feedback) {
    const at = isoTime(fb.createdAt);
    let why: TrainingExclusion | undefined =
      fb.status === 'pending'
        ? 'pending'
        : fb.status === 'dismissed'
          ? 'dismissed'
          : fb.signal !== 'irrelevant' && fb.signal !== 'helped'
            ? 'not-a-retrieval-signal'
            : fb.signal === 'helped' && (fb.query === undefined || fb.query.trim() === '')
              ? 'helped-without-query'
              : at === undefined
                ? 'invalid-time'
                : filtered(f, { by: fb.by, at, origin: labelOrigin(fb) });
    // An irrelevant row needs its query too: one without (a store edited by hand) pairs nothing.
    if (why === undefined && (fb.query === undefined || fb.query.trim() === '')) {
      why = 'irrelevant-without-query';
    }
    let text: string | null = null;
    if (why === undefined) {
      text = await memoryText(fb.memoryId);
      if (text === null) why = 'memory-forgotten';
    }
    if (why !== undefined || text === null || at === undefined) {
      bump(out.excluded, why ?? 'memory-forgotten');
      continue;
    }
    const c = new Cleaner();
    const query = c.text(fb.query!);
    const row: Labelled = {
      f: fb,
      at,
      query,
      memory: c.text(text),
      label: labelFields(fb, c),
      changed: c.changed,
    };
    const into = fb.signal === 'irrelevant' ? negatives : positives;
    into.set(query, [...(into.get(query) ?? []), row]);
  }
  const later = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b);
  const byTime = (a: Labelled, b: Labelled) => order(a.at, a.f.id, b.at, b.f.id);
  for (const query of [...new Set([...negatives.keys(), ...positives.keys()])].sort()) {
    // A memory marked both helped and irrelevant for one query says nothing: both rows stay out.
    const helped = new Set((positives.get(query) ?? []).map((l) => l.f.memoryId));
    const unhelpful = new Set((negatives.get(query) ?? []).map((l) => l.f.memoryId));
    const consistent = (l: Labelled): boolean => {
      if (!(helped.has(l.f.memoryId) && unhelpful.has(l.f.memoryId))) return true;
      bump(out.excluded, 'contradictory');
      return false;
    };
    const neg = (negatives.get(query) ?? []).filter(consistent).sort(byTime);
    const pos = (positives.get(query) ?? []).filter(consistent).sort(byTime);
    // Each negative is paired with a positive of the same query, in turn; positives left over
    // get a row of their own.
    for (const [i, n] of neg.entries()) {
      const p = pos.length === 0 ? undefined : pos[i % pos.length]!;
      out.rows.push({
        query,
        positive: p?.memory ?? null,
        negative: n.memory,
        id: n.f.id,
        at: p === undefined ? n.at : later(n.at, p.at),
        ...n.label,
        ...(p !== undefined && {
          positiveId: p.f.id,
          positiveOrigin: p.label.origin,
          ...(p.label.proposedOrigin !== undefined && {
            positiveProposedOrigin: p.label.proposedOrigin,
          }),
          ...(p.label.reviewer !== undefined && { positiveReviewer: p.label.reviewer }),
        }),
      } satisfies RetrievalRow);
      if (n.changed || p?.changed === true) out.scrubbed++;
    }
    for (const p of pos.slice(neg.length)) {
      out.rows.push({
        query,
        positive: p.memory,
        negative: null,
        id: p.f.id,
        at: p.at,
        ...p.label,
      } satisfies RetrievalRow);
      if (p.changed) out.scrubbed++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Split, files and manifest
// ---------------------------------------------------------------------------------------------

/** Oldest first; equal times by id, so the order (and every split) is the same on every run. */
function order(atA: string, idA: string, atB: string, idB: string): number {
  return Date.parse(atA) - Date.parse(atB) || (idA < idB ? -1 : idA > idB ? 1 : 0);
}

const sorted = (rows: readonly Row[]): Row[] =>
  [...rows].sort((a, b) => order(a.at, a.id, b.at, b.id));

/**
 * `rows` (sorted) split by time: the first `train` share to train, the rest to eval. Rows with
 * the same time never straddle the cut: their group goes to the side that holds most of it
 * (train on a tie), so every eval row is later than every train row.
 */
export function splitByTime<T extends { at: string }>(
  rows: readonly T[],
  train: number,
): { train: T[]; eval: T[] } {
  let k = Math.round(train * rows.length);
  const t = (i: number) => Date.parse(rows[i]!.at);
  if (k > 0 && k < rows.length && t(k - 1) === t(k)) {
    let s = k - 1;
    while (s > 0 && t(s - 1) === t(k)) s--;
    let e = k + 1;
    while (e < rows.length && t(e) === t(k)) e++;
    k = k - s >= e - k ? e : s;
  }
  return { train: rows.slice(0, k), eval: rows.slice(k) };
}

/**
 * `rows` (sorted) split by time in whole groups: every row with the same `key` lands on one side.
 * Groups are ordered by their latest row (then by key); the cut falls between groups, where the
 * train side comes closest to the `train` share (more train on a tie), never between groups with
 * the same latest time. The same rows always split the same way.
 */
export function splitByGroup<T extends { at: string }>(
  rows: readonly T[],
  train: number,
  key: (row: T) => string,
): { train: T[]; eval: T[] } {
  const groups = new Map<string, { key: string; t: number; n: number }>();
  for (const r of rows) {
    const k = key(r);
    const g = groups.get(k) ?? { key: k, t: -Infinity, n: 0 };
    g.t = Math.max(g.t, Date.parse(r.at));
    g.n++;
    groups.set(k, g);
  }
  const ordered = [...groups.values()].sort(
    (a, b) => a.t - b.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const target = Math.round(train * rows.length);
  let cut = 0;
  let best = 0;
  let sum = 0;
  for (let i = 0; i <= ordered.length; i++) {
    if (i > 0) sum += ordered[i - 1]!.n;
    if (i > 0 && i < ordered.length && ordered[i - 1]!.t === ordered[i]!.t) continue;
    if (Math.abs(sum - target) <= Math.abs(best - target)) {
      cut = i;
      best = sum;
    }
  }
  const trainKeys = new Set(ordered.slice(0, cut).map((g) => g.key));
  return {
    train: rows.filter((r) => trainKeys.has(key(r))),
    eval: rows.filter((r) => !trainKeys.has(key(r))),
  };
}

/** Per kind: rows written, by origin, and by split part when split. */
export interface TrainingCounts {
  rows: number;
  origins: Partial<Record<LabelOrigin, number>>;
  train?: { rows: number; origins: Partial<Record<LabelOrigin, number>> };
  eval?: { rows: number; origins: Partial<Record<LabelOrigin, number>> };
}

export interface TrainingFile {
  /** The file name in the output directory: `<kind>.jsonl`, or `<kind>.train.jsonl` / `.eval`. */
  name: string;
  kind: TrainingKind;
  part: 'all' | 'train' | 'eval';
  rows: number;
  /** sha256 of the file's bytes, hex. */
  sha256: string;
}

export interface TrainingManifest {
  oort: 'training-export';
  version: typeof TRAINING_EXPORT_VERSION;
  exportedAt: string;
  /** The Oort version that wrote it. */
  oortVersion: string;
  filters: TrainingFilters;
  files: TrainingFile[];
  counts: Partial<Record<TrainingKind, TrainingCounts>>;
  /** Records left out, by kind and reason (`TRAINING_EXCLUSIONS`). */
  excluded: Partial<Record<TrainingKind, Partial<Record<TrainingExclusion, number>>>>;
  /** Rows whose text the export's cleaning or scrubbing changed, by kind. */
  scrubbed: Partial<Record<TrainingKind, number>>;
  /** What a reader should know about the rows: with `preferenceReasons`, that `rejected` has none. */
  notes: string[];
}

export interface TrainingExport {
  manifest: TrainingManifest;
  /** Each file's name and contents, in the manifest's order. */
  contents: { name: string; text: string }[];
}

function originCount(rows: readonly Row[]): Partial<Record<LabelOrigin, number>> {
  const t: Tally = {};
  for (const r of rows) bump(t, r.origin);
  return Object.fromEntries(LABEL_ORIGINS.filter((o) => t[o] !== undefined).map((o) => [o, t[o]]));
}

const ordered = (t: Tally): Partial<Record<TrainingExclusion, number>> =>
  Object.fromEntries(TRAINING_EXCLUSIONS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));

const jsonl = (rows: readonly Row[]): string => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface BuildTrainingDeps {
  store: MemoryStore;
  /** What the export reads: nothing outside it, so never a project the grant does not cover. */
  grant: Grant;
  /** The Oort version, for the manifest. */
  version: string;
  now?: Date;
}

/**
 * Reads the labels the grant reads and builds the training export in memory: the files'
 * contents and the manifest. Throws `TrainingExportError` (`invalid`) for a bad option. A store
 * that keeps no predictions or no feedback has no rows of that kind.
 */
export async function buildTrainingExport(
  opts: TrainingExportOptions,
  deps: BuildTrainingDeps,
): Promise<TrainingExport> {
  return (await build(trainingFilters(opts), deps, deps.now ?? new Date())).exp;
}

/** The export, and the records behind its rows (`<kind>:<id>`), to check them again later. */
async function build(
  f: TrainingFilters,
  deps: BuildTrainingDeps,
  now: Date,
): Promise<{ exp: TrainingExport; sources: Set<string> }> {
  const { store, grant } = deps;
  const results = new Map<TrainingKind, KindResult>();
  const memories =
    f.kinds.includes('sft') || f.kinds.includes('preference')
      ? await store.list(grant, { validOnly: false, embeddings: false })
      : [];
  if (f.kinds.includes('sft')) results.set('sft', sftRows(memories, f, now));
  if (f.kinds.includes('preference')) {
    const rows =
      store.predictions === true && store.listPredictions !== undefined
        ? await store.listPredictions(grant)
        : [];
    const judgments = new Map(
      memories
        .filter((m) => m.type === 'judgment' && m.judgment !== undefined)
        .map((m) => [m.id, m]),
    );
    results.set('preference', preferenceRows(rows, judgments, f, now));
  }
  if (f.kinds.includes('retrieval')) {
    const rows =
      store.feedback === true && store.listFeedback !== undefined
        ? await store.listFeedback(grant)
        : [];
    const texts = new Map<string, string | null>();
    const memoryText = async (id: string): Promise<string | null> => {
      if (!texts.has(id)) texts.set(id, await readText(store, grant, id));
      return texts.get(id)!;
    };
    results.set('retrieval', await retrievalRows(rows, memoryText, f));
  }

  const manifest: TrainingManifest = {
    oort: 'training-export',
    version: TRAINING_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    oortVersion: deps.version,
    filters: f,
    files: [],
    counts: {},
    excluded: {},
    scrubbed: {},
    notes:
      f.preferenceReasons && f.kinds.includes('preference')
        ? [
            "preference: chosen holds the person's reason when they gave one; rejected (the proposed verdict) has no reason.",
          ]
        : [],
  };
  const contents: TrainingExport['contents'] = [];
  const sources = new Set<string>();
  const file = (kind: TrainingKind, part: TrainingFile['part'], rows: Row[]) => {
    const name = part === 'all' ? `${kind}.jsonl` : `${kind}.${part}.jsonl`;
    const text = jsonl(rows);
    manifest.files.push({ name, kind, part, rows: rows.length, sha256: sha256(text) });
    contents.push({ name, text });
  };
  for (const kind of f.kinds) {
    const r = results.get(kind)!;
    const rows = sorted(r.rows);
    for (const row of rows) {
      sources.add(`${kind}:${row.id}`);
      if ('positiveId' in row && row.positiveId !== undefined) {
        sources.add(`${kind}:${row.positiveId}`);
      }
    }
    const counts: TrainingCounts = { rows: rows.length, origins: originCount(rows) };
    if (f.split === null) file(kind, 'all', rows);
    else {
      // Retrieval splits by query, so one query's positives never sit on both sides.
      const s =
        kind === 'retrieval'
          ? splitByGroup(rows, f.split.train, (row) => (row as RetrievalRow).query)
          : splitByTime(rows, f.split.train);
      file(kind, 'train', s.train);
      file(kind, 'eval', s.eval);
      counts.train = { rows: s.train.length, origins: originCount(s.train) };
      counts.eval = { rows: s.eval.length, origins: originCount(s.eval) };
    }
    manifest.counts[kind] = counts;
    manifest.excluded[kind] = ordered(r.excluded);
    manifest.scrubbed[kind] = r.scrubbed;
  }
  return { exp: { manifest, contents }, sources };
}

/** A memory's full text (a cold memory's from its cold copy), or null when the grant reads none. */
async function readText(store: MemoryStore, grant: Grant, id: string): Promise<string | null> {
  const m = await store.get(grant, id);
  if (m === null) return null;
  if (m.tier !== 'cold') return m.text;
  try {
    return (await store.coldGet(grant, id))?.text ?? m.text;
  } catch {
    return m.text;
  }
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/** A file name a training export writes: the manifest, or `<kind>[.train|.eval].jsonl`. */
export function isTrainingExportFile(name: string): boolean {
  return (
    name === TRAINING_MANIFEST ||
    new RegExp(`^(?:${TRAINING_KINDS.join('|')})(?:\\.train|\\.eval)?\\.jsonl$`).test(name)
  );
}

const posix = process.platform !== 'win32';
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Writes `text` to a new file `file`, 0600, never through a symlink. */
function writeNew(file: string, text: string): void {
  const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | NOFOLLOW, 0o600);
  try {
    if (posix) fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** How many times `runTrainingExport` builds the export before it gives up (`store-changing`). */
export const TRAINING_EXPORT_ATTEMPTS = 3;

/** `dir` checked, and created when missing: whether this call made it, and the export there. */
interface Prepared {
  created: boolean;
  /** Files of an earlier export in `dir` (only with `force`; otherwise refused). */
  earlier: string[];
}

function prepareDir(dir: string, force: boolean): Prepared {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (st !== undefined && !st.isDirectory()) {
    throw new TrainingExportError(
      'not-a-directory',
      st.isSymbolicLink()
        ? 'The output path is a symlink; give the directory itself.'
        : 'The output path is a file, not a directory.',
    );
  }
  let created = false;
  if (st === undefined) {
    // Parents are made as mkdir makes them; the export's own directory is 0700 (umask aside).
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      created = true;
      if (posix) fs.chmodSync(dir, 0o700);
    } catch (e) {
      // Made meanwhile by someone else: checked as an existing directory below.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      st = fs.lstatSync(dir);
      if (!st.isDirectory()) {
        throw new TrainingExportError('not-a-directory', 'The output path is not a directory.');
      }
    }
  }
  if (st !== undefined && posix && (st.mode & 0o022) !== 0) {
    throw new TrainingExportError(
      'unsafe-directory',
      `The output directory is writable by other users (mode ${(st.mode & 0o777).toString(8).padStart(4, '0')}), so they could replace the export's files; use a directory only you can write to, or a new one.`,
    );
  }
  const earlier = fs.readdirSync(dir).filter(isTrainingExportFile).sort();
  if (earlier.length > 0 && !force) {
    throw new TrainingExportError(
      'exists',
      `The output directory already holds an export (${earlier.join(', ')}); pass force to replace it.`,
    );
  }
  for (const name of earlier) {
    if (fs.lstatSync(path.join(dir, name)).isDirectory()) {
      throw new TrainingExportError(
        'exists',
        `The output directory holds a directory named ${name}; move it away first.`,
      );
    }
  }
  return { created, earlier };
}

/** Each file of `exp` written complete under a temp name in `dir`: final name to temp path. */
function writeTemps(dir: string, exp: TrainingExport): Map<string, string> {
  const temps = new Map<string, string>();
  try {
    const files = [
      ...exp.contents,
      { name: TRAINING_MANIFEST, text: `${JSON.stringify(exp.manifest, null, 2)}\n` },
    ];
    for (const { name, text } of files) {
      const temp = path.join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
      writeNew(temp, text);
      temps.set(name, temp);
    }
    return temps;
  } catch (e) {
    removeTemps(temps);
    throw e;
  }
}

function removeTemps(temps: ReadonlyMap<string, string>): void {
  for (const temp of temps.values()) fs.rmSync(temp, { force: true });
}

/**
 * The complete temp files moved to their names, the manifest last. With `force`, files of the
 * earlier export that this one does not replace go only now, after every new file is complete;
 * the earlier manifest is the last of them, replaced by the new one.
 */
function commit(
  dir: string,
  temps: Map<string, string>,
  prepared: Prepared,
  force: boolean,
): string[] {
  if (!force) {
    // Refused when the export started; one that appeared since is not overwritten either.
    const now = fs.readdirSync(dir).filter(isTrainingExportFile);
    if (now.length > 0) {
      throw new TrainingExportError(
        'exists',
        `The output directory already holds an export (${now.sort().join(', ')}); pass force to replace it.`,
      );
    }
  }
  const written: string[] = [];
  for (const [name, temp] of temps) {
    if (name === TRAINING_MANIFEST) continue;
    const file = path.join(dir, name);
    fs.renameSync(temp, file);
    temps.delete(name);
    written.push(file);
  }
  for (const name of prepared.earlier) {
    if (name !== TRAINING_MANIFEST && !temps.has(name) && !written.includes(path.join(dir, name))) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
  const manifest = path.join(dir, TRAINING_MANIFEST);
  fs.renameSync(temps.get(TRAINING_MANIFEST)!, manifest);
  temps.delete(TRAINING_MANIFEST);
  written.push(manifest);
  return written;
}

/** After a failure: the temp files go, and so does `dir` when this call made it and it is empty. */
function cleanUp(dir: string, temps: ReadonlyMap<string, string>, prepared: Prepared): void {
  removeTemps(temps);
  if (prepared.created) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not empty, or gone: left as it is.
    }
  }
}

/**
 * Writes `exp` into `dir`, and nowhere else: one file per kind (or per kind and split part),
 * then `manifest.json`. A directory it creates is 0700; an existing one keeps its mode, and is
 * refused when group or others can write to it (`unsafe-directory`: they could swap the files).
 * Every file is 0600, written complete under a temp name first and then renamed, the manifest
 * last. A directory holding files of an earlier export is refused (`exists`) unless `force`,
 * which replaces them once the new files are complete; other files are left alone. `dir` must
 * not be a symlink or a file (`not-a-directory`). On a failure the temp files are removed and an
 * earlier export is left as it was. Returns the paths written.
 */
export function writeTrainingExport(
  dir: string,
  exp: TrainingExport,
  opts: { force?: boolean } = {},
): string[] {
  const force = opts.force === true;
  const prepared = prepareDir(dir, force);
  let temps = new Map<string, string>();
  try {
    temps = writeTemps(dir, exp);
    return commit(dir, temps, prepared, force);
  } catch (e) {
    cleanUp(dir, temps, prepared);
    throw e;
  }
}

/**
 * Builds the export and writes it into `dir` (as `writeTrainingExport`), without holding the
 * store's lock: once the files are written under temp names, every record behind a row is read
 * again, and when one would now be left out (forgotten, withdrawn, corrected meanwhile) the
 * export is built again from the start. After `TRAINING_EXPORT_ATTEMPTS` builds that kept
 * changing it fails (`store-changing`) and writes nothing. The files are a copy: a later forget
 * does not change them.
 */
export async function runTrainingExport(
  dir: string,
  opts: TrainingExportOptions,
  deps: BuildTrainingDeps,
  write: { force?: boolean } = {},
): Promise<{ export: TrainingExport; written: string[] }> {
  const f = trainingFilters(opts);
  const force = write.force === true;
  const prepared = prepareDir(dir, force);
  let temps = new Map<string, string>();
  try {
    for (let attempt = 1; attempt <= TRAINING_EXPORT_ATTEMPTS; attempt++) {
      const now = deps.now ?? new Date();
      const built = await build(f, deps, now);
      temps = writeTemps(dir, built.exp);
      const again = await build(f, deps, now);
      if ([...built.sources].every((k) => again.sources.has(k))) {
        return { export: built.exp, written: commit(dir, temps, prepared, force) };
      }
      removeTemps(temps);
      temps = new Map();
    }
  } catch (e) {
    cleanUp(dir, temps, prepared);
    throw e;
  }
  cleanUp(dir, temps, prepared);
  throw new TrainingExportError(
    'store-changing',
    `Labels kept being forgotten, withdrawn or corrected while the export ran (${TRAINING_EXPORT_ATTEMPTS} attempts); nothing was written. Run it again.`,
  );
}
