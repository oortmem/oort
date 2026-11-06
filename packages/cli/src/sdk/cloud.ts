import { VERSION, activation, truncateUtf8, type Memory } from '@oortmem/core';
import {
  OortCloudError,
  everywhereTarget,
  findCloudMemory,
  type CloudClient,
  type CloudMemory,
  type CloudObserveResult,
} from '../cloud.js';
import { rememberTurn } from '../remember.js';
import { starInCloudMessage } from '../util.js';
import { privacyStatement } from '../wire.js';
import type { Ctx } from './context.js';
import { OortRefusedError } from './errors.js';
import type {
  Explanation,
  ForgetResult,
  MemoryType,
  MemoryView,
  ObserveResult,
  Outcome,
  PinResult,
  RememberResult,
  Turn,
  Warning,
  Whoami,
} from './types.js';
import { iso } from './validate.js';
import { clean, memoryView } from './views.js';

/**
 * The cloud transport (CON-108 §8.2): Oort Cloud over HTTPS, as the CLI calls it. Recall goes
 * through the shared `runRecall` (local.ts), which already calls the cloud in cloud mode.
 */

/** The Oort Cloud client (a handle in cloud mode always has one). */
export function clientOf(ctx: Ctx): CloudClient {
  const c = ctx.engine.cloud;
  if (c === undefined) throw new Error('unreachable: cloud mode without a client');
  return c;
}

/** Oort Cloud has no Stars yet: an agent whose home is its Star would write the shared Planet. */
function refuseStar(ctx: Ctx): void {
  const a = ctx.principal.agent;
  if (a.home === 'star') {
    throw new OortRefusedError(starInCloudMessage(a.id), {
      fix: `oort connect ${a.id} --no-star`,
      reason: 'star-in-cloud',
    });
  }
}

/** The project fields every cloud write sends: the id, and an explicit privacy statement only. */
function project(ctx: Ctx): { project?: string; projectPrivate?: boolean } {
  const id = ctx.principal.scope.projectId;
  if (id === undefined) return {};
  return { project: id, ...privacyStatement({ statedPrivacy: ctx.statedPrivacy }) };
}

/** Tool summaries capped as core caps them (16 × 512 bytes): truncated, never refused. */
const capTools = (tools: readonly string[]): string[] =>
  tools.slice(0, 16).map((t) => truncateUtf8(t, 512));

const OUTCOMES: ReadonlySet<string> = new Set([
  'added',
  'reinforced',
  'updated',
  'superseded',
  'corrected',
  'skipped',
]);
const outcomeOf = (s: string): Outcome => (OUTCOMES.has(s) ? (s as Outcome) : 'added');

function observeView(r: CloudObserveResult, warnings: Warning[]): ObserveResult {
  return {
    outcome: outcomeOf(r.outcome),
    memories: r.memories.map((m) => ({
      outcome: outcomeOf(m.action),
      ...(m.id !== undefined && { id: m.id }),
    })),
    counts: Object.fromEntries(
      Object.entries(r.counts ?? {}).filter(([k]) => OUTCOMES.has(k)),
    ) as ObserveResult['counts'],
    ...(r.duplicate === true && { duplicate: true as const }),
    warnings,
  };
}

export async function observe(ctx: Ctx, turn: Turn): Promise<ObserveResult> {
  refuseStar(ctx);
  const r = await clientOf(ctx).observe({
    ...project(ctx),
    ...(turn.turnRef !== undefined && { turnRef: turn.turnRef }),
    observation: {
      user: turn.user,
      assistant: turn.assistant,
      at: turn.at === undefined ? ctx.now().toISOString() : iso(turn.at),
      ...(turn.sessionId !== undefined && { session: turn.sessionId }),
      ...(turn.tools !== undefined && turn.tools.length > 0 && { tools: capTools(turn.tools) }),
    },
  });
  return observeView(r, [...ctx.warnings]);
}

/** One observe per fact, framed exactly as the MCP server's cloud `remember` frames it. */
export async function remember(
  ctx: Ctx,
  facts: readonly string[],
  type: MemoryType | undefined,
): Promise<RememberResult> {
  refuseStar(ctx);
  const results: RememberResult['results'] = [];
  for (const [i, fact] of facts.entries()) {
    const r = await clientOf(ctx).observe({
      ...project(ctx),
      observation: { ...rememberTurn(fact, type), at: ctx.now().toISOString() },
    });
    const first = r.memories[0];
    results.push({
      fact: i,
      outcome: outcomeOf(r.outcome),
      ...(first?.id !== undefined && { id: first.id }),
      ...(r.outcome === 'skipped' && { reason: 'not durable' }),
    });
  }
  return { results, warnings: [...ctx.warnings] };
}

