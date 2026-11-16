import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DISPLAY_UNSAFE_SOURCE,
  EVAL_THRESHOLDS,
  JudgmentInputError,
  JudgmentPackError,
  PredictionError,
  activeJudgments,
  confirmJudgment,
  confirmResolution,
  evaluateLive,
  findPrediction,
  PREDICTION_LIMITS,
  predictionMatch,
  forgetPrediction,
  listPredictions,
  predictionState,
  resolvePrediction,
  evaluateJudgments,
  formatJudgmentPack,
  importJudgmentPack,
  importJudgments,
  isActiveJudgment,
  isAgentVia,
  isUnconfirmedAgentJudgment,
  judge,
  agentEnvMarker,
  labelOrigin,
  proposedOriginOf,
  parseJudgmentPack,
  parseJudgmentRows,
  purgeJudgment,
  recordJudgment,
  withdrawJudgment,
  type JudgeOptions,
  type JudgeResult,
  type Judgment,
  type JudgmentInput,
  type LabelRecord,
  type LabelSource,
  type LiveEvalReport,
  type Memory,
  type Prediction,
  type RecordJudgmentResult,
} from '@oortmem/core';
import { emit, jsonMode, rawOut } from '../output.js';
import { DASHBOARD_JUDGMENTS_URL, cloudJudgeResult, cloudJudgmentView } from '../sdk/cloud.js';
import type { JudgmentView } from '../sdk/types.js';
import { uiFor } from '../ui.js';
import {
  Refusal,
  agentLabel,
  clip,
  cloudOf,
  confirm,
  echo,
  fixed,
  short,
  shown,
  warn,
  withWired,
  writeGrant,
  writeGrantFor,
  writeOwnerOnly,
  type Ctx,
} from '../util.js';
import type { Wired } from '../wire.js';
import type { Io } from '../io.js';

/**
 * `oort judge …`: judgment memory (CON-71). An expert's approve or reject decisions, with their
 * reasons verbatim, recorded explicitly and applied to new items with an honest "needs the
 * expert" when the precedents disagree or are too far. In cloud mode `list` and `apply` read
 * Oort Cloud as an agent, the key's role; a person confirms, discards and withdraws in the
 * dashboard; the rest is local only for now.
 */

/** Largest file `judge import`, `judge eval` and `judge pack import` read. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Refuses in cloud mode: what Oort Cloud does not hold yet (packs, imports, predictions). */
function localOnly(w: Wired): void {
  if (w.mode === 'cloud') {
    throw new Refusal(
      'This judgment command is local-only for now: Oort Cloud does not hold it yet (in cloud mode `oort judge list` and `oort judge apply` work). Run `oort cloud use --local` to use it.',
      { code: 'refused', reason: 'local-only' },
    );
  }
}

/**
 * Refuses a person's decision in cloud mode (R2): the Oort key on this machine acts as an agent,
 * so a record from here would be an unconfirmed agent's, not the person's. A person confirms,
 * discards and withdraws in the dashboard; agents record over MCP or the SDK.
 */
function personInCloud(w: Wired, what: string): void {
  if (w.mode === 'cloud') {
    throw new Refusal(
      what === 'records'
        ? `In Oort Cloud the Oort key on this machine acts as an agent, so it cannot record a person's judgment. Agents record over MCP or the SDK, and a person confirms those records in the dashboard: ${DASHBOARD_JUDGMENTS_URL}.`
        : `In Oort Cloud a person ${what} judgments in the dashboard: ${DASHBOARD_JUDGMENTS_URL}. The Oort key on this machine acts as an agent, so it cannot do this for you.`,
      { code: 'refused', reason: 'expert-only' },
    );
  }
}

/** A `JudgmentInputError` or `JudgmentPackError` as a refusal (their messages name fields, not values). */
async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof JudgmentInputError || e instanceof JudgmentPackError) {
      throw new Refusal(e.message);
    }
    if (e instanceof PredictionError) {
      throw new Refusal(
        e.message,
        e.kind === 'not-found'
          ? { code: 'not-found', fix: 'oort judge predictions --all' }
          : e.kind === 'ambiguous'
            ? { code: 'ambiguous-id' }
            : { code: 'refused' },
      );
    }
    throw e;
  }
}

const list = (raw: string | undefined): string[] | undefined =>
  raw === undefined
    ? undefined
    : raw
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x !== '');

function number(flag: string, raw: string | undefined, lo: number, hi: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < lo || n > hi) {
    throw new Refusal(`${flag} must be a number from ${lo} to ${hi}.`);
  }
  return n;
}

function readInput(io: Io, file: string): string {
  const p = path.resolve(io.cwd, file);
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw new Refusal(`Cannot read ${echo(file)}.`);
  }
  if (!st.isFile()) throw new Refusal(`${echo(file)} is not a file.`);
  if (st.size > MAX_FILE_BYTES) throw new Refusal(`${echo(file)} is larger than 20 MB.`);
  return fs.readFileSync(p, 'utf8');
}

function formatOf(file: string, flag: string | undefined): 'csv' | 'jsonl' {
  const f = flag ?? (/\.csv$/i.test(file) ? 'csv' : 'jsonl');
  if (f !== 'csv' && f !== 'jsonl') throw new Refusal('--format must be csv or jsonl.');
  return f;
}

/** A judgment for human eyes: every stored string through `shown`. */
function judgmentLine(
  j: Pick<Judgment, 'verdict' | 'subject' | 'domain' | 'by' | 'decidedAt'>,
): string {
  return `${shown(j.verdict)} "${shown(clip(j.subject.summary, 70))}" (${shown(j.domain)}, by ${shown(j.by)}, ${shown(j.decidedAt.slice(0, 10))})`;
}

/** Characters an operator id may not hold: controls, bidi and invisible format characters. */
const OPERATOR_UNSAFE = new RegExp(DISPLAY_UNSAFE_SOURCE);

/**
 * Who withdraws, confirms or purges from this machine: `--by`, else `judge.operator` in the home
 * config, else `local-user`. Never the expert who made the judgment.
 */
export function operatorOf(w: Wired, flag: string | undefined): string {
  const by = flag ?? w.config.judge.operator ?? 'local-user';
  if (by.trim() === '' || by.length > 128 || OPERATOR_UNSAFE.test(by)) {
    throw new Refusal('--by must be one line of text, at most 128 characters.');
  }
  return by.trim();
}

/**
 * Whether this command may ask a person to vouch for one label: stdin and stdout are terminals,
 * neither `--yes` nor `--json` was given, no agent harness is running it (`AGENT_ENV_MARKERS`),
 * and there is a controlling terminal to ask on.
 */
function mayAskForLabel(ctx: Ctx, yes: boolean | undefined): boolean {
  return (
    ctx.io.stdinIsTTY &&
    ctx.io.stdoutIsTTY === true &&
    !jsonMode(ctx) &&
    yes !== true &&
    agentEnvMarker(ctx.io.env) === undefined &&
    ctx.io.askTerminal !== undefined
  );
}

