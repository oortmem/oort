import {
  confirmFeedback,
  dismissFeedback,
  findFeedback,
  isAgentVia,
  listFeedback,
  recordFeedback,
  retireFeedback,
  supersedeFeedback,
  withoutInvisible,
  type Feedback,
  type FeedbackSignal,
  type FeedbackStatus,
} from '@oortmem/core';
import { localOnly } from './cloud.js';
import { storeOf, type Ctx } from './context.js';
import { OortNotFoundError, OortRefusedError } from './errors.js';
import { findLocal } from './local.js';
import type {
  FeedbackInput,
  FeedbackResultView,
  FeedbackRetireView,
  FeedbackSupersedeView,
  FeedbackView,
} from './types.js';
import { clean } from './views.js';

/**
 * Recall feedback from code. A handle in expert role is a person: what it records counts at once
 * (`via: 'sdk'`), and only it confirms, retires, supersedes or dismisses. A handle in agent role
 * (the default) records as an agent does over MCP (`via: 'mcp'`): pending, changing nothing until
 * a person confirms it.
 */

function local(ctx: Ctx): void {
  if (ctx.engine.mode === 'cloud') throw localOnly('Recall feedback');
}

const person = (ctx: Ctx): boolean => ctx.judge.role === 'expert';

function expertOnly(ctx: Ctx, what: string): void {
  if (!person(ctx)) {
    throw new OortRefusedError(
      `Only a person ${what} feedback: create the handle with judge: { role: "expert" } in a code path where a person decided.`,
      { reason: 'expert-only' },
    );
  }
}

/** Who gives feedback from this handle: the operator in expert role, else the agent. */
function byOf(ctx: Ctx): string {
  if (person(ctx)) return ctx.judge.operator;
  const a = ctx.principal.agent;
  return a.source === 'none' ? 'sdk-agent' : a.id;
}

/** Stored text as shown: invisible characters out (older rows may hold them), then scrubbed. */
const seen = (s: string): string => clean(withoutInvisible(s));

export function feedbackView(f: Feedback): FeedbackView {
  return {
    id: f.id,
    memoryId: f.memoryId,
    signal: f.signal,
    status: f.status,
    ...(f.note !== undefined && { note: seen(f.note) }),
    ...(f.query !== undefined && { query: seen(f.query) }),
    by: seen(f.by),
    agentRecorded: isAgentVia(f.via),
    ...(f.applied !== undefined && { applied: f.applied }),
    ...(f.reason !== undefined && { reason: f.reason }),
    createdAt: f.createdAt,
    ...(f.confirmed !== undefined && {
      confirmed: { at: f.confirmed.at, by: seen(f.confirmed.by) },
    }),
    ...(f.resolved !== undefined && {
      resolved: {
        at: f.resolved.at,
        by: seen(f.resolved.by),
        ...(f.resolved.supersededBy !== undefined && { supersededBy: f.resolved.supersededBy }),
      },
    }),
  };
}

export async function give(ctx: Ctx, input: FeedbackInput): Promise<FeedbackResultView> {
  local(ctx);
  const store = storeOf(ctx);
  const grant = ctx.principal.grant;
  // An agent names a memory by its whole id; a prefix is for people.
  let memoryId: string;
  if (person(ctx)) memoryId = (await findLocal(ctx, input.memoryId)).id;
  else {
    const m = await store.get(grant, input.memoryId);
    if (m === null) throw new OortNotFoundError('No memory with that id in this scope.');
    memoryId = m.id;
  }
  const r = await recordFeedback(
    {
      memoryId,
      signal: input.signal,
      by: byOf(ctx),
      ...(input.note !== undefined && { note: input.note }),
      ...(input.query !== undefined && { query: input.query }),
    },
    {
      store,
      grant,
      scope: ctx.principal.scope,
      via: person(ctx) ? 'sdk' : 'mcp',
      helpedAccesses: ctx.engine.config.feedback.helpedAccesses,
      now: ctx.now(),
    },
  );
  if (!r.kept) return { kept: false, reason: r.reason };
  return {
    kept: true,
    feedback: feedbackView(r.feedback),
    ...(r.applied !== undefined && { applied: r.applied }),
    ...(r.reason !== undefined && { reason: r.reason }),
  };
}

export async function list(
  ctx: Ctx,
  o: { status?: FeedbackStatus; memoryId?: string; signal?: FeedbackSignal; limit?: number },
): Promise<{ feedback: FeedbackView[] }> {
  local(ctx);
  const rows = await listFeedback(storeOf(ctx), ctx.principal.grant, {
    ...(o.status !== undefined && { status: o.status }),
    ...(o.memoryId !== undefined && { memoryId: o.memoryId }),
    ...(o.signal !== undefined && { signal: o.signal }),
    ...(o.limit !== undefined && { limit: o.limit }),
  });
  return { feedback: rows.map(feedbackView) };
}

/** The deps every person's resolve takes; the feedback named by an id or a unique prefix. */
async function resolving(ctx: Ctx, ref: string, what: string) {
  local(ctx);
  expertOnly(ctx, what);
  const store = storeOf(ctx);
  const grant = ctx.principal.grant;
  const f = await findFeedback(store, grant, ref);
  return {
    id: f.id,
    deps: {
      store,
      grant,
      by: ctx.judge.operator,
      helpedAccesses: ctx.engine.config.feedback.helpedAccesses,
      now: ctx.now(),
    },
  };
}

export async function confirm(ctx: Ctx, ref: string): Promise<FeedbackView> {
  const { id, deps } = await resolving(ctx, ref, 'confirms');
  return feedbackView(await confirmFeedback(id, deps));
}

export async function retire(ctx: Ctx, ref: string): Promise<FeedbackRetireView> {
  const { id, deps } = await resolving(ctx, ref, 'retires a memory with');
  const r = await retireFeedback(id, deps);
  return { feedback: feedbackView(r.feedback), memoryId: r.memory.id, endReason: r.endReason };
}

export async function supersede(
  ctx: Ctx,
  ref: string,
  fact: string,
): Promise<FeedbackSupersedeView> {
  const { id, deps } = await resolving(ctx, ref, 'supersedes a memory with');
  const e = ctx.engine;
  const r = await supersedeFeedback(id, fact, {
    ...deps,
    scope: ctx.principal.scope,
    ...(e.embed !== undefined && { embed: e.embed }),
    harness: 'sdk',
  });
  return {
    feedback: feedbackView(r.feedback),
    memoryId: r.memory.id,
    supersedes: r.supersedes,
    redacted: r.redacted,
  };
}

export async function dismiss(ctx: Ctx, ref: string): Promise<FeedbackView> {
  const { id, deps } = await resolving(ctx, ref, 'dismisses');
  return feedbackView(await dismissFeedback(id, deps));
}