export async function forget(ctx: Ctx, id: string, everywhere: boolean): Promise<ForgetResult> {
  refuseStar(ctx);
  const c = clientOf(ctx);
  if (everywhere) {
    // As `oort forget --everywhere`: by full id, a memory already forgotten is still found through
    // the edges its shared copies left, and outside the hive beta this is refused before anything
    // is forgotten (CON-67).
    const t = await everywhereTarget(c, id);
    const r = await c.forgetEverywhere(t.id);
    return {
      forgotten: t.id,
      withdrawn: [...r.withdrawn],
      requested: [...r.requested],
      unreachable: [...r.unreachable],
    };
  }
  const m = await findCloudMemory(c, id);
  await c.forget(m.id);
  return { forgotten: m.id };
}

/** Cloud pins answer 204 either way, so whether anything changed is unknown (`changed: null`). */
export async function pin(ctx: Ctx, id: string, pinned: boolean): Promise<PinResult> {
  refuseStar(ctx);
  const c = clientOf(ctx);
  const m = await findCloudMemory(c, id);
  await c.pin(m.id, pinned);
  return { id: m.id, pinned, changed: null };
}

/** At most this many memories are scanned for `recent` (5 pages of 100). */
export const RECENT_SCAN = 500;

/**
 * `GET /v1/memories` has no `since`: pages through at most `RECENT_SCAN` memories, filters on
 * `updatedAt >= since`, sorts newest first and keeps `limit` (warning `recent-truncated` when the
 * cap cut the scan).
 */
export async function recent(
  ctx: Ctx,
  since: string | Date | undefined,
  limit: number,
): Promise<{ memories: MemoryView[]; warnings: Warning[] }> {
  const c = clientOf(ctx);
  const now = ctx.now();
  const from = since === undefined ? -Infinity : Date.parse(iso(since));
  const id = ctx.principal.scope.projectId;
  const seen: CloudMemory[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page * 100 >= RECENT_SCAN) {
      truncated = true;
      break;
    }
    const r = await c.list({
      ...(id !== undefined && { project: id }),
      limit: 100,
      ...(cursor !== undefined && { cursor }),
    });
    seen.push(...r.memories);
    if (r.next === undefined || r.memories.length === 0) break;
    cursor = r.next;
  }
  const memories = seen
    .filter((m) => Date.parse(m.updatedAt) >= from)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit)
    .map((m) => memoryView(m, now));
  return {
    memories,
    warnings: truncated
      ? [
          {
            code: 'recent-truncated',
            message: `only the first ${RECENT_SCAN} memories were scanned; older ones may be missing.`,
          },
        ]
      : [],
  };
}

export async function explain(ctx: Ctx, id: string): Promise<Explanation> {
  const c = clientOf(ctx);
  const now = ctx.now();
  const m = (await findCloudMemory(c, id)) as Memory;
  const chain: Explanation['chain'] = [];
  let hidden = 0;
  for (const linkId of [m.supersedes, m.supersededBy]) {
    if (linkId === null) continue;
    try {
      const l = await c.get(linkId);
      chain.push({
        id: l.id,
        text: clean(l.text),
        validFrom: l.validFrom,
        validTo: l.validTo,
        endReason: l.endReason,
      });
    } catch (e) {
      if (e instanceof OortCloudError && e.kind === 'not-found') hidden++;
      else throw e;
    }
  }
  return {
    memory: {
      ...memoryView(m, now),
      salience: m.salience,
      activation: activation(m.accessLog, m.salience, now, ctx.engine.config.activation),
      source: m.source.harness,
    },
    decisions: (m.source.decisions ?? []).map((d) => ({
      stage: d.stage,
      question: d.question,
      answer: d.answer,
      probability: d.probability,
    })),
    chain,
    hiddenLinks: hidden,
  };
}

export async function whoami(ctx: Ctx): Promise<Whoami> {
  const a = ctx.principal.agent;
  const agent = a.source === 'none' ? undefined : a.id;
  const me = await clientOf(ctx).whoami(agent);
  return {
    mode: 'cloud',
    account: me.account,
    agent: agent ?? null,
    project: ctx.principal.scope.projectId ?? null,
    user: null,
    reads: (me.spaces ?? [{ level: 'planet' as const }]).map((s) =>
      s.level === 'planet' ? 'your Planet' : `Constellation ${clean(s.name)}`,
    ),
    writesTo: 'your Planet',
    version: VERSION,
    routes: { embed: 'cloud', rerank: 'cloud', decide: 'cloud', write: 'cloud' },
  };
}

/** Judgments and consolidation live in the local engine only. */
export function localOnly(what: string): OortRefusedError {
  return new OortRefusedError(
    `${what} is local-only for now: Oort Cloud does not hold it yet. Use mode: 'local'.`,
    { fix: 'oort cloud use --local', reason: 'local-only' },
  );
}