const said = (answer: string): boolean => ['y', 'yes'].includes(answer.trim().toLowerCase());

/**
 * A question as the terminal shows it: every control, escape and invisible character escaped
 * (`shown`), its own line breaks kept, so no value in it can rewrite what the person reads.
 */
const asked = (question: string): string => `${shown(question, { newlines: true })} [y/N] `;

/**
 * The label a command that did not ask before records: when it may ask (`mayAskForLabel`), it
 * asks `question` (which names the label) on the controlling terminal, never stdin. `interactive`
 * when the person said yes; null when they said no, and nothing is written. Otherwise, without
 * asking, `integration`. It says how the label arrived, not that a person typed it (whatever
 * drives the terminal answers), and grants nothing.
 */
export async function askLabel(
  ctx: Ctx,
  question: string,
  yes?: boolean,
): Promise<LabelSource | null> {
  if (!mayAskForLabel(ctx, yes)) return { origin: 'integration' };
  const answer = await ctx.io.askTerminal!(asked(question));
  if (answer === undefined) return { origin: 'integration' };
  return said(answer) ? { origin: 'interactive' } : null;
}

/**
 * The label a command that always confirms records. When it may ask (`mayAskForLabel`), it asks
 * `question` on the controlling terminal: `interactive` on yes. Otherwise it confirms as before
 * (`--yes`, or a question on stdin, refused without a terminal): `integration`. Null when the
 * person said no: nothing is written.
 */
export async function confirmLabel(
  ctx: Ctx,
  question: string,
  yes: boolean | undefined,
  flagHint: string,
): Promise<LabelSource | null> {
  if (mayAskForLabel(ctx, yes)) {
    const answer = await ctx.io.askTerminal!(asked(question));
    if (answer !== undefined) return said(answer) ? { origin: 'interactive' } : null;
  }
  const ok = await confirm(ctx.io, shown(question, { newlines: true }), yes === true, flagHint, {
    json: jsonMode(ctx),
  });
  return ok ? { origin: 'integration' } : null;
}

/**
 * How a label arrived, as `--json` shows it: `origin` always (see `labelOrigin` for older rows,
 * and for a stored value that is not an origin), and the rest when set.
 */
export function originFields(r: LabelRecord) {
  const proposed = proposedOriginOf(r);
  return {
    origin: labelOrigin(r),
    ...(r.reviewer !== undefined && { reviewer: r.reviewer }),
    ...(r.upstream !== undefined && { upstream: { ...r.upstream } }),
    ...(proposed !== undefined && { proposedOrigin: proposed }),
  };
}

/** How a label arrived, on a line: ` [origin interactive, proposed agent]`. */
export function originTag(r: LabelRecord): string {
  const parts = [`origin ${shown(labelOrigin(r))}`];
  if (r.reviewer !== undefined) parts.push(`reviewer ${shown(r.reviewer)}`);
  if (r.upstream !== undefined) {
    parts.push(`from ${shown(r.upstream.system)} (${shown(r.upstream.actor)})`);
  }
  const proposed = proposedOriginOf(r);
  if (proposed !== undefined) parts.push(`proposed ${shown(proposed)}`);
  return ` [${parts.join(', ')}]`;
}

/** How a precedent or judgment was recorded, for labels. */
function recordedLabel(j: Pick<Judgment, 'via' | 'confirmed'>): string {
  if (!isAgentVia(j.via)) return '';
  return j.confirmed === undefined
    ? ' [agent-recorded, unconfirmed]'
    : ` [agent-recorded, confirmed by ${shown(j.confirmed.by)}]`;
}

function plainJudgment(m: Memory & { judgment: Judgment }) {
  return { id: m.id, ...m.judgment, ...originFields(m.judgment), current: m.expiredAt === null };
}

export interface JudgeRecordOptions {
  subject?: string;
  ref?: string;
  verdict?: string;
  verdicts?: string;
  reason?: string;
  criteria?: string;
  domain?: string;
  by?: string;
  decidedAt?: string;
  corrects?: string;
  json?: boolean;
  yes?: boolean;
}

/** `oort judge record`: one judgment, as the expert stated it. */
export async function judgeRecordCommand(o: JudgeRecordOptions, ctx: Ctx): Promise<number> {
  for (const f of ['subject', 'verdict', 'reason', 'domain', 'by'] as const) {
    if (o[f] === undefined) throw new Refusal(`--${f} is required.`);
  }
  const verdicts = list(o.verdicts);
  const criteria = list(o.criteria);
  const input: JudgmentInput = {
    subject: o.subject!,
    verdict: o.verdict!,
    reason: o.reason!,
    domain: o.domain!,
    by: o.by!,
    ...(o.ref !== undefined && { ref: o.ref }),
    ...(verdicts !== undefined && { verdicts }),
    ...(criteria !== undefined && { criteria }),
    ...(o.decidedAt !== undefined && { decidedAt: o.decidedAt }),
  };
  return withWired(ctx, async (w) => {
    personInCloud(w, 'records');
    const grant = writeGrant(w);
    let corrects: Memory | undefined;
    if (o.corrects !== undefined) {
      corrects = await findJudgment(w, o.corrects);
      if (!isActiveJudgment(corrects, new Date())) {
        throw new Refusal(
          `${short(corrects.id)} is not a current judgment; record a new one instead.`,
        );
      }
      writeGrantFor(w, corrects);
    }
    const label = await askLabel(
      ctx,
      `Record ${shown(o.verdict!)} for "${shown(clip(o.subject!, 120))}" (${shown(o.domain!)}, by ${shown(o.by!)})?${corrects === undefined ? '' : ` It corrects ${short(corrects.id)}.`}`,
      o.yes,
    );
    if (label === null) {
      ctx.io.out('Nothing recorded.\n');
      return 0;
    }
    const r = await refusing(() =>
      recordJudgment(input, {
        store: w.store,
        grant,
        scope: w.scope,
        ...(w.embed !== undefined && { embed: w.embed }),
        via: 'cli',
        harness: 'cli',
        label,
        ...(corrects !== undefined && { corrects }),
      }),
    );
    reportRecorded(ctx, w, r, jsonMode(ctx));
    return 0;
  });
}

