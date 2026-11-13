import {
  MissingCredentialError,
  VERSION,
  activation,
  consolidateGrant,
  forgetMemory,
  grantWrites,
  observe as coreObserve,
  type Memory,
  type MemoryOutcomeKind,
  type Observation,
} from '@oortmem/core';
import { supersedeChain } from '../engine/chain.js';
import {
  chosenDegradations,
  runRecall,
  viewIgnored,
  viewIgnoredWarning,
} from '../engine/recall.js';
import { rememberFacts } from '../remember.js';
import { adapterProblem, shapeLinks } from '../util.js';
import { LOCAL_PROVIDER } from '../local-models.js';
import { storeOf, target, viewOf, type Ctx } from './context.js';
import {
  OortAmbiguousIdError,
  OortCloudOnlyError,
  OortNotFoundError,
  OortRefusedError,
  OortUsageError,
  needsKey,
  type ModelRole,
} from './errors.js';
import type {
  ConsolidateResult,
  Explanation,
  LinkResult,
  UnlinkResult,
  ForgetResult,
  MemoryType,
  MemoryView,
  ObserveResult,
  Outcome,
  PinResult,
  Place,
  RecallOptions,
  RecallResult,
  RememberResult,
  RouteKind,
  Turn,
  Warning,
  Whoami,
} from './types.js';
import { clean, memoryView, recallView } from './views.js';
import { iso } from './validate.js';

/**
 * The local transport (CON-108): the engine in this process, under the handle's principal. Every
 * read and write goes through `ctx.principal.grant`, so the store enforces isolation.
 */

/** The memory `ref` names inside the grant: an exact id first (O(1)), else a unique prefix. */
export async function findLocal(ctx: Ctx, ref: string): Promise<Memory> {
  const store = storeOf(ctx);
  const grant = ctx.principal.grant;
  const exact = await store.get(grant, ref);
  if (exact !== null) return exact;
  const matches = (await store.list(grant, { validOnly: false, embeddings: false })).filter((m) =>
    m.id.startsWith(ref),
  );
  if (matches.length === 1) return (await store.get(grant, matches[0]!.id)) ?? matches[0]!;
  if (matches.length > 1) {
    throw new OortAmbiguousIdError(
      `That id prefix matches ${matches.length} memories; give more of the id.`,
    );
  }
  throw new OortNotFoundError('No memory with that id in this scope.');
}

/** Refuses a change the grant cannot make (a Planet memory, for an agent whose home is its Star). */
function writable(ctx: Ctx, m: Memory): void {
  if (!grantWrites(ctx.principal.grant, m)) {
    throw new OortRefusedError(
      'This agent keeps its memories in its own Star: it reads the Planet but cannot change it.',
      { reason: 'scope-denied' },
    );
  }
}

/** The write path's adapters, or `needs-key` for the first role with no key or local model. */
function writePathOf(ctx: Ctx, what: string) {
  const e = ctx.engine;
  for (const role of ['embed', 'decide', 'write'] as const) {
    if (e[role] !== undefined) continue;
    const why = e.unavailable[role];
    if (why === undefined || why instanceof MissingCredentialError) throw needsKey(role, what);
    // Present but unusable (an unsupported provider, an embedder the store is not bound to).
    throw why;
  }
  return { embed: e.embed!, decide: e.decide!, write: e.write! };
}

/** Recall's warnings: a missing model, a degraded stage, a time mode the store did not report. */
function recallWarnings(
  ctx: Ctx,
  speed: NonNullable<RecallOptions['speed']>,
  degraded: string[],
  ignored: string | undefined,
): Warning[] {
  const e = ctx.engine;
  const out: Warning[] = [...ctx.warnings];
  const refused = e.relayErrors.at(-1);
  const missing: ModelRole | undefined =
    speed === 'lexical'
      ? undefined
      : e.embed === undefined
        ? 'embed'
        : speed === 'full' && e.rerank === undefined
          ? 'rerank'
          : undefined;
  if (refused !== undefined) {
    out.push({ code: 'recall-degraded', message: `recall degraded. ${refused.message}` });
  } else if (missing !== undefined) {
    const why = adapterProblem(e.unavailable[missing], missing, e.keyStore);
    out.push({
      code: 'lexical-only',
      message: `lexical-only recall.${why === undefined ? '' : ` ${why}`}`,
    });
  } else if (degraded.length > 0) {
    out.push({ code: 'recall-degraded', message: `recall degraded (${degraded.join(', ')}).` });
  }
  if (ignored !== undefined) out.push({ code: 'time-mode-unreported', message: ignored });
  return out;
}

