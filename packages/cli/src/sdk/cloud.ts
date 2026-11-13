import { VERSION, activation, truncateUtf8, type Memory } from '@oortmem/core';
import {
  OortCloudError,
  everywhereTarget,
  findCloudMemory,
  type CloudClient,
  type CloudMemory,
  type CloudObserveResult,
} from '../cloud.js';
import { scrubForCloud } from '../cloud-scrub.js';
import { cloudRememberRequest } from '../remember.js';
import { starInCloudMessage } from '../util.js';
import { privacyStatement } from '../wire.js';
import type { Ctx } from './context.js';
import { OortInternalError, OortRefusedError, OortUsageError } from './errors.js';
import type {
  EndUserCount,
  EndUserErasure,
  EndUserExport,
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

/**
 * The Oort Cloud client this handle's memory calls use: for an end user, the one that sends
 * `Oort-User` (and checks the key's capability first); else the account's.
 */
export function clientOf(ctx: Ctx): CloudClient {
  const c = ctx.cloud ?? ctx.engine.cloud;
  if (c === undefined) throw new Error('unreachable: cloud mode without a client');
  return c;
}

/** The account's client: whoami and the end-user routes never name an end user. */
function accountClient(ctx: Ctx): CloudClient {
  const c = ctx.engine.cloud;
  if (c === undefined) throw new Error('unreachable: cloud mode without a client');
  return c;
}

/**
 * The client for end user `user` (CON-132), from the engine's: it shares the engine's connection
 * and its once-per-key capability check.
 */
export function endUserClient(ctx: Pick<Ctx, 'engine'>, user: string): CloudClient {
  const c = ctx.engine.cloud;
  if (c === undefined) throw new Error('unreachable: cloud mode without a client');
  return c.forEndUser(user);
}

/**
 * An end user reads their Planet only (CON-132, as a local end-user handle): a Star, a
 * Constellation or a Galaxy in `include` is refused before anything is sent.
 */
export function checkUserInclude(ctx: Ctx, include: readonly string[] | undefined): void {
  if (ctx.user === null || include === undefined) return;
  if (include.some((l) => l !== 'planet' && l !== 'self')) {
    throw new OortRefusedError(
      "This end user's handle reads only their Planet: leave star, constellation and galaxy out of include.",
      { reason: 'scope-denied' },
    );
  }
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
  // Scrubbed here, before it leaves the machine; a mostly-secret turn is never sent.
  const s = scrubForCloud({
    user: turn.user,
    assistant: turn.assistant,
    at: turn.at === undefined ? ctx.now().toISOString() : iso(turn.at),
    ...(turn.sessionId !== undefined && { session: turn.sessionId }),
    ...(turn.tools !== undefined && turn.tools.length > 0 && { tools: capTools(turn.tools) }),
  });
  if (s.dropped) {
    return {
      outcome: 'skipped',
      memories: [{ outcome: 'skipped', reason: 'secret' }],
      counts: { skipped: 1 },
      warnings: [...ctx.warnings],
    };
  }
  const r = await clientOf(ctx).observe({
    ...project(ctx),
    ...(turn.turnRef !== undefined && { turnRef: turn.turnRef }),
    observation: s.turn,
  });
  return observeView(r, [...ctx.warnings]);
}

/**
 * One observe per fact, as the MCP server's cloud `remember` sends it (`cloudRememberRequest`:
 * framed, scrubbed here, with a stable `turnRef`); a mostly-secret fact is skipped, never sent.
 */
export async function remember(
  ctx: Ctx,
  facts: readonly string[],
  type: MemoryType | undefined,
): Promise<RememberResult> {
  refuseStar(ctx);
  const results: RememberResult['results'] = [];
  for (const [i, fact] of facts.entries()) {
    const req = cloudRememberRequest(fact, {
      type,
      at: ctx.now().toISOString(),
      project: project(ctx),
    });
    if (req.dropped) {
      results.push({ fact: i, outcome: 'skipped', reason: 'secret' });
      continue;
    }
    const r = await clientOf(ctx).observe(req.body);
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
  if (everywhere && ctx.user !== null) {
    // Constellation copies are the account's: an end user has none (the API refuses it too).
    throw new OortUsageError(
      "forget({ everywhere }) withdraws the account's Constellation copies; an end user has none. Leave everywhere out.",
      { reason: 'user-not-supported' },
    );
  }
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
      question: clean(d.question),
      answer: clean(d.answer),
      probability: d.probability,
    })),
    chain,
    links: [],
    hiddenLinks: hidden,
  };
}

export async function whoami(ctx: Ctx): Promise<Whoami> {
  const a = ctx.principal.agent;
  const agent = a.source === 'none' ? undefined : a.id;
  const me = await accountClient(ctx).whoami(agent);
  if (ctx.user !== null) {
    // An end user's handle reads and writes their Planet alone, never the account's spaces.
    const planet = `Planet ${ctx.user}`;
    return {
      mode: 'cloud',
      account: me.account,
      agent: agent ?? null,
      project: ctx.principal.scope.projectId ?? null,
      user: ctx.user,
      reads: [planet],
      writesTo: planet,
      version: VERSION,
      routes: { embed: 'cloud', rerank: 'cloud', decide: 'cloud', write: 'cloud' },
    };
  }
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

/** Erases end user `user` (CON-132): the account's route, sent without `Oort-User`. */
export async function eraseEndUser(ctx: Ctx, user: string): Promise<EndUserErasure> {
  const r = await accountClient(ctx).eraseEndUser(user);
  return { erased: user, ...r };
}

/**
 * Exports end user `user` (CON-137): the account's route, sent without `Oort-User`. The count is
 * the manifest's, checked against the lines that follow it.
 */
export async function exportEndUser(ctx: Ctx, user: string): Promise<EndUserExport> {
  const jsonl = await accountClient(ctx).exportEndUser(user);
  const lines = jsonl.split('\n').filter((l) => l.trim() !== '');
  let head: unknown;
  try {
    head = JSON.parse(lines[0] ?? '');
  } catch {
    head = undefined;
  }
  const h = head as { oort?: unknown; version?: unknown; memories?: unknown } | undefined;
  if (h?.oort !== 'export' || h.version !== 1 || h.memories !== lines.length - 1) {
    throw new OortInternalError('Oort Cloud sent an export this SDK cannot read.');
  }
  // Every line must be this end user's (a version 1 line's scope names its customer): a
  // server-side mix-up must never reach the person as their data.
  const customer = `u:${user}`;
  for (const l of lines.slice(1)) {
    let m: unknown;
    try {
      m = JSON.parse(l);
    } catch {
      m = undefined;
    }
    if ((m as { scope?: { customerId?: unknown } } | undefined)?.scope?.customerId !== customer) {
      throw new OortInternalError(
        "Oort Cloud sent an export with a memory that is not this end user's; nothing was returned.",
      );
    }
  }
  return { exported: user, memories: lines.length - 1, jsonl };
}

/** How many end users the account has, and its plan's limit (CON-132). */
export async function countEndUsers(ctx: Ctx): Promise<EndUserCount> {
  const r = await accountClient(ctx).endUsersCount();
  return { endUsers: r.endUsers, limit: r.limit };
}

/** Judgments and consolidation live in the local engine only. */
export function localOnly(what: string): OortRefusedError {
  return new OortRefusedError(
    `${what} is local-only for now: Oort Cloud does not hold it yet. Use mode: 'local'.`,
    { fix: 'oort cloud use --local', reason: 'local-only' },
  );
}