function reportRecorded(ctx: Ctx, w: Wired, r: RecordJudgmentResult, json: boolean): void {
  if (r.redacted.length > 0) {
    warn(ctx, 'redacted', `redacted a secret (${r.redacted.join(', ')}) before saving.`);
  }
  if (r.outcome !== 'unchanged' && w.embed === undefined) {
    warn(
      ctx,
      'lexical-only',
      'no embedder, so this judgment is matched by its words only (lexical).',
    );
  }
  if (r.embedFailed === true) {
    warn(
      ctx,
      'embed-failed',
      'the embedder failed; the judgment is saved and matched by its words only.',
    );
  }
  if (json) {
    emit(ctx, {
      outcome: r.outcome,
      id: r.memory.id,
      ...(r.supersedes !== undefined && { supersedes: r.supersedes }),
      judgment: r.memory.judgment,
    });
    return;
  }
  const j = r.memory.judgment!;
  if (r.outcome === 'unchanged') {
    ctx.io.out(`Already recorded as ${short(r.memory.id)}: ${judgmentLine(j)}. Nothing changed.\n`);
  } else if (r.outcome === 'corrected') {
    ctx.io.out(
      `Recorded ${short(r.memory.id)}: ${judgmentLine(j)}. It corrects ${short(r.supersedes!)}, which no longer counts.\n`,
    );
  } else {
    ctx.io.out(`Recorded ${short(r.memory.id)}: ${judgmentLine(j)}.\n`);
  }
}

/** A prefix that matches both a judgment and a prediction. */
function ambiguousKinds(ref: string): Refusal {
  return new Refusal(
    `${echo(ref)} matches both a judgment and a prediction; give more of the id (\`oort judge list --all\` and \`oort judge predictions --all\` show them).`,
    { code: 'ambiguous-id', fix: 'oort judge predictions --all' },
  );
}

/** The judgment `ref` names (an id or unique prefix), current or not. */
async function findJudgment(w: Wired, ref: string): Promise<Memory & { judgment: Judgment }> {
  const all = (await w.store.list(writeGrant(w), { validOnly: false, embeddings: false })).filter(
    (m): m is Memory & { judgment: Judgment } => m.type === 'judgment' && m.judgment !== undefined,
  );
  const exact = all.find((m) => m.id === ref);
  if (exact !== undefined) return exact;
  const matches = all.filter((m) => m.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Refusal(`${echo(ref)} matches ${matches.length} judgments; give more of the id.`, {
      code: 'ambiguous-id',
    });
  }
  throw new Refusal(`No such judgment: ${echo(ref)}.`, {
    code: 'not-found',
    fix: 'oort judge list --all',
  });
}

export interface JudgeApplyOptions {
  details?: string;
  ref?: string;
  domain?: string;
  by?: string;
  k?: string;
  threshold?: string;
  minSimilarity?: string;
  includeImported?: boolean;
  includeAgentRecorded?: boolean;
  json?: boolean;
}

function judgeOptions(o: {
  k?: string;
  threshold?: string;
  minSimilarity?: string;
  includeImported?: boolean;
  includeAgentRecorded?: boolean;
}): JudgeOptions {
  const k = number('--k', o.k, 1, 20);
  const threshold = number('--threshold', o.threshold, 0, 1);
  const minSimilarity = number('--min-similarity', o.minSimilarity, 0, 1);
  return {
    ...(k !== undefined && { k: Math.round(k) }),
    ...(threshold !== undefined && { threshold }),
    ...(minSimilarity !== undefined && { minSimilarity }),
    ...(o.includeImported === true && { includeImported: true }),
    ...(o.includeAgentRecorded === true && { includeAgentRecorded: true }),
  };
}

const WHY: Record<NonNullable<JudgeResult['why']>, string> = {
  'no-precedents': 'no judgments are recorded for this domain or expert yet',
  'too-far': 'no recorded judgment is close enough to this item',
  'too-few': 'fewer than two close judgments back an answer',
  'precedents-disagree': 'the closest judgments disagree',
  'low-confidence': 'the prediction is below the confidence threshold',
  'no-decider':
    'no TypeSafe key, so no prediction (set TYPESAFE_API_KEY or run `oort keys set typesafe`)',
  'decider-failed': 'the prediction call failed',
};

/** `oort judge apply <item>`: the expert's likely verdict, with the precedents behind it. */
export async function judgeApplyCommand(
  summary: string,
  o: JudgeApplyOptions,
  ctx: Ctx,
): Promise<number> {
  const opts = judgeOptions(o);
  return withWired(ctx, async (w) => {
    if (w.mode === 'cloud') return judgeApplyInCloud(ctx, w, summary, o, opts);
    const r = await refusing(() =>
      judge(
        {
          summary,
          ...(o.details !== undefined && { details: o.details }),
          ...(o.ref !== undefined && { ref: o.ref }),
          ...(o.domain !== undefined && { domain: o.domain }),
          ...(o.by !== undefined && { by: o.by }),
        },
        {
          store: w.store,
          grant: writeGrant(w),
          ...(w.embed !== undefined && { embed: w.embed }),
          ...(w.decide !== undefined && { decide: w.decide }),
          // Kept as a prediction, so the expert's decision can be recorded beside it.
          keep: { scope: w.scope },
        },
        opts,
      ),
    );
    if (jsonMode(ctx)) {
      emit(ctx, r);
      return 0;
    }
    printJudgeResult(ctx, w, r);
    if (r.predictionId !== undefined) {
      ctx.io.out(
        `\nKept as prediction ${short(r.predictionId)}. When the expert decides: \`oort judge resolve ${short(r.predictionId)} --verdict <label> [--reason <text>]\`${w.scope.projectId === undefined ? '' : " in this project's directory"}.\n`,
      );
    } else if (r.kept === false) {
      ctx.io.out(
        r.notKept === 'pending-cap'
          ? `\nNot kept as a prediction: ${PREDICTION_LIMITS.pending} wait for a decision already (\`oort judge predictions\`).\n`
          : '\nNot kept as a prediction: it could not be saved. The answer is the same.\n',
      );
    }
    return 0;
  });
}

/** `oort judge apply` in cloud mode: Oort Cloud judges from the account's judgments. */
async function judgeApplyInCloud(
  ctx: Ctx,
  w: Wired,
  summary: string,
  o: JudgeApplyOptions,
  opts: JudgeOptions,
): Promise<number> {
  const r = cloudJudgeResult(
    await cloudOf(w)!.applyJudgments({
      item: {
        summary,
        ...(o.details !== undefined && { details: o.details }),
        ...(o.ref !== undefined && { ref: o.ref }),
        ...(o.domain !== undefined && { domain: o.domain }),
        ...(o.by !== undefined && { by: o.by }),
      },
      ...(opts.k !== undefined && { limit: opts.k }),
      ...(opts.threshold !== undefined && { threshold: opts.threshold }),
      ...(opts.minSimilarity !== undefined && { minSimilarity: opts.minSimilarity }),
      ...(opts.includeImported === true && { includeImported: true }),
      ...(opts.includeAgentRecorded === true && { includeAgentRecorded: true }),
    }),
  );
  if (jsonMode(ctx)) {
    emit(ctx, r);
    return 0;
  }
  // The same fields as core's result: the view only scrubbed its text again.
  printJudgeResult(ctx, w, r as unknown as JudgeResult);
  return 0;
}