/** Degradations the caller chose (`speed`) are not reported as degradations. */
const chosen = chosenDegradations;

export async function recall(ctx: Ctx, query: string, o: RecallOptions): Promise<RecallResult> {
  if (
    ctx.engine.mode === 'local' &&
    o.include?.some((l) => l === 'constellation' || l === 'galaxy')
  ) {
    throw new OortCloudOnlyError(
      'Constellations and Galaxies live in Oort Cloud; a local store has none.',
      { fix: 'oort cloud use', reason: 'hive-level' },
    );
  }
  const view = viewOf(o);
  const speed = o.speed ?? 'full';
  const now = ctx.now();
  const r = await runRecall(target(ctx), query, view, now, o.include, o.includeWithdrawn === true, {
    k: o.limit ?? 10,
    speed,
    ...((o.within !== undefined || o.near !== undefined) && {
      spatial: {
        ...(o.within !== undefined && { within: o.within }),
        ...(o.near !== undefined && { near: o.near }),
      },
    }),
  });
  const degraded = chosen(r.degraded ?? [], speed);
  const ignored = viewIgnored(view, r) ? viewIgnoredWarning(view) : undefined;
  const warnings =
    ctx.engine.mode === 'cloud'
      ? [
          ...ctx.warnings,
          ...(degraded.length > 0
            ? [{ code: 'recall-degraded', message: `recall degraded (${degraded.join(', ')}).` }]
            : []),
          ...(ignored !== undefined ? [{ code: 'time-mode-unreported', message: ignored }] : []),
        ]
      : recallWarnings(ctx, speed, degraded, ignored);
  return recallView(r, now, {
    degraded,
    warnings,
    ...(view.mode !== undefined && { mode: view.mode }),
    budgetChars: o.budgetChars ?? ctx.engine.config.recall.budgetChars,
  });
}

/** A turn as an Observation (local), its tools left for core's own cap. */
export function observation(turn: Turn, now: Date): Observation {
  return {
    userText: turn.user,
    assistantText: turn.assistant,
    toolSummaries: turn.tools ?? [],
    at: turn.at === undefined ? now.toISOString() : iso(turn.at),
    ...(turn.sessionId !== undefined && { sessionId: turn.sessionId }),
    ...(turn.turnRef !== undefined && { turnRef: turn.turnRef }),
    ...(turn.place !== undefined && { place: turn.place }),
  };
}

export async function observe(ctx: Ctx, turn: Turn): Promise<ObserveResult> {
  const adapters = writePathOf(ctx, 'observe');
  const store = storeOf(ctx);
  const now = ctx.now();
  const r = await coreObserve(observation(turn, now), ctx.principal.scope, {
    store,
    ...adapters,
    config: ctx.engine.config,
    harness: 'sdk',
    home: ctx.principal.agent.home,
    grant: ctx.principal.grant,
    now,
  });
  const memories = [];
  for (const m of r.memories) {
    let supersedes: string | undefined;
    if ((m.outcome === 'superseded' || m.outcome === 'corrected') && m.memoryId !== undefined) {
      supersedes = (await store.get(ctx.principal.grant, m.memoryId))?.supersedes ?? undefined;
    }
    memories.push({
      outcome: m.outcome as Outcome,
      ...(m.memoryId !== undefined && { id: m.memoryId }),
      ...(supersedes !== undefined && { supersedes }),
      ...(m.reason !== undefined && { reason: m.reason }),
    });
  }
  return {
    outcome: r.outcome as Outcome,
    memories,
    counts: { ...r.counts } as Partial<Record<MemoryOutcomeKind, number>>,
    warnings: [...ctx.warnings],
  };
}

