import {
  activeJudgments,
  confirmJudgment,
  confirmResolution,
  evaluateLive,
  findPrediction,
  getPrediction as getExactPrediction,
  predictionMatch,
  PredictionError,
  resolveRecordsJudgment,
  forgetPrediction as coreForgetPrediction,
  isActiveJudgment,
  isUnconfirmedAgentJudgment,
  judge as coreJudge,
  listPredictions as coreListPredictions,
  recordJudgment,
  resolvePrediction,
  type Judgment,
  type Memory,
  type RecordJudgmentResult,
} from '@oortmem/core';
import { AgentJudgmentCapError, refundAgentJudgment, reserveAgentJudgment } from '../judge-cap.js';
import { storeOf, type Ctx } from './context.js';
import { localOnly } from './cloud.js';
import { findLocal } from './local.js';
import { OortAmbiguousIdError, OortNotFoundError, OortRefusedError } from './errors.js';
import type {
  JudgeItem,
  JudgeOptions,
  JudgeResult,
  JudgmentInput,
  JudgmentView,
  LiveEvalView,
  PredictionView,
  RecordJudgmentView,
  ResolveInput,
  ResolveView,
} from './types.js';
import { iso } from './validate.js';
import { judgeView, judgmentView, liveEvalView, predictionView } from './views.js';

/**
 * Judgment memory from code (CON-108 §6.3). An SDK caller is an agent by default: it records only
 * for experts the person listed in `judge.experts`, at most 50 a day per Oort home (MCP's cap and
 * counter), and what it records is stored exactly as MCP's (`via: 'mcp'`, `source.harness:
 * 'sdk'`), so every reader, 0.5.x included, treats it as unconfirmed. Expert role is explicit and
 * records `via: 'sdk'`.
 */

function localJudgments(ctx: Ctx): void {
  if (ctx.engine.mode === 'cloud') throw localOnly('Judgment memory');
}

/** Refuses an agent acting in the name of an expert the person did not list in `judge.experts`. */
function agentMayActFor(ctx: Ctx, by: string): void {
  const experts = ctx.engine.config.judge.experts;
  if (experts.length === 0) {
    throw new OortRefusedError(
      'An agent records judgments only for experts listed in judge.experts (the home config, or the config option), and none are listed.',
      { reason: 'experts-not-listed' },
    );
  }
  if (!experts.includes(by.trim())) {
    throw new OortRefusedError(
      'by is not one of the experts listed in judge.experts, so an agent cannot record judgments in their name.',
      { reason: 'not-an-expert' },
    );
  }
}

/** Takes one slot of the machine's daily cap of agent-recorded judgments. */
async function reserveSlot(ctx: Ctx, day: string): Promise<void> {
  try {
    await reserveAgentJudgment(ctx.engine.config.home, day);
  } catch (e) {
    if (e instanceof AgentJudgmentCapError && e.kind === 'daily-limit') {
      throw new OortRefusedError(
        'Agents on this machine already recorded 50 judgments today (MCP and SDK together); a person records more with `oort judge record`.',
        { reason: 'daily-limit' },
      );
    }
    throw new OortRefusedError(
      "Could not keep this machine's daily count of agent-recorded judgments, so nothing was saved; try again.",
      { reason: 'cap-unavailable', retryable: true },
    );
  }
}

function recordView(r: RecordJudgmentResult, agent: boolean): RecordJudgmentView {
  return {
    outcome: r.outcome,
    id: r.memory.id,
    ...(r.supersedes !== undefined && { corrects: r.supersedes }),
    status: agent ? 'agent-recorded' : 'recorded',
    redacted: [...r.redacted],
    ...(r.embedFailed === true && { embedFailed: true as const }),
  };
}

export async function record(ctx: Ctx, input: JudgmentInput): Promise<RecordJudgmentView> {
  localJudgments(ctx);
  const store = storeOf(ctx);
  const now = ctx.now();
  const agent = ctx.judge.role === 'agent';
  if (agent) agentMayActFor(ctx, input.by);
  const day = now.toISOString().slice(0, 10);
  if (agent) await reserveSlot(ctx, day);
  let wrote = false;
  try {
    const r = await recordJudgment(
      {
        subject: input.subject,
        verdict: input.verdict,
        reason: input.reason,
        domain: input.domain,
        by: input.by,
        ...(input.ref !== undefined && { ref: input.ref }),
        ...(input.verdicts !== undefined && { verdicts: input.verdicts }),
        ...(input.criteria !== undefined && { criteria: input.criteria }),
        ...(input.decidedAt !== undefined && { decidedAt: iso(input.decidedAt) }),
      },
      {
        store,
        grant: ctx.principal.grant,
        scope: ctx.principal.scope,
        ...(ctx.engine.embed !== undefined && { embed: ctx.engine.embed }),
        // An agent's record is MCP's in every way that counts: unconfirmed for every reader.
        via: agent ? 'mcp' : 'sdk',
        harness: 'sdk',
        now,
      },
    );
    wrote = r.outcome !== 'unchanged';
    return recordView(r, agent);
  } finally {
    if (agent && !wrote) await refundAgentJudgment(ctx.engine.config.home, day);
  }
}