function printJudgeResult(ctx: Ctx, w: Wired, r: JudgeResult): void {
  const ui = uiFor(ctx.io);
  const n = r.precedents.filter((p) => p.near).length;
  const experts = [...new Set(r.precedents.map((p) => p.by))].map((b) => shown(b)).join(', ');
  ctx.io.out(ui.header('judge', shown(r.status), agentLabel(w)));
  if (r.status === 'suggested' && r.prediction !== undefined) {
    ctx.io.out(
      `${ui.bold(`Prediction: ${shown(r.prediction.verdict)}`)} (probability ${fixed(r.prediction.probability)}), from ${n} precedent${n === 1 ? '' : 's'}. A prediction, not ${experts}'s decision.\n`,
    );
  } else if (r.status === 'precedents-only') {
    ctx.io.out(`Precedents only: ${WHY['no-decider']}.\n`);
  } else {
    ctx.io.out(`${ui.bold('Needs the expert')}: ${WHY[r.why ?? 'low-confidence']}.\n`);
    if (r.why === 'low-confidence' && r.prediction !== undefined) {
      ctx.io.out(
        `It leans ${shown(r.prediction.verdict)} at ${fixed(r.prediction.probability)}, below ${fixed(r.threshold)}.\n`,
      );
    }
    if (r.why === 'too-few' && r.prediction !== undefined) {
      ctx.io.out(
        `It leans ${shown(r.prediction.verdict)} at ${fixed(r.prediction.probability)}, but a suggestion needs two close judgments that agree.\n`,
      );
    }
    if (r.why === 'precedents-disagree') {
      const split = Object.entries(r.agreement)
        .map(([v, s]) => `${shown(v)} ${fixed(s)}`)
        .join(', ');
      ctx.io.out(`Weighted by similarity: ${split}.\n`);
    }
  }
  if (r.importedExcluded !== undefined && r.status !== 'suggested') {
    ctx.io.out(
      `${r.importedExcluded} imported judgment(s) were not used: a pack's experts are as its exporter states them. Add --include-imported to use them.\n`,
    );
  }
  if (r.agentRecordedExcluded !== undefined && r.status !== 'suggested') {
    ctx.io.out(
      w.mode === 'cloud'
        ? `${r.agentRecordedExcluded} agent-recorded judgment(s) nobody confirmed were not used: a person confirms them in the dashboard (${DASHBOARD_JUDGMENTS_URL}), or add --include-agent-recorded.\n`
        : `${r.agentRecordedExcluded} agent-recorded judgment(s) nobody confirmed were not used: confirm one with \`oort judge confirm <id>\`, or add --include-agent-recorded.\n`,
    );
  }
  if (r.precedents.length === 0) return;
  const near = r.precedents.some((p) => p.near);
  ctx.io.out(
    `\n${near ? 'Precedents' : 'Nearest judgments (none close enough)'} (${r.similarity} similarity, at least ${fixed(r.minSimilarity)} counts):\n`,
  );
  for (const [i, p] of r.precedents.entries()) {
    const mark = p.agrees === undefined ? '' : p.agrees ? ' agrees' : ' differs';
    const from = p.pack === undefined ? '' : `, imported from pack ${shown(p.pack.name)}`;
    const agent = !isAgentVia(p.via)
      ? ''
      : p.confirmed
        ? ', agent-recorded (confirmed)'
        : ', agent-recorded (unconfirmed)';
    ctx.io.out(
      `${i + 1}. ${shown(p.verdict)}  ${fixed(p.similarity)}${mark}  "${shown(clip(p.subject.summary, 70))}"  by ${shown(p.by)}, ${shown(p.decidedAt.slice(0, 10))}${from}${agent}  ${shown(short(p.id))}\n`,
    );
    ctx.io.out(`   reason: ${shown(clip(p.reason, 200))}\n`);
  }
}

/** `oort judge list`: the judgments this agent reads, current ones unless `--all`. */
export async function judgeListCommand(
  o: { domain?: string; by?: string; all?: boolean; json?: boolean },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    if (w.mode === 'cloud') return judgeListInCloud(ctx, w, o);
    const now = new Date();
    const items = await refusing(async () =>
      o.all === true
        ? (await w.store.list(writeGrant(w), { validOnly: false, embeddings: false })).filter(
            (m): m is Memory & { judgment: Judgment } =>
              m.type === 'judgment' &&
              m.judgment !== undefined &&
              (o.domain === undefined || m.judgment.domain === o.domain.toLowerCase()) &&
              (o.by === undefined || m.judgment.by === o.by),
          )
        : activeJudgments(
            w.store,
            writeGrant(w),
            { ...o, includeImported: true, includeAgentRecorded: true },
            now,
            false,
          ),
    );
    if (jsonMode(ctx)) {
      emit(ctx, { judgments: items.map(plainJudgment) });
      return 0;
    }
    const ui = uiFor(ctx.io);
    ctx.io.out(
      ui.header(
        'judgments',
        `${items.length} ${o.all === true ? 'recorded' : 'current'}`,
        agentLabel(w),
      ),
    );
    if (items.length === 0) {
      ctx.io.err('oort: no judgments yet; record one with `oort judge record`.\n');
      return 0;
    }
    for (const m of items) {
      const state =
        (m.judgment.purged !== undefined
          ? ' [purged]'
          : m.judgment.withdrawn !== undefined
            ? ' [withdrawn]'
            : m.endReason === 'corrected'
              ? ` [corrected by ${short(m.supersededBy ?? '')}]`
              : '') +
        recordedLabel(m.judgment) +
        (m.judgment.pack === undefined
          ? ''
          : ` [imported from pack ${shown(m.judgment.pack.name)}]`) +
        originTag(m.judgment);
      ctx.io.out(`${short(m.id)}  ${judgmentLine(m.judgment)}${state}\n`);
      ctx.io.out(`          reason: ${shown(clip(m.judgment.reason, 200))}\n`);
    }
    return 0;
  });
}

/** At most this many judgments `oort judge list` shows from Oort Cloud (one page of the API). */
const CLOUD_LIST_LIMIT = 100;