export async function remember(
  ctx: Ctx,
  facts: readonly string[],
  type: MemoryType | undefined,
  place?: Place,
): Promise<RememberResult> {
  writePathOf(ctx, 'remember');
  const e = ctx.engine;
  const results = await rememberFacts(
    {
      store: storeOf(ctx),
      config: e.config,
      scope: ctx.principal.scope,
      agent: ctx.principal.agent,
      unavailable: e.unavailable,
      keyStore: e.keyStore,
      ...(e.embed !== undefined && { embed: e.embed }),
      ...(e.decide !== undefined && { decide: e.decide }),
      ...(e.write !== undefined && { write: e.write }),
    },
    facts,
    {
      harness: 'sdk',
      now: ctx.now(),
      grant: ctx.principal.grant,
      ...(type !== undefined && { type }),
      ...(place !== undefined && { place }),
    },
  );
  return { results, warnings: [...ctx.warnings] };
}

export async function forget(ctx: Ctx, id: string, everywhere: boolean): Promise<ForgetResult> {
  if (everywhere) {
    throw new OortCloudOnlyError(
      'forget({ everywhere }) withdraws Constellation copies, which live in Oort Cloud.',
      { fix: 'oort cloud use' },
    );
  }
  const m = await findLocal(ctx, id);
  writable(ctx, m);
  const e = ctx.engine;
  // The later memories that restate it are rewritten to their current fact (CON-144).
  const r = await forgetMemory(
    {
      store: storeOf(ctx),
      ...(e.write !== undefined && { write: e.write }),
      ...(e.embed !== undefined && { embed: e.embed }),
      now: ctx.now(),
    },
    ctx.principal.grant,
    m.id,
  );
  return {
    forgotten: m.id,
    ...(r.rewritten.length > 0 && { rewritten: r.rewritten.map((x) => x.id) }),
    ...(r.notRewritten.length > 0 && { notRewritten: r.notRewritten.map((x) => x.id) }),
  };
}

export async function pin(ctx: Ctx, id: string, pinned: boolean): Promise<PinResult> {
  const m = await findLocal(ctx, id);
  writable(ctx, m);
  if (m.pinned === pinned) return { id: m.id, pinned, changed: false };
  await storeOf(ctx).upsert(ctx.principal.grant, {
    ...m,
    pinned,
    updatedAt: ctx.now().toISOString(),
  });
  return { id: m.id, pinned, changed: true };
}

export async function recent(
  ctx: Ctx,
  since: string | Date | undefined,
  limit: number,
): Promise<{ memories: MemoryView[]; warnings: Warning[] }> {
  const now = ctx.now();
  const from = since === undefined ? -Infinity : Date.parse(iso(since));
  const all = await storeOf(ctx).list(ctx.principal.grant, { validOnly: false, embeddings: false });
  const memories = all
    .filter((m) => Date.parse(m.updatedAt) >= from)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit)
    .map((m) => memoryView(m, now));
  return { memories, warnings: [] };
}

export async function explain(ctx: Ctx, id: string): Promise<Explanation> {
  const store = storeOf(ctx);
  const grant = ctx.principal.grant;
  const now = ctx.now();
  const raw = await findLocal(ctx, id);
  // Shaped: a contradiction naming a memory this principal cannot read is dropped.
  const m = await shapeLinks(store, grant, raw);
  const { links, hidden } = await supersedeChain(store, raw, grant);
  const stored = (await store.linksOf?.(grant, raw.id)) ?? { links: [], blocked: [], hidden: 0 };
  return {
    memory: {
      ...memoryView(m, now),
      salience: m.salience,
      activation: activation(m.accessLog, m.salience, now, ctx.engine.config.activation),
      source: m.source.harness,
    },
    decisions: m.source.decisions.map((d) => ({
      stage: d.stage,
      question: clean(d.question),
      answer: clean(d.answer),
      probability: d.probability,
    })),
    chain: links.map((l) => ({
      id: l.id,
      text: clean(l.text),
      validFrom: l.validFrom,
      validTo: l.validTo,
      endReason: l.endReason,
    })),
    links: stored.links.map((l) => ({
      kind: l.kind,
      id: l.id,
      direction: l.direction,
      ...(l.assertedBy !== undefined && { assertedBy: l.assertedBy }),
      createdAt: l.createdAt,
    })),
    hiddenLinks: hidden + stored.hidden,
  };
}

