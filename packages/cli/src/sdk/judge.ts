import {
  activeJudgments,
  confirmJudgment,
  isActiveJudgment,
  isUnconfirmedAgentJudgment,
  judge as coreJudge,
  recordJudgment,
  type Judgment,
  type Memory,
} from '@oortmem/core';
import { AgentJudgmentCapError, refundAgentJudgment, reserveAgentJudgment } from '../judge-cap.js';
import { storeOf, type Ctx } from './context.js';
import { localOnly } from './cloud.js';
import { findLocal } from './local.js';
import { OortNotFoundError, OortRefusedError } from './errors.js';
import type {
  JudgeItem,
  JudgeOptions,
  JudgeResult,
  JudgmentInput,
  JudgmentView,
  RecordJudgmentView,
} from './types.js';
import { iso } from './validate.js';
import { judgeView, judgmentView } from './views.js';

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

export async function record(ctx: Ctx, input: JudgmentInput): Promise<RecordJudgmentView> {
  localJudgments(ctx);
  const store = storeOf(ctx);
  const now = ctx.now();
  const agent = ctx.judge.role === 'agent';
  if (agent) {
    const experts = ctx.engine.config.judge.experts;
    if (experts.length === 0) {
      throw new OortRefusedError(
        'An agent records judgments only for experts listed in judge.experts (the home config, or the config option), and none are listed.',
        { reason: 'experts-not-listed' },
      );
    }
    if (!experts.includes(input.by.trim())) {
      throw new OortRefusedError(
        'by is not one of the experts listed in judge.experts, so an agent cannot record judgments in their name.',
        { reason: 'not-an-expert' },
      );
    }
  }
  const day = now.toISOString().slice(0, 10);
  if (agent) {
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
    return {
      outcome: r.outcome,
      id: r.memory.id,
      ...(r.supersedes !== undefined && { corrects: r.supersedes }),
      status: agent ? 'agent-recorded' : 'recorded',
      redacted: [...r.redacted],
      ...(r.embedFailed === true && { embedFailed: true as const }),
    };
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
  const m = await findLocal(ctx, id);
  if (m.type !== 'judgment' || m.judgment === undefined) {
    throw new OortNotFoundError('No judgment with that id in this scope.');
  }
  const now = ctx.now();
  if (!isUnconfirmedAgentJudgment(m.judgment)) return { id: m.id, changed: false };
  if (!isActiveJudgment(m, now)) {
    throw new OortRefusedError('That judgment is not current, so it cannot be confirmed.', {
      reason: 'not-current',
    });
  }
  const ok = await confirmJudgment(storeOf(ctx), ctx.principal.grant, m, ctx.judge.operator, now);
  return { id: m.id, changed: ok };
}