/** `oort judge list` in cloud mode: the account's judgments, as Oort Cloud lists them. */
async function judgeListInCloud(
  ctx: Ctx,
  w: Wired,
  o: { domain?: string; by?: string; all?: boolean },
): Promise<number> {
  const r = await cloudOf(w)!.listJudgments({
    ...(o.domain !== undefined && { domain: o.domain }),
    ...(o.by !== undefined && { by: o.by }),
    ...(o.all === true && { all: true }),
    limit: CLOUD_LIST_LIMIT,
  });
  const items = (Array.isArray(r.judgments) ? r.judgments : []).map(cloudJudgmentView);
  if (jsonMode(ctx)) {
    emit(ctx, {
      judgments: items.map((j) => ({ ...j, current: j.status === 'current' })),
      ...(typeof r.next === 'string' && { truncated: true }),
    });
    return 0;
  }
  const ui = uiFor(ctx.io);
  ctx.io.out(
    ui.header(
      'judgments',
      `${items.length} ${o.all === true ? 'recorded' : 'current'}`,
      agentLabel(w),
    ),
  );
  if (items.length === 0) {
    ctx.io.err(
      `oort: no judgments yet. Agents record them over MCP or the SDK, unconfirmed until a person confirms them in the dashboard (${DASHBOARD_JUDGMENTS_URL}).\n`,
    );
    return 0;
  }
  for (const j of items) ctx.io.out(cloudJudgmentLines(j));
  if (typeof r.next === 'string') {
    ctx.io.out(`Only the newest ${CLOUD_LIST_LIMIT} are shown; the dashboard lists them all.\n`);
  }
  return 0;
}

/** One listed cloud judgment, as `oort judge list` prints a local one. */
function cloudJudgmentLines(j: JudgmentView & { id: string }): string {
  const state =
    (j.status === 'withdrawn' ? ' [withdrawn]' : j.status === 'corrected' ? ' [corrected]' : '') +
    (!isAgentVia(j.via)
      ? ''
      : j.agentRecorded
        ? ' [agent-recorded, unconfirmed]'
        : ' [agent-recorded, confirmed]') +
    (j.pack === undefined ? '' : ` [imported from pack ${shown(j.pack.name)}]`) +
    originTag(j);
  return (
    `${shown(short(j.id))}  ${judgmentLine(j)}${state}\n` +
    `          reason: ${shown(clip(j.reason, 200))}\n`
  );
}

/** `oort judge withdraw <id>`: the judgment stops counting anywhere, at once. */
export async function judgeWithdrawCommand(
  id: string,
  o: { yes?: boolean; by?: string },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    personInCloud(w, 'withdraws');
    const m = await findJudgment(w, id);
    const grant = writeGrantFor(w, m);
    if (m.judgment.withdrawn !== undefined) {
      ctx.io.out(`${short(m.id)} was already withdrawn.\n`);
      if (jsonMode(ctx)) emit(ctx, { id: m.id, withdrawn: true, changed: false, by: null });
      return 0;
    }
    const ok = await confirm(
      ctx.io,
      `Withdraw ${short(m.id)}: ${judgmentLine(m.judgment)}?`,
      o.yes === true,
      'withdraw it',
      { json: jsonMode(ctx) },
    );
    if (!ok) {
      ctx.io.out('Kept.\n');
      return 0;
    }
    const by = operatorOf(w, o.by);
    await withdrawJudgment(w.store, grant, m, by);
    ctx.io.out(
      `Withdrew ${short(m.id)} (recorded as withdrawn by ${shown(by)}). Judging, recall, export and packs leave it out from now on, and no import brings the same decision back. Its record and text stay in this store (\`oort judge list --all\`); \`oort judge purge ${short(m.id)}\` removes the text.\n`,
    );
    if (jsonMode(ctx)) emit(ctx, { id: m.id, withdrawn: true, changed: true, by });
    return 0;
  });
}

/** `oort judge confirm <id>`: a person vouches for an agent-recorded judgment. CLI only. */
export async function judgeConfirmCommand(
  id: string,
  o: { yes?: boolean; by?: string },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    personInCloud(w, 'confirms');
    let m: Memory & { judgment: Judgment };
    try {
      m = await findJudgment(w, id);
    } catch (e) {
      // Not a judgment: a prediction an agent resolved, which a person confirms.
      const p =
        e instanceof Refusal && e.code === 'not-found'
          ? await findPrediction(w.store, writeGrant(w), id).catch(() => undefined)
          : undefined;
      if (p === undefined) throw e;
      return confirmResolved(ctx, w, p, o);
    }
    if (m.id !== id) {
      // A prefix: it must not also name a prediction, or the wrong one would be confirmed.
      const match = await predictionMatch(w.store, writeGrant(w), id);
      if (match === 'exact') {
        return confirmResolved(ctx, w, await findPrediction(w.store, writeGrant(w), id), o);
      }
      if (match === 'prefix') throw ambiguousKinds(id);
    }
    const grant = writeGrantFor(w, m);
    if (!isUnconfirmedAgentJudgment(m.judgment)) {
      ctx.io.out(
        isAgentVia(m.judgment.via)
          ? `${short(m.id)} is already confirmed.\n`
          : `${short(m.id)} was recorded by a person; there is nothing to confirm.\n`,
      );
      if (jsonMode(ctx)) {
        emit(ctx, { id: m.id, confirmed: isAgentVia(m.judgment.via), changed: false, by: null });
      }
      return 0;
    }
    if (m.expiredAt !== null || m.judgment.withdrawn !== undefined) {
      throw new Refusal(`${short(m.id)} is not a current judgment; it cannot be confirmed.`, {
        code: 'refused',
      });
    }
    const by = operatorOf(w, o.by);
    const label = await confirmLabel(
      ctx,
      `Confirm that ${shown(m.judgment.by)} really decided ${short(m.id)}? ${judgmentLine(m.judgment)}\n  reason: ${shown(clip(m.judgment.reason, 200))}\nIt will count when judging.`,
      o.yes,
      'confirm it',
    );
    if (label === null) {
      ctx.io.out('Not confirmed.\n');
      return 0;
    }
    await confirmJudgment(w.store, grant, m, by, new Date(), label);
    ctx.io.out(`Confirmed ${short(m.id)} (by ${shown(by)}): it counts when judging now.\n`);
    if (jsonMode(ctx)) emit(ctx, { id: m.id, confirmed: true, changed: true, by });
    return 0;
  });
}

/** `oort judge purge <id>`: blank a judgment's text, keeping an audit stub. */
export async function judgePurgeCommand(
  id: string,
  o: { yes?: boolean; by?: string },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    localOnly(w);
    const m = await findJudgment(w, id);
    const grant = writeGrantFor(w, m);
    if (m.judgment.purged !== undefined) {
      ctx.io.out(`${short(m.id)} was already purged.\n`);
      if (jsonMode(ctx)) emit(ctx, { id: m.id, purged: true, changed: false, by: null });
      return 0;
    }
    const by = operatorOf(w, o.by);
    const ok = await confirm(
      ctx.io,
      `Purge ${short(m.id)}: ${judgmentLine(m.judgment)}? Its subject, link, reason and embedding are removed for good; an audit stub stays.`,
      o.yes === true,
      'purge it',
      { json: jsonMode(ctx) },
    );
    if (!ok) {
      ctx.io.out('Kept.\n');
      return 0;
    }
    await purgeJudgment(w.store, grant, m, by);
    ctx.io.out(
      `Purged ${short(m.id)}: only the expert, domain, verdict, times and who withdrew and purged it are left. Copies made earlier (exports, packs, backups) are not touched.\n`,
    );
    if (jsonMode(ctx)) emit(ctx, { id: m.id, purged: true, changed: true, by });
    return 0;
  });
}

