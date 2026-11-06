import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DISPLAY_UNSAFE_SOURCE,
  EVAL_THRESHOLDS,
  JudgmentInputError,
  JudgmentPackError,
  activeJudgments,
  confirmJudgment,
  evaluateJudgments,
  formatJudgmentPack,
  importJudgmentPack,
  importJudgments,
  isActiveJudgment,
  isAgentVia,
  isUnconfirmedAgentJudgment,
  judge,
  parseJudgmentPack,
  parseJudgmentRows,
  purgeJudgment,
  recordJudgment,
  withdrawJudgment,
  type JudgeOptions,
  type JudgeResult,
  type Judgment,
  type JudgmentInput,
  type Memory,
  type RecordJudgmentResult,
} from '@oortmem/core';
import { emit, jsonMode, rawOut } from '../output.js';
import { uiFor } from '../ui.js';
import {
  Refusal,
  agentLabel,
  clip,
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
 * expert" when the precedents disagree or are too far. Local store only for now.
 */

/** Largest file `judge import`, `judge eval` and `judge pack import` read. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Refuses in cloud mode: Oort Cloud has no judgment memory yet. */
function localOnly(w: Wired): void {
  if (w.mode === 'cloud') {
    throw new Refusal(
      'Judgment memory is local-only for now: Oort Cloud does not hold judgments yet. Run `oort cloud use --local` to use it.',
      { code: 'refused' },
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
function judgmentLine(j: Judgment): string {
  return `${shown(j.verdict)} "${shown(clip(j.subject.summary, 70))}" (${shown(j.domain)}, by ${shown(j.by)}, ${j.decidedAt.slice(0, 10)})`;
}

/** Characters an operator id may not hold: controls, bidi and invisible format characters. */
const OPERATOR_UNSAFE = new RegExp(DISPLAY_UNSAFE_SOURCE);

/**
 * Who withdraws, confirms or purges from this machine: `--by`, else `judge.operator` in the home
 * config, else `local-user`. Never the expert who made the judgment.
 */
function operatorOf(w: Wired, flag: string | undefined): string {
  const by = flag ?? w.config.judge.operator ?? 'local-user';
  if (by.trim() === '' || by.length > 128 || OPERATOR_UNSAFE.test(by)) {
    throw new Refusal('--by must be one line of text, at most 128 characters.');
  }
  return by.trim();
}

/** How a precedent or judgment was recorded, for labels. */
function recordedLabel(j: Pick<Judgment, 'via' | 'confirmed'>): string {
  if (!isAgentVia(j.via)) return '';
  return j.confirmed === undefined
    ? ' [agent-recorded, unconfirmed]'
    : ` [agent-recorded, confirmed by ${shown(j.confirmed.by)}]`;
}

function plainJudgment(m: Memory & { judgment: Judgment }) {
  return { id: m.id, ...m.judgment, current: m.expiredAt === null };
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
    localOnly(w);
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
    const r = await refusing(() =>
      recordJudgment(input, {
        store: w.store,
        grant,
        scope: w.scope,
        ...(w.embed !== undefined && { embed: w.embed }),
        via: 'cli',
        harness: 'cli',
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
    localOnly(w);
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
        },
        opts,
      ),
    );
    if (jsonMode(ctx)) {
      emit(ctx, r);
      return 0;
    }
    printJudgeResult(ctx, w, r);
    return 0;
  });
}

function printJudgeResult(ctx: Ctx, w: Wired, r: JudgeResult): void {
  const ui = uiFor(ctx.io);
  const n = r.precedents.filter((p) => p.near).length;
  const experts = [...new Set(r.precedents.map((p) => p.by))].map((b) => shown(b)).join(', ');
  ctx.io.out(ui.header('judge', r.status, agentLabel(w)));
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
      `${r.agentRecordedExcluded} agent-recorded judgment(s) nobody confirmed were not used: confirm one with \`oort judge confirm <id>\`, or add --include-agent-recorded.\n`,
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
      `${i + 1}. ${shown(p.verdict)}  ${fixed(p.similarity)}${mark}  "${shown(clip(p.subject.summary, 70))}"  by ${shown(p.by)}, ${p.decidedAt.slice(0, 10)}${from}${agent}  ${short(p.id)}\n`,
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
    localOnly(w);
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
          : ` [imported from pack ${shown(m.judgment.pack.name)}]`);
      ctx.io.out(`${short(m.id)}  ${judgmentLine(m.judgment)}${state}\n`);
      ctx.io.out(`          reason: ${shown(clip(m.judgment.reason, 200))}\n`);
    }
    return 0;
  });
}

/** `oort judge withdraw <id>`: the judgment stops counting anywhere, at once. */
export async function judgeWithdrawCommand(
  id: string,
  o: { yes?: boolean; by?: string },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    localOnly(w);
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
    localOnly(w);
    const m = await findJudgment(w, id);
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
    const ok = await confirm(
      ctx.io,
      `Confirm that ${shown(m.judgment.by)} really decided this? ${judgmentLine(m.judgment)}\n  reason: ${shown(clip(m.judgment.reason, 200))}\nIt will count when judging.`,
      o.yes === true,
      'confirm it',
      { json: jsonMode(ctx) },
    );
    if (!ok) {
      ctx.io.out('Not confirmed.\n');
      return 0;
    }
    await confirmJudgment(w.store, grant, m, by);
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
  file: string,
  o: {
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
      `Import pack ${shown(clip(m.name, 40))}: ${m.count} judgment(s) naming ${m.experts.map((e) => shown(e)).join(', ')} as expert (${m.domains.map((d) => shown(d)).join(', ')}), exported by ${shown(m.exportedBy)} on ${m.exportedAt.slice(0, 10)}. The pack states who decided; nothing verifies it, so its judgments count only with --include-imported. Import?`,
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
