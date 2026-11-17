import {
  VERSION,
  activation,
  isLabelOrigin,
  normaliseJudgment,
  truncateUtf8,
  type Memory,
} from '@oortmem/core';
import {
  OortCloudError,
  everywhereTarget,
  type CloudRewrites,
  findCloudMemory,
  type CloudClient,
  type CloudMemory,
  type CloudObserveResult,
} from '../cloud.js';
import { scrubForCloud } from '../cloud-scrub.js';
import { cloudRememberRequest } from '../remember.js';
import { CLOUD_MEMORY_ID, starInCloudMessage } from '../util.js';
import { privacyStatement } from '../wire.js';
import type { Ctx } from './context.js';
import { OortInternalError, OortRefusedError, OortUsageError } from './errors.js';
import type {
  ConfirmOptions,
  EndUserCount,
  EndUserErasure,
  EndUserExport,
  Explanation,
  ForgetResult,
  JudgeItem,
  JudgeOptions,
  JudgeResult,
  JudgmentInput,
  JudgmentVia,
  JudgmentView,
  LabelOriginView,
  MemoryStatus,
  MemoryType,
  MemoryView,
  ObserveResult,
  Outcome,
  PinResult,
  Place,
  RecordJudgmentView,
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
    // The place is checked by core's rules already (validate.ts), as local mode checks it.
    observation: { ...s.turn, ...(turn.place !== undefined && { place: turn.place }) },
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
  place?: Place,
): Promise<RememberResult> {
  refuseStar(ctx);
  const results: RememberResult['results'] = [];
  for (const [i, fact] of facts.entries()) {
    const req = cloudRememberRequest(fact, {
      type,
      at: ctx.now().toISOString(),
      project: project(ctx),
      ...(place !== undefined && { place }),
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
      ...rewriteLists(r.rewrites),
      withdrawn: [...r.withdrawn],
      requested: [...r.requested],
      unreachable: [...r.unreachable],
    };
  }
  const m = await findCloudMemory(c, id);
  return { forgotten: m.id, ...rewriteLists(await c.forget(m.id)) };
}

/**
 * What Oort Cloud did to the later memories of the forgotten one's chain (CON-161), as local mode
 * reports it: memory ids, each list absent when empty, and all absent from an Oort Cloud from
 * before CON-156. Ones left as they were but named with something that is not a memory id are
 * only counted (`notRewrittenUnnamed`).
 */
function rewriteLists(
  r: CloudRewrites | null,
): Pick<ForgetResult, 'rewritten' | 'notRewritten' | 'notRewrittenUnnamed'> {
  if (r === null) return {};
  return {
    ...(r.rewritten.length > 0 && { rewritten: [...r.rewritten] }),
    ...(r.notRewritten.length > 0 && { notRewritten: r.notRewritten.map((x) => x.id) }),
    ...(r.unnamed.length > 0 && { notRewrittenUnnamed: r.unnamed.length }),
  };
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

// ---------------------------------------------------------------------------------------------
// Judgments in Oort Cloud. An Oort key acts in the agent role: it records only for the account's
// listed experts, within the daily cap, and what it records waits for a person to confirm it in
// the dashboard. The answers are the local views; every text in them is scrubbed again here.

/** Where a person confirms, withdraws and lists experts in Oort Cloud. */
export const DASHBOARD_JUDGMENTS_URL = 'https://oortcloud.dev/dashboard/judgments';

/** The expert role in cloud mode: refused before anything is sent. */
export function cloudExpertOnly(): OortRefusedError {
  return new OortRefusedError(
    `Expert decisions in Oort Cloud are made in the dashboard (${DASHBOARD_JUDGMENTS_URL}): an Oort key acts in the agent role, so leave judge: { role: 'expert' } out in cloud mode.`,
    { reason: 'expert-only' },
  );
}

/** The experts list belongs to the account: an end user's handle has none of its own. */
function refuseUser(ctx: Ctx, what: string): void {
  if (ctx.user === null) return;
  throw new OortUsageError(
    `${what} acts for the account; this handle is scoped to an end user. Call it on the handle you made the end user's from.`,
    { reason: 'user-not-supported' },
  );
}

const unreadable = (): OortInternalError =>
  new OortInternalError('Oort Cloud answered a judgment call this SDK cannot read.');

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string => clean(typeof v === 'string' ? v : '');
const texts = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(clean) : [];
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const optNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const nums = (v: unknown): Record<string, number> =>
  Object.fromEntries(
    Object.entries(obj(v)).flatMap(([k, x]) => (typeof x === 'number' ? [[clean(k), x]] : [])),
  );

/** An Oort Cloud memory id, else the answer is unreadable: no other id is put in a result. */
const cloudId = (v: unknown): string => {
  if (typeof v !== 'string' || !CLOUD_MEMORY_ID.test(v)) throw unreadable();
  return v;
};

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** A time from Oort Cloud: only an ISO date is passed on. */
const isoTime = (v: unknown): v is string =>
  typeof v === 'string' && ISO_TIME.test(v) && !Number.isNaN(Date.parse(v));

const VIAS: Record<JudgmentVia, true> = {
  cli: true,
  mcp: true,
  import: true,
  pack: true,
  sdk: true,
};
const JUDGE_STATUSES: Record<JudgeResult['status'], true> = {
  suggested: true,
  'needs-expert': true,
  'precedents-only': true,
};
const JUDGE_WHYS: Record<NonNullable<JudgeResult['why']>, true> = {
  'no-precedents': true,
  'too-far': true,
  'too-few': true,
  'precedents-disagree': true,
  'low-confidence': true,
  'no-decider': true,
  'decider-failed': true,
};
const known = <K extends string>(set: Record<K, true>, v: unknown): v is K =>
  typeof v === 'string' && Object.hasOwn(set, v);

/**
 * How a judgment arrived, as core reads it. A missing or unknown `via` reads `mcp`, which is never
 * taken for a person. Without the server's `agentRecorded`, an `mcp` record no person confirmed is
 * an agent's, as core's `labelOrigin` reads a record from before origins.
 */
function provenance(j: Record<string, unknown>): { via: JudgmentVia; agentRecorded: boolean } {
  const via = known(VIAS, j['via']) ? j['via'] : 'mcp';
  const agentRecorded =
    j['agentRecorded'] === true ||
    (j['agentRecorded'] === undefined && via === 'mcp' && j['confirmed'] !== true);
  return { via, agentRecorded };
}

/**
 * How a label arrived. An Oort Cloud on a core from before label origins answers none: the SDK
 * reads it as older local records read (`agent` when an agent recorded it and no person confirmed
 * it, else `integration`).
 */
function cloudLabel(j: Record<string, unknown>, agentRecorded: boolean): LabelOriginView {
  const up = obj(j['upstream']);
  return {
    origin: isLabelOrigin(j['origin']) ? j['origin'] : agentRecorded ? 'agent' : 'integration',
    ...(typeof j['reviewer'] === 'string' && { reviewer: clean(j['reviewer']) }),
    ...(typeof up['system'] === 'string' &&
      typeof up['actor'] === 'string' && {
        upstream: { system: clean(up['system']), actor: clean(up['actor']) },
      }),
    ...(isLabelOrigin(j['proposedOrigin']) && { proposedOrigin: j['proposedOrigin'] }),
  };
}

function subjectOf(v: unknown): { summary: string; ref?: string } {
  const s = obj(v);
  return {
    summary: text(s['summary']),
    ...(typeof s['ref'] === 'string' && { ref: clean(s['ref']) }),
  };
}

function packOf(v: unknown): { pack?: { id: string; name: string } } {
  const p = obj(v);
  return typeof p['id'] === 'string' && typeof p['name'] === 'string'
    ? { pack: { id: clean(p['id']), name: clean(p['name']) } }
    : {};
}

/** A listed judgment from Oort Cloud as the local `JudgmentView`. */
export function cloudJudgmentView(raw: unknown): JudgmentView & { id: string } {
  const j = obj(raw);
  const id = cloudId(j['id']);
  const { via, agentRecorded } = provenance(j);
  const w = obj(j['withdrawn']);
  return {
    id,
    subject: subjectOf(j['subject']),
    verdict: text(j['verdict']),
    verdicts: texts(j['verdicts']),
    reason: text(j['reason']),
    criteria: texts(j['criteria']),
    domain: text(j['domain']),
    by: text(j['by']),
    decidedAt: isoTime(j['decidedAt']) ? j['decidedAt'] : '',
    via,
    status: (typeof j['status'] === 'string' ? j['status'] : 'current') as MemoryStatus,
    confirmed: j['confirmed'] === true,
    agentRecorded,
    ...cloudLabel(j, agentRecorded),
    ...(isoTime(w['at']) && { withdrawn: { at: w['at'], by: text(w['by']) } }),
    ...packOf(j['pack']),
  };
}

/** Records one judgment as an agent. Its fields are checked here first, as local mode checks them. */
export async function recordJudgment(ctx: Ctx, input: JudgmentInput): Promise<RecordJudgmentView> {
  refuseStar(ctx);
  const body = {
    subject: input.subject,
    verdict: input.verdict,
    reason: input.reason,
    domain: input.domain,
    by: input.by,
    ...(input.ref !== undefined && { ref: input.ref }),
    ...(input.verdicts !== undefined && { verdicts: [...input.verdicts] }),
    ...(input.criteria !== undefined && { criteria: [...input.criteria] }),
    ...(input.decidedAt !== undefined && { decidedAt: iso(input.decidedAt) }),
  };
  // A field the cloud would refuse is refused before anything leaves the machine. An agent's
  // reviewer is ignored, as locally, so it is never sent.
  normaliseJudgment(body, ctx.now());
  return cloudRecordView(await clientOf(ctx).recordJudgment(body));
}

/** Oort Cloud's answer to a record as the local `RecordJudgmentView`. */
export function cloudRecordView(raw: unknown): RecordJudgmentView {
  const r = obj(raw);
  if (typeof r['id'] !== 'string') throw unreadable();
  return {
    outcome: (typeof r['outcome'] === 'string'
      ? r['outcome']
      : 'added') as RecordJudgmentView['outcome'],
    id: r['id'],
    ...(typeof r['corrects'] === 'string' && { corrects: r['corrects'] }),
    status: r['status'] === 'recorded' ? 'recorded' : 'agent-recorded',
    redacted: texts(r['redacted']),
    ...(r['embedFailed'] === true && { embedFailed: true as const }),
  };
}

/**
 * The expert's likely verdict from the account's judgments. Oort Cloud keeps no prediction a
 * cloud handle could resolve (predictions are local-only), so no `predictionId` is passed on.
 */
export async function applyJudgments(
  ctx: Ctx,
  item: JudgeItem,
  o: JudgeOptions,
): Promise<JudgeResult> {
  return cloudJudgeResult(
    await clientOf(ctx).applyJudgments({
      item: {
        summary: item.summary,
        ...(item.details !== undefined && { details: item.details }),
        ...(item.ref !== undefined && { ref: item.ref }),
        ...(item.domain !== undefined && { domain: item.domain }),
        ...(item.by !== undefined && { by: item.by }),
      },
      ...o,
    }),
  );
}

/** Oort Cloud's answer to an apply as the local `JudgeResult`, with no `predictionId`. */
export function cloudJudgeResult(raw: unknown): JudgeResult {
  const r = obj(raw);
  if (!known(JUDGE_STATUSES, r['status']) || !Array.isArray(r['precedents'])) throw unreadable();
  const p = obj(r['prediction']);
  return {
    status: r['status'],
    ...(known(JUDGE_WHYS, r['why']) && { why: r['why'] }),
    ...(typeof p['verdict'] === 'string' && {
      prediction: {
        verdict: clean(p['verdict']),
        probability: num(p['probability']),
        probabilities: nums(p['probabilities']),
      },
    }),
    precedents: r['precedents'].map((x) => {
      const q = obj(x);
      const confirmed = q['confirmed'] === true;
      const { via, agentRecorded } = provenance(q);
      return {
        id: cloudId(q['id']),
        subject: subjectOf(q['subject']),
        verdict: text(q['verdict']),
        reason: text(q['reason']),
        criteria: texts(q['criteria']),
        domain: text(q['domain']),
        by: text(q['by']),
        decidedAt: isoTime(q['decidedAt']) ? q['decidedAt'] : '',
        similarity: num(q['similarity']),
        near: q['near'] === true,
        ...(typeof q['agrees'] === 'boolean' && { agrees: q['agrees'] }),
        via,
        confirmed,
        agentRecorded,
        ...packOf(q['pack']),
      };
    }),
    verdicts: texts(r['verdicts']),
    agreement: nums(r['agreement']),
    similarity: r['similarity'] === 'dense' ? 'dense' : 'lexical',
    threshold: num(r['threshold']),
    minSimilarity: num(r['minSimilarity']),
    ...(Array.isArray(r['degraded']) && { degraded: texts(r['degraded']) }),
    decisions: (Array.isArray(r['decisions']) ? r['decisions'] : []).map((x) => {
      const d = obj(x);
      return {
        stage: text(d['stage']),
        question: text(d['question']),
        answer: text(d['answer']),
        probability: num(d['probability']),
      };
    }),
    ...(optNum(r['importedExcluded']) !== undefined && {
      importedExcluded: optNum(r['importedExcluded'])!,
    }),
    ...(optNum(r['agentRecordedExcluded']) !== undefined && {
      agentRecordedExcluded: optNum(r['agentRecordedExcluded'])!,
    }),
  };
}

/** One page of judgments is at most this many (the API's limit). */
const JUDGMENT_PAGE = 100;

/** The account's judgments, newest first, paged through up to `limit` (default 100). */
export async function listJudgments(
  ctx: Ctx,
  o: { domain?: string; by?: string; all?: boolean; limit?: number },
): Promise<{ judgments: (JudgmentView & { id: string })[] }> {
  const c = clientOf(ctx);
  const limit = o.limit ?? 100;
  const judgments: (JudgmentView & { id: string })[] = [];
  let cursor: string | undefined;
  while (judgments.length < limit) {
    const r = await c.listJudgments({
      ...(o.domain !== undefined && { domain: o.domain }),
      ...(o.by !== undefined && { by: o.by }),
      ...(o.all === true && { all: true }),
      limit: Math.min(JUDGMENT_PAGE, limit - judgments.length),
      ...(cursor !== undefined && { cursor }),
    });
    if (!Array.isArray(r.judgments)) throw unreadable();
    judgments.push(...r.judgments.map(cloudJudgmentView));
    if (typeof r.next !== 'string' || r.next === '' || r.judgments.length === 0) break;
    cursor = r.next;
  }
  return { judgments: judgments.slice(0, limit) };
}

/** Sends a person's decision; Oort Cloud refuses a key's (`expert-only`), as the credential's role decides. */
export async function confirmJudgment(
  ctx: Ctx,
  id: string,
  o: ConfirmOptions,
): Promise<{ id: string; changed: boolean }> {
  const r = obj(
    await clientOf(ctx).confirmJudgment(id, {
      ...(o.reviewer !== undefined && { reviewer: o.reviewer }),
    }),
  );
  if (typeof r['id'] !== 'string') throw unreadable();
  return { id: r['id'], changed: r['changed'] === true };
}

export async function withdrawJudgment(
  ctx: Ctx,
  id: string,
): Promise<{ id: string; withdrawn: true; changed: boolean; by: string | null }> {
  const r = obj(await clientOf(ctx).withdrawJudgment(id));
  if (typeof r['id'] !== 'string') throw unreadable();
  return {
    id: r['id'],
    withdrawn: true,
    changed: r['changed'] === true,
    by: typeof r['by'] === 'string' ? clean(r['by']) : null,
  };
}

/** The experts an agent may record for: the account's list. */
export async function judgmentExperts(ctx: Ctx): Promise<{ experts: string[] }> {
  refuseUser(ctx, 'judge.experts');
  const r = await accountClient(ctx).judgmentExperts();
  return { experts: texts(obj(r)['experts']) };
}

export async function setJudgmentExperts(
  ctx: Ctx,
  experts: readonly string[],
): Promise<{ experts: string[] }> {
  refuseUser(ctx, 'judge.experts');
  const r = await accountClient(ctx).setJudgmentExperts([...experts]);
  return { experts: texts(obj(r)['experts']) };
}