/** `oort judge import <file>`: past decisions in bulk, from CSV or JSON Lines. */
export async function judgeImportCommand(
  file: string,
  o: { format?: string; domain?: string; by?: string; json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const format = formatOf(file, o.format);
  const text = readInput(ctx.io, file);
  const rows = await refusing(async () =>
    parseJudgmentRows(text, format, {
      ...(o.domain !== undefined && { domain: o.domain }),
      ...(o.by !== undefined && { by: o.by }),
    }),
  );
  return withWired(ctx, async (w) => {
    localOnly(w);
    const r = await refusing(() =>
      importJudgments(rows, {
        store: w.store,
        grant: writeGrant(w),
        scope: w.scope,
        ...(w.embed !== undefined && { embed: w.embed }),
        harness: 'import',
      }),
    );
    if (r.redacted > 0) warn(ctx, 'redacted', `redacted secrets from ${r.redacted} judgment(s).`);
    if (r.embedFailed > 0) {
      warn(
        ctx,
        'embed-failed',
        `the embedder failed on ${r.embedFailed} judgment(s); they are matched by their words only.`,
      );
    }
    const { redacted: _r, embedFailed: _e, ...counts } = r;
    if (jsonMode(ctx)) {
      emit(ctx, { rows: rows.length, ...counts });
    } else {
      ctx.io.out(
        `Imported ${rows.length} judgment(s): ${r.added} added, ${r.corrected} corrected, ${r.unchanged} already recorded${r.tombstoned > 0 ? `, ${r.tombstoned} withdrawn or corrected here before (not brought back)` : ''}.\n`,
      );
    }
    return 0;
  });
}

/** `oort judge eval <file>`: agreement with the expert on held-out decisions, per domain. */
export async function judgeEvalCommand(
  file: string | undefined,
  o: {
    live?: boolean;
    includeAgentResolved?: boolean;
    format?: string;
    domain?: string;
    by?: string;
    thresholds?: string;
    k?: string;
    minSimilarity?: string;
    includeImported?: boolean;
    includeAgentRecorded?: boolean;
    json?: boolean;
  },
  ctx: Ctx,
): Promise<number> {
  if (o.live === true) {
    if (file !== undefined) {
      throw new Refusal('--live reads resolved predictions, not a file: give one or the other.');
    }
    return judgeEvalLiveCommand(o, ctx);
  }
  if (file === undefined) {
    throw new Refusal('Give a file of held-out decisions, or --live for resolved predictions.');
  }
  const format = formatOf(file, o.format);
  const text = readInput(ctx.io, file);
  const rows = await refusing(async () =>
    parseJudgmentRows(text, format, {
      ...(o.domain !== undefined && { domain: o.domain }),
      ...(o.by !== undefined && { by: o.by }),
    }),
  );
  const thresholds =
    o.thresholds === undefined
      ? EVAL_THRESHOLDS
      : (list(o.thresholds) ?? []).map((t) => number('--thresholds', t, 0, 1)!);
  if (thresholds.length === 0) throw new Refusal('--thresholds needs at least one number.');
  const { threshold: _t, ...opts } = judgeOptions(o);
  return withWired(ctx, async (w) => {
    localOnly(w);
    if (w.decide?.judge === undefined) {
      throw new Refusal(
        `Evaluating needs predictions, and ${WHY['no-decider'].replace(', so no prediction', '')}.`,
        { code: 'needs-key', fix: 'oort keys set typesafe' },
      );
    }
    const report = await refusing(() =>
      evaluateJudgments(
        rows,
        {
          store: w.store,
          grant: writeGrant(w),
          ...(w.embed !== undefined && { embed: w.embed }),
          decide: w.decide!,
        },
        { ...opts, thresholds },
      ),
    );
    if (jsonMode(ctx)) {
      emit(ctx, report);
      return 0;
    }
    const ui = uiFor(ctx.io);
    ctx.io.out(
      ui.header(
        'judge eval',
        `${rows.length} held-out decisions`,
        `${report.similarity} similarity`,
      ),
    );
    for (const [domain, d] of Object.entries(report.domains)) {
      ctx.io.out(`\n${ui.bold(shown(domain))}: ${d.items} item(s)\n`);
      ctx.io.out(
        ui.table(
          ['threshold', 'coverage', 'agreement', 'predicted'],
          d.points.map((p) => [
            fixed(p.threshold),
            fixed(p.coverage),
            p.agreement === null ? '-' : fixed(p.agreement),
            `${p.agreed}/${p.predicted}`,
          ]),
        ),
      );
      const why = Object.entries(d.why)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ');
      if (why !== '') ctx.io.out(`not predicted: ${why}\n`);
    }
    return 0;
  });
}

/** `oort judge pack export`: the current judgments (optionally one domain or expert) as a pack. */
export async function judgePackExportCommand(
  o: {
    out?: string;
    force?: boolean;
    name?: string;
    domain?: string;
    by?: string;
    includeImported?: boolean;
    json?: boolean;
  },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    localOnly(w);
    const now = new Date();
    const items = await refusing(() => activeJudgments(w.store, writeGrant(w), o, now, false));
    const name = o.name ?? [o.domain, o.by].filter((x) => x !== undefined).join('-');
    const data = formatJudgmentPack(items, {
      name: name === '' ? 'judgments' : name,
      exportedBy: w.agent.id,
      exportedAt: now,
    });
    if (o.out === undefined) {
      // The pack is its own versioned format: it is the output, with or without --json.
      rawOut(ctx, data);
      return 0;
    }
    const file = path.resolve(ctx.io.cwd, o.out);
    writeOwnerOnly(file, data, o.force === true);
    ctx.io.out(`Exported ${items.length} judgment(s) to ${shown(file)}\n`);
    if (jsonMode(ctx)) emit(ctx, { file, judgments: items.length });
    return 0;
  });
}