export async function apply(
  ctx: Ctx,
  item: string | JudgeItem,
  o: JudgeOptions,
): Promise<JudgeResult> {
  localJudgments(ctx);
  const i: JudgeItem = typeof item === 'string' ? { summary: item } : item;
  const e = ctx.engine;
  const r = await coreJudge(
    {
      summary: i.summary,
      ...(i.details !== undefined && { details: i.details }),
      ...(i.ref !== undefined && { ref: i.ref }),
      ...(i.domain !== undefined && { domain: i.domain }),
      ...(i.by !== undefined && { by: i.by }),
    },
    {
      store: storeOf(ctx),
      grant: ctx.principal.grant,
      ...(e.embed !== undefined && { embed: e.embed }),
      ...(e.decide !== undefined && { decide: e.decide }),
      now: ctx.now(),
      // Kept as a prediction, so a person can resolve it.
      keep: { scope: ctx.principal.scope },
    },
    {
      ...(o.limit !== undefined && { k: o.limit }),
      ...(o.threshold !== undefined && { threshold: o.threshold }),
      ...(o.minSimilarity !== undefined && { minSimilarity: o.minSimilarity }),
      ...(o.minAgreement !== undefined && { minAgreement: o.minAgreement }),
      ...(o.includeImported === true && { includeImported: true }),
      ...(o.includeAgentRecorded === true && { includeAgentRecorded: true }),
    },
  );
  return judgeView(r);
}

export async function list(
  ctx: Ctx,
  o: { domain?: string; by?: string; all?: boolean; limit?: number },
): Promise<{ judgments: (JudgmentView & { id: string })[] }> {
  localJudgments(ctx);
  const store = storeOf(ctx);
  const grant = ctx.principal.grant;
  const now = ctx.now();
  const items =
    o.all === true
      ? (await store.list(grant, { validOnly: false, embeddings: false })).filter(
          (m): m is Memory & { judgment: Judgment } =>
            m.type === 'judgment' &&
            m.judgment !== undefined &&
            (o.domain === undefined || m.judgment.domain === o.domain.toLowerCase()) &&
            (o.by === undefined || m.judgment.by === o.by),
        )
      : await activeJudgments(
          store,
          grant,
          {
            ...(o.domain !== undefined && { domain: o.domain }),
            ...(o.by !== undefined && { by: o.by }),
            includeImported: true,
            includeAgentRecorded: true,
          },
          now,
          false,
        );
  return {
    judgments: items.slice(0, o.limit ?? 100).map((m) => judgmentView(m.judgment, m, now)),
  };
}

export async function confirm(ctx: Ctx, id: string): Promise<{ id: string; changed: boolean }> {
  localJudgments(ctx);
  if (ctx.judge.role !== 'expert') {
    throw new OortRefusedError(
      'Only a person confirms an agent-recorded judgment: create the handle with judge: { role: "expert" } in a code path where a person decided.',
      { reason: 'expert-only' },
    );
  }
  const store = storeOf(ctx);
  const grant = ctx.principal.grant;
  const confirmPrediction = async (pid: string) => ({
    id: pid,
    changed: await confirmResolution(store, grant, pid, ctx.judge.operator, ctx.now()),
  });
  let m: Memory | undefined;
  try {
    m = await findLocal(ctx, id);
  } catch (e) {
    if (!(e instanceof OortNotFoundError)) throw e;
  }
  // Only a judgment counts as the memory an id names here: anything else, try a prediction.
  if (m !== undefined && (m.type !== 'judgment' || m.judgment === undefined)) m = undefined;
  if (m === undefined) {
    const p = await findPrediction(store, grant, id).catch((e: unknown) => {
      if (e instanceof PredictionError && e.kind === 'not-found') {
        throw new OortNotFoundError('No judgment or prediction with that id in this scope.');
      }
      throw e;
    });
    return confirmPrediction(p.id);
  }
  if (m.id !== id) {
    // A prefix: it must not also name a prediction, or the wrong one would be confirmed.
    const match = await predictionMatch(store, grant, id);
    if (match === 'exact') return confirmPrediction(id);
    if (match === 'prefix') {
      throw new OortAmbiguousIdError(
        'That id prefix matches both a judgment and a prediction; give more of the id.',
      );
    }
  }
  const now = ctx.now();
  if (!isUnconfirmedAgentJudgment(m.judgment!)) return { id: m.id, changed: false };
  if (!isActiveJudgment(m, now)) {
    throw new OortRefusedError('That judgment is not current, so it cannot be confirmed.', {
      reason: 'not-current',
    });
  }
  const ok = await confirmJudgment(storeOf(ctx), ctx.principal.grant, m, ctx.judge.operator, now);
  return { id: m.id, changed: ok };
}

