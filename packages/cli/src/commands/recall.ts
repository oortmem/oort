import { filterFor } from '@oortmem/claude-code';
import {
  ScopeDeniedError,
  formatForInjection,
  isIncludeLevel,
  recall,
  type IncludeLevel,
  type RecallMode,
  type RecallResult,
} from '@oortmem/core';
import { uiFor } from '../ui.js';
import {
  Refusal,
  agentLabel,
  cloudOf,
  degradedHint,
  scopeLabel,
  shapeLinks,
  withoutEmbedding,
  withWired,
  echo,
  type Ctx,
  safeJson,
} from '../util.js';
import { privacyStatement, type Wired } from '../wire.js';

export interface RecallOptions extends TemporalFlags {
  json?: boolean;
  /** `--include planet,star`: the levels to read (comma list). */
  include?: string;
  /** `--include-withdrawn`: also show withdrawn judgments (CON-71). */
  includeWithdrawn?: boolean;
}

/** `--include`, checked: known level names, no repeats kept. Undefined: read every level. */
export function includeLevels(raw: string | undefined): IncludeLevel[] | undefined {
  if (raw === undefined) return undefined;
  const names = [...new Set(raw.split(',').map((x) => x.trim().toLowerCase()))].filter(
    (x) => x !== '',
  );
  if (names.length === 0) throw new Refusal('--include needs at least one level.');
  const bad = names.filter((x) => !isIncludeLevel(x));
  if (bad.length > 0) {
    throw new Refusal(
      `--include: unknown level ${echo(bad[0]!)}; expected self, planet, star, constellation or galaxy.`,
    );
  }
  return names as IncludeLevel[];
}

/** The temporal flags `recall` and `explain` share (CON-34). One view at a time. */
export interface TemporalFlags {
  asOf?: string;
  knownAt?: string;
  history?: boolean;
}

/** What `runRecall` passes on: an explicit view, or nothing (the query decides). */
export interface TemporalView {
  mode?: RecallMode;
  asOf?: string;
  knownAt?: string;
}

/** Checks the flags; dates are validated without echoing them (they are free text). */
export function temporalView(f: TemporalFlags): TemporalView {
  const set = [f.asOf !== undefined, f.knownAt !== undefined, f.history === true].filter(Boolean);
  if (set.length > 1) throw new Refusal('Use one of --as-of, --known-at and --history.');
  if (f.asOf !== undefined) {
    if (Number.isNaN(Date.parse(f.asOf))) {
      throw new Refusal('--as-of is not an ISO date or timestamp.');
    }
    return { mode: 'as-of', asOf: new Date(f.asOf).toISOString() };
  }
  if (f.knownAt !== undefined) {
    if (Number.isNaN(Date.parse(f.knownAt))) {
      throw new Refusal('--known-at is not an ISO date or timestamp.');
    }
    return { mode: 'known-at', knownAt: new Date(f.knownAt).toISOString() };
  }
  return f.history === true ? { mode: 'history' } : {};
}

/**
 * True when a view was asked for explicitly but the result reports none: a backend (an older
 * cloud API) that ignores time modes. The results are then probably current facts.
 */
export function viewIgnored(view: TemporalView, r: RecallResult): boolean {
  return view.mode !== undefined && r.temporal === undefined;
}

/** The warning for `viewIgnored`, on stderr. */
export function viewIgnoredWarning(view: TemporalView): string {
  return `oort: the store did not report the time mode, so "${view.mode}" may not have been applied; these may be current facts.\n`;
}

/**
 * Recall for the cwd's project plus global memories, as `w.agent`: the person's Planet and this
 * agent's own Star (`include` narrows it); lexical-only without a Voyage key. A level the agent
 * cannot read is a refusal (`scope_denied`), not an empty answer.
 */
export async function runRecall(
  w: Wired,
  text: string,
  view: TemporalView,
  now: Date,
  include?: IncludeLevel[],
  includeWithdrawn = false,
): Promise<RecallResult> {
  const cloud = cloudOf(w);
  if (cloud !== undefined) {
    // Oort Cloud reads the account's Planet and, in the hive beta, its Constellations; `include`
    // narrows that, and a level the account cannot read is the API's own scope_denied.
    // The cloud API reads the same three fields; an older API ignores mode and knownAt.
    return cloud.recall({
      text,
      ...(w.scope.projectId !== undefined && {
        project: w.scope.projectId,
        ...privacyStatement(w),
      }),
      ...(include !== undefined && { include }),
      // A named agent reads only the Constellations it is attached to (CON-64).
      ...(w.agent.source !== 'none' && { agent: w.agent.id }),
      ...view,
      k: 10,
    });
  }
  try {
    return await recall(
      {
        text,
        scope: filterFor(w.scope),
        home: w.agent.home,
        ...(include !== undefined && { include }),
        ...view,
        ...(includeWithdrawn && { includeWithdrawn: true }),
      },
      {
        store: w.store,
        config: w.config,
        now,
        ...(w.embed !== undefined && { embed: w.embed }),
        ...(w.rerank !== undefined && { rerank: w.rerank }),
      },
    );
  } catch (e) {
    if (e instanceof ScopeDeniedError) {
      throw new Refusal(
        `scope_denied: ${w.agent.id} cannot read ${e.levels.join(', ')} (it reads your Planet and its own Star).`,
      );
    }
    throw e;
  }
}

/** `oort recall "<text>" [--json] [--as-of <iso> | --known-at <iso> | --history]` */
export async function recallCommand(text: string, opts: RecallOptions, ctx: Ctx): Promise<number> {
  const view = temporalView(opts);
  const include = includeLevels(opts.include);
  return withWired(ctx, async (w) => {
    const now = new Date();
    const result = await runRecall(w, text, view, now, include, opts.includeWithdrawn === true);
    degradedHint(ctx.io, w, result.degraded);
    if (viewIgnored(view, result)) ctx.io.err(viewIgnoredWarning(view));
    if (opts.json === true) {
      const filter = filterFor(w.scope);
      // Cloud memories arrive already shaped for this account.
      const shaped =
        w.mode === 'cloud'
          ? result.memories
          : await Promise.all(result.memories.map((m) => shapeLinks(w.store, filter, m)));
      const plain = { ...result, memories: shaped.map(withoutEmbedding) };
      ctx.io.out(`${safeJson(plain)}\n`);
    } else {
      const block = formatForInjection(result, w.config.recall.budgetChars, now);
      const ui = uiFor(ctx.io);
      const n = result.memories.length;
      ctx.io.out(
        ui.header(
          'recall',
          `${n} ${n === 1 ? 'memory' : 'memories'}`,
          scopeLabel(w),
          agentLabel(w),
        ),
      );
      if (block.length > 0) ctx.io.out(`${block}\n`);
      else if (result.abstained === true)
        ctx.io.err('oort: no relevant memories (matches were below the relevance threshold).\n');
      else ctx.io.err('oort: no memories matched.\n');
    }
    return 0;
  });
}