/** `oort judge pack import <file>`: a pack's judgments, with where they came from. */
export async function judgePackImportCommand(
  file: string,
  o: { yes?: boolean; json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const text = readInput(ctx.io, file);
  const pack = await refusing(async () => parseJudgmentPack(text));
  return withWired(ctx, async (w) => {
    localOnly(w);
    const m = pack.manifest;
    const ok = await confirm(
      ctx.io,
      `Import pack ${shown(clip(m.name, 40))}: ${m.count} judgment(s) naming ${m.experts.map((e) => shown(e)).join(', ')} as expert (${m.domains.map((d) => shown(d)).join(', ')}), exported by ${shown(m.exportedBy)} on ${m.exportedAt.slice(0, 10)}. The pack states who decided; nothing verifies it, so its judgments count only with --include-imported. Each is pinned and shown at every session start. Import?`,
      o.yes === true,
      'import it',
      { json: jsonMode(ctx) },
    );
    // With --json, confirm refuses rather than asks, so a decline is always human output.
    if (!ok) {
      ctx.io.out('Not imported.\n');
      return 0;
    }
    const r = await refusing(() =>
      importJudgmentPack(pack, {
        store: w.store,
        grant: writeGrant(w),
        scope: w.scope,
        ...(w.embed !== undefined && { embed: w.embed }),
        harness: 'pack',
      }),
    );
    if (jsonMode(ctx)) {
      emit(ctx, { pack: m.digest.slice(0, 16), name: m.name, ...r });
    } else {
      ctx.io.out(
        `Imported ${r.added.length} judgment(s) from pack ${shown(clip(m.name, 40))} (${m.digest.slice(0, 16)}); ${r.skipped.length} already here${r.tombstoned.length > 0 ? `, ${r.tombstoned.length} withdrawn or corrected here before (not brought back)` : ''}.\n`,
      );
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------------------------
// Predictions: what `judge apply` proposed, and what the expert then decided
// ---------------------------------------------------------------------------------------------

/** A prediction for human eyes: the item, and the predicted verdict or why there is none. */
function predictionLine(p: Prediction): string {
  const proposed =
    p.verdict === null
      ? `no prediction (${shown(p.why ?? p.outcome)})`
      : `predicted ${shown(p.verdict)} at ${fixed(p.probability ?? 0)}`;
  return `"${shown(clip(p.item.summary, 70))}"${p.domain === undefined ? '' : ` (${shown(p.domain)})`}: ${proposed}`;
}

function resolutionLine(p: Prediction): string {
  const r = p.resolution;
  if (r === undefined) return '';
  const agrees = r.agrees === null ? '' : r.agrees ? ', agrees' : ', differs';
  const agent = !isAgentVia(r.via)
    ? ''
    : r.confirmed === undefined
      ? ' [agent-recorded, unconfirmed]'
      : ` [agent-recorded, confirmed by ${shown(r.confirmed.by)}]`;
  return `${shown(r.verdict)} by ${shown(r.by)}, ${r.at.slice(0, 10)}${agrees}${agent}${originTag(r)}`;
}

/** The prediction as `--json` prints it: the record without its address. */
function plainPrediction(p: Prediction, now: Date) {
  const { scope: _s, address: _a, author: _au, revision: _r, resolution, ...rest } = p;
  return {
    ...rest,
    ...(resolution !== undefined && { resolution: { ...resolution, ...originFields(resolution) } }),
    state: predictionState(p, now),
  };
}

export interface JudgeResolveOptions {
  verdict?: string;
  reason?: string;
  criteria?: string;
  by?: string;
  domain?: string;
  json?: boolean;
  yes?: boolean;
}

/**
 * `oort judge resolve <id>`: the expert's decision on a kept prediction. A different verdict
 * with a reason is recorded as a judgment, the reason verbatim.
 */
export async function judgeResolveCommand(
  id: string,
  o: JudgeResolveOptions,
  ctx: Ctx,
): Promise<number> {
  if (o.verdict === undefined) throw new Refusal('--verdict is required.');
  const criteria = list(o.criteria);
  return withWired(ctx, async (w) => {
    localOnly(w);
    const by = o.by ?? w.config.judge.operator;
    if (by === undefined) {
      throw new Refusal('--by is required: the id of the expert who decided.');
    }
    const grant = writeGrant(w);
    const found = await refusing(() => findPrediction(w.store, grant, id));
    const label = await askLabel(
      ctx,
      `Resolve prediction ${short(found.id)} ("${shown(clip(found.item.summary, 120))}") as ${shown(o.verdict!)}, by ${shown(by)}?`,
      o.yes,
    );
    if (label === null) {
      ctx.io.out('Nothing recorded.\n');
      return 0;
    }
    const r = await refusing(async () => {
      return resolvePrediction(
        found.id,
        {
          verdict: o.verdict!,
          by,
          ...(o.reason !== undefined && { reason: o.reason }),
          ...(criteria !== undefined && { criteria }),
          ...(o.domain !== undefined && { domain: o.domain }),
        },
        {
          store: w.store,
          grant,
          scope: w.scope,
          ...(w.embed !== undefined && { embed: w.embed }),
          via: 'cli',
          harness: 'cli',
          label,
        },
      );
    });
    if (r.judgment !== undefined && r.judgment.redacted.length > 0) {
      warn(ctx, 'redacted', `redacted a secret (${r.judgment.redacted.join(', ')}) before saving.`);
    }
    const now = new Date();
    if (jsonMode(ctx)) {
      emit(ctx, {
        prediction: plainPrediction(r.prediction, now),
        agrees: r.agrees,
        ...(r.judgment !== undefined && {
          judgment: { outcome: r.judgment.outcome, id: r.judgment.memory.id },
        }),
        ...(r.agentJudgmentKept !== undefined && {
          agentJudgmentKept: r.agentJudgmentKept,
          agentJudgmentKeptReason: r.agentJudgmentKeptReason,
        }),
      });
      return 0;
    }
    const p = r.prediction;
    const verdict = shown(p.resolution!.verdict);
    const head =
      r.agrees === null
        ? `Resolved ${short(p.id)} as ${verdict}; judging had made no prediction.`
        : r.agrees
          ? `Resolved ${short(p.id)} as ${verdict}: agrees with the prediction.`
          : `Resolved ${short(p.id)} as ${verdict}: the prediction was ${shown(p.verdict ?? '')}.`;
    ctx.io.out(`${head}\n`);
    if (r.judgment !== undefined) {
      ctx.io.out(
        `The reason is recorded as judgment ${short(r.judgment.memory.id)}, word for word, so judging cites it from now on.\n`,
      );
    } else if (r.agrees !== true && o.reason === undefined) {
      ctx.io.out(
        'Give --reason next time to teach judging why; without one nothing new is recorded.\n',
      );
    }
    if (r.agentJudgmentKept !== undefined) {
      ctx.io.out(
        r.agentJudgmentKeptReason === 'confirmed'
          ? `This replaces what an agent recorded. Its judgment ${short(r.agentJudgmentKept)} was confirmed by a person, so it stays.\n`
          : `This replaces what an agent recorded. Its judgment ${short(r.agentJudgmentKept)} is outside this scope, so it stays as it is: unconfirmed, and judging leaves it out.\n`,
      );
    }
    return 0;
  });
}

/** `oort judge predictions`: kept predictions, pending ones unless asked otherwise. */
export async function judgePredictionsCommand(
  o: { resolved?: boolean; all?: boolean; domain?: string; limit?: string; json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const limit = number('--limit', o.limit, 1, 1000);
  return withWired(ctx, async (w) => {
    localOnly(w);
    const now = new Date();
    const status = o.all === true ? undefined : o.resolved === true ? 'resolved' : 'pending';
    const ps = await refusing(() =>
      listPredictions(
        w.store,
        writeGrant(w),
        {
          ...(status !== undefined && { status }),
          ...(o.domain !== undefined && { domain: o.domain }),
          ...(limit !== undefined && { limit: Math.round(limit) }),
        },
        now,
      ),
    );
    if (jsonMode(ctx)) {
      emit(ctx, { predictions: ps.map((p) => plainPrediction(p, now)) });
      return 0;
    }
    const ui = uiFor(ctx.io);
    ctx.io.out(ui.header('predictions', `${ps.length} ${status ?? 'kept'}`, agentLabel(w)));
    if (ps.length === 0) {
      ctx.io.err(
        status === 'pending'
          ? 'oort: no predictions wait for a decision; `oort judge apply` keeps one each time.\n'
          : 'oort: no predictions yet.\n',
      );
      return 0;
    }
    for (const p of ps) {
      const state = predictionState(p, now);
      const tag = p.purged !== undefined ? ' [purged]' : state === 'expired' ? ' [expired]' : '';
      ctx.io.out(`${short(p.id)}  ${predictionLine(p)}${tag}\n`);
      if (p.resolution !== undefined) ctx.io.out(`          decided: ${resolutionLine(p)}\n`);
    }
    return 0;
  });
}

/** `oort judge forget-prediction <id>`: delete a kept prediction and its text. */
export async function judgeForgetPredictionCommand(
  id: string,
  o: { yes?: boolean },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    localOnly(w);
    const grant = writeGrant(w);
    const p = await refusing(() => findPrediction(w.store, grant, id));
    const ok = await confirm(
      ctx.io,
      `Forget prediction ${short(p.id)}: ${predictionLine(p)}?`,
      o.yes === true,
      'forget it',
      { json: jsonMode(ctx) },
    );
    if (!ok) {
      ctx.io.out('Kept.\n');
      return 0;
    }
    const done = await refusing(() => forgetPrediction(w.store, grant, p.id));
    if (!done) throw new Refusal('This agent cannot change that prediction.', { code: 'refused' });
    ctx.io.out(`Forgot prediction ${short(p.id)}.\n`);
    if (jsonMode(ctx)) emit(ctx, { id: p.id, forgotten: true });
    return 0;
  });
}

/** `oort judge confirm <prediction id>`: a person vouches for an agent-recorded resolve. */
async function confirmResolved(
  ctx: Ctx,
  w: Wired,
  p: Prediction,
  o: { yes?: boolean; by?: string },
): Promise<number> {
  const r = p.resolution;
  if (r === undefined || !isAgentVia(r.via) || r.confirmed !== undefined) {
    ctx.io.out(
      r === undefined
        ? `${short(p.id)} is not resolved yet; there is nothing to confirm.\n`
        : !isAgentVia(r.via)
          ? `${short(p.id)} was resolved by a person; there is nothing to confirm.\n`
          : `${short(p.id)} is already confirmed.\n`,
    );
    if (jsonMode(ctx))
      emit(ctx, { id: p.id, confirmed: r?.confirmed !== undefined, changed: false, by: null });
    return 0;
  }
  const by = operatorOf(w, o.by);
  const label = await confirmLabel(
    ctx,
    `Confirm that ${shown(r.by)} really decided prediction ${short(p.id)}? ${predictionLine(p)}\n  decided: ${resolutionLine(p)}${r.reason === undefined ? '' : `\n  reason: ${shown(clip(r.reason, 200))}`}\nIt will count in \`oort judge eval --live\`${r.judgmentId === undefined ? '' : ', and its judgment when judging'}.`,
    o.yes,
    'confirm it',
  );
  if (label === null) {
    ctx.io.out('Not confirmed.\n');
    return 0;
  }
  await refusing(() => confirmResolution(w.store, writeGrant(w), p.id, by, new Date(), label));
  ctx.io.out(`Confirmed the decision on ${short(p.id)} (by ${shown(by)}).\n`);
  if (jsonMode(ctx)) emit(ctx, { id: p.id, confirmed: true, changed: true, by });
  return 0;
}

const band = (b: LiveEvalReport['bands'][number]): string =>
  `${fixed(b.from, 1)}-${fixed(b.to, 1)}`;

/** `oort judge eval --live`: agreement and calibration from resolved predictions. */
async function judgeEvalLiveCommand(
  o: { domain?: string; includeAgentResolved?: boolean; json?: boolean },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    localOnly(w);
    const r = await refusing(() =>
      evaluateLive(w.store, writeGrant(w), {
        ...(o.domain !== undefined && { domain: o.domain }),
        ...(o.includeAgentResolved === true && { includeAgentResolved: true }),
      }),
    );
    if (jsonMode(ctx)) {
      emit(ctx, r);
      return 0;
    }
    const ui = uiFor(ctx.io);
    const pct = (x: number | null) => (x === null ? '-' : fixed(x, 3));
    ctx.io.out(ui.header('judge eval --live', `${r.resolved} resolved`, `${r.pending} pending`));
    if (r.resolved === 0) {
      ctx.io.err(
        'oort: no resolved predictions yet; record decisions with `oort judge resolve <id>`.\n',
      );
    }
    ctx.io.out(
      `Agreement: ${pct(r.overall.agreement)} (${r.overall.agreed}/${r.overall.predicted} predictions the expert agreed with).\n`,
    );
    ctx.io.out(
      `Suggested: ${pct(r.suggested.agreement)} (${r.suggested.agreed}/${r.suggested.predicted}); coverage ${pct(r.coverage)}.\n`,
    );
    ctx.io.out(`\n${ui.bold('Calibration')} (agreement per confidence band):\n`);
    ctx.io.out(
      ui.table(
        ['band', 'predicted', 'agreed', 'agreement', 'mean probability'],
        r.bands.map((b) => [
          band(b),
          String(b.predicted),
          String(b.agreed),
          pct(b.agreement),
          pct(b.meanProbability),
        ]),
      ),
    );
    if (r.criteria.length > 0) {
      ctx.io.out(`\n${ui.bold('Most overruled criteria')}:\n`);
      for (const c of r.criteria) {
        ctx.io.out(
          `${shown(c.criterion)}: ${c.disagreed} of ${c.predicted} overruled (${fixed(c.disagreement)})\n`,
        );
      }
    }
    if (r.agentResolvedExcluded > 0) {
      ctx.io.out(
        `\n${r.agentResolvedExcluded} agent-recorded decision(s) nobody confirmed were left out: confirm one with \`oort judge confirm <prediction id>\`, or add --include-agent-resolved.\n`,
      );
    }
    return 0;
  });
}