/** The refusal of a pair the store cannot link: the same as for a missing id. */
const NO_PAIR = 'No memory with that id in this scope.';

/**
 * Links (or unlinks) two memories, asserted by `agent` (CON-148). Ids resolve as `explain`'s do;
 * the store refuses a pair it cannot link (not both written by this handle, not in one Planet or
 * Star, a Constellation, or one memory twice) and that is `not-found`, as for a missing id.
 */
export async function link(ctx: Ctx, from: string, to: string): Promise<LinkResult> {
  const store = storeOf(ctx);
  const [a, b] = [await findLocal(ctx, from), await findLocal(ctx, to)];
  const r = await store.link?.(ctx.principal.grant, a.id, b.id, { assertedBy: 'agent' });
  if (r === undefined || r === null) throw new OortNotFoundError(NO_PAIR);
  return r;
}

export async function unlink(ctx: Ctx, from: string, to: string): Promise<UnlinkResult> {
  const store = storeOf(ctx);
  const [a, b] = [await findLocal(ctx, from), await findLocal(ctx, to)];
  const r = await store.unlink?.(ctx.principal.grant, a.id, b.id, { assertedBy: 'agent' });
  if (r === undefined || r === null) throw new OortNotFoundError(NO_PAIR);
  if (r.refused !== undefined) {
    throw new OortRefusedError(
      'That link was confirmed at a terminal: only `oort unlink`, confirmed at a terminal, removes it.',
      { reason: 'asserted-by-user', fix: 'oort unlink <a> <b>' },
    );
  }
  return { removed: r.removed, blocked: r.blocked };
}

/** Which key or model serves each role (never the key). */
function routes(ctx: Ctx): Whoami['routes'] {
  const e = ctx.engine;
  const out = {} as Whoami['routes'];
  for (const role of ['embed', 'rerank', 'decide', 'write'] as const) {
    const local =
      (role === 'embed' && e.config.embed.provider === LOCAL_PROVIDER) ||
      (role === 'rerank' && e.config.rerank.provider === LOCAL_PROVIDER);
    const r = e.routes[role];
    const kind: RouteKind = local
      ? 'local'
      : r === undefined
        ? e[role] !== undefined
          ? 'own-key'
          : 'missing'
        : r.via === 'oort'
          ? 'oort-pro'
          : r.via === 'vendor'
            ? 'own-key'
            : 'missing';
    out[role] = kind;
  }
  return out;
}

/** The labels of what a principal reads and where its new memories land. */
export function spaces(ctx: Ctx): { reads: string[]; writesTo: string } {
  const a = ctx.principal.agent;
  const planet = ctx.user === null ? 'your Planet' : `Planet ${ctx.user}`;
  if (ctx.user !== null || a.source === 'none') return { reads: [planet], writesTo: planet };
  return {
    reads: [planet, `Star ${a.id}`],
    writesTo: a.home === 'star' ? `Star ${a.id}` : planet,
  };
}

export async function whoami(ctx: Ctx): Promise<Whoami> {
  const a = ctx.principal.agent;
  return {
    mode: 'local',
    account: null,
    agent: a.source === 'none' ? null : a.id,
    project: ctx.principal.scope.projectId ?? null,
    user: ctx.user,
    ...spaces(ctx),
    version: VERSION,
    routes: routes(ctx),
  };
}

export async function consolidate(
  ctx: Ctx,
  budgetMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ConsolidateResult> {
  const deadline = budgetMs === undefined ? Infinity : Date.now() + budgetMs;
  const r = await consolidateGrant(ctx.principal.grant, {
    store: storeOf(ctx),
    config: ctx.engine.config,
    now: ctx.now(),
    shouldStop: () => Date.now() >= deadline || signal?.aborted === true,
  });
  return {
    promoted: [...r.promoted],
    demoted: [...r.demoted],
    evicted: [...r.evicted],
    expired: [...r.expired],
    skipped: r.skipped,
    complete: r.complete,
  };
}

/** A usage error for an option a mode does not take. */
export function notInMode(field: string, mode: string): OortUsageError {
  return new OortUsageError(`${field} is not available in ${mode} mode.`, {
    reason: 'invalid-argument',
  });
}