/**
 * A person's decision on a prediction. In agent role the resolve is stored as MCP's is
 * (`via: 'mcp'`, unconfirmed), `by` must be a listed expert, and a reason that becomes a judgment
 * takes a slot of the daily cap.
 */
export async function resolve(ctx: Ctx, ref: string, input: ResolveInput): Promise<ResolveView> {
  localJudgments(ctx);
  const store = storeOf(ctx);
  const grant = ctx.principal.grant;
  const now = ctx.now();
  const agent = ctx.judge.role === 'agent';
  // An agent names a prediction by its whole id; a prefix is for people.
  const p = agent
    ? await getExactPrediction(store, grant, ref)
    : await findPrediction(store, grant, ref);
  if (agent) agentMayActFor(ctx, input.by);
  const day = now.toISOString().slice(0, 10);
  // A slot only for a resolve that will record a judgment.
  const mayRecord = agent && resolveRecordsJudgment(p, input);
  if (mayRecord) await reserveSlot(ctx, day);
  let wrote = false;
  try {
    const r = await resolvePrediction(
      p.id,
      {
        verdict: input.verdict,
        by: input.by,
        ...(input.reason !== undefined && { reason: input.reason }),
        ...(input.criteria !== undefined && { criteria: input.criteria }),
        ...(input.domain !== undefined && { domain: input.domain }),
      },
      {
        store,
        grant,
        scope: ctx.principal.scope,
        ...(ctx.engine.embed !== undefined && { embed: ctx.engine.embed }),
        via: agent ? 'mcp' : 'sdk',
        harness: 'sdk',
        now,
      },
    );
    wrote = r.judgment !== undefined && r.judgment.outcome !== 'unchanged';
    return {
      prediction: predictionView(r.prediction, now),
      agrees: r.agrees,
      ...(r.judgment !== undefined && { judgment: recordView(r.judgment, agent) }),
      ...(r.agentJudgmentKept !== undefined && {
        agentJudgmentKept: r.agentJudgmentKept,
        agentJudgmentKeptReason: r.agentJudgmentKeptReason!,
      }),
    };
  } finally {
    if (mayRecord && !wrote) await refundAgentJudgment(ctx.engine.config.home, day);
  }
}

export async function listPredictions(
  ctx: Ctx,
  o: { status?: 'pending' | 'resolved'; limit?: number; domain?: string },
): Promise<{ predictions: PredictionView[] }> {
  localJudgments(ctx);
  const now = ctx.now();
  const ps = await coreListPredictions(
    storeOf(ctx),
    ctx.principal.grant,
    {
      status: o.status ?? 'pending',
      ...(o.limit !== undefined && { limit: o.limit }),
      ...(o.domain !== undefined && { domain: o.domain }),
    },
    now,
  );
  return { predictions: ps.map((p) => predictionView(p, now)) };
}

export async function getPrediction(ctx: Ctx, ref: string): Promise<PredictionView> {
  localJudgments(ctx);
  return predictionView(await findPrediction(storeOf(ctx), ctx.principal.grant, ref), ctx.now());
}

export async function forgetPrediction(
  ctx: Ctx,
  ref: string,
): Promise<{ id: string; forgotten: true }> {
  localJudgments(ctx);
  const store = storeOf(ctx);
  const p = await findPrediction(store, ctx.principal.grant, ref);
  if (ctx.judge.role === 'agent' && p.resolution !== undefined) {
    throw new OortRefusedError(
      'Only a person forgets a resolved prediction: it is the record of what the expert decided.',
      { reason: 'expert-only' },
    );
  }
  if (!(await coreForgetPrediction(store, ctx.principal.grant, p.id))) {
    throw new OortRefusedError('This handle cannot change that prediction.', {
      reason: 'scope-denied',
    });
  }
  return { id: p.id, forgotten: true };
}

export async function evalLive(
  ctx: Ctx,
  o: { domain?: string; includeAgentResolved?: boolean },
): Promise<LiveEvalView> {
  localJudgments(ctx);
  return liveEvalView(
    await evaluateLive(storeOf(ctx), ctx.principal.grant, {
      now: ctx.now(),
      ...(o.domain !== undefined && { domain: o.domain }),
      ...(o.includeAgentResolved === true && { includeAgentResolved: true }),
    }),
  );
}
