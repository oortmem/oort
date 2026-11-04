import { filterFor } from '@oortmem/claude-code';
import { formatForInjection, recall, type RecallMode, type RecallResult } from '@oortmem/core';
import { uiFor } from '../ui.js';
import {
  Refusal,
  cloudOf,
  degradedHint,
  scopeLabel,
  shapeLinks,
  withoutEmbedding,
  withWired,
  type Ctx,
} from '../util.js';
import type { Wired } from '../wire.js';

export interface RecallOptions extends TemporalFlags {
  json?: boolean;
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

/** Recall for the cwd's project plus global memories; lexical-only without a Voyage key. */
export async function runRecall(
  w: Wired,
  text: string,
  view: TemporalView,
  now: Date,
): Promise<RecallResult> {
  const cloud = cloudOf(w);
  if (cloud !== undefined) {
    // The cloud API reads the same three fields; an older API ignores mode and knownAt.
    return cloud.recall({
      text,
      ...(w.scope.projectId !== undefined && { project: w.scope.projectId }),
      ...view,
      k: 10,
    });
  }
  return recall(
    { text, scope: filterFor(w.scope), ...view },
    {
      store: w.store,
      config: w.config,
      now,
      ...(w.embed !== undefined && { embed: w.embed }),
      ...(w.rerank !== undefined && { rerank: w.rerank }),
    },
  );
}

/** `oort recall "<text>" [--json] [--as-of <iso> | --known-at <iso> | --history]` */
export async function recallCommand(text: string, opts: RecallOptions, ctx: Ctx): Promise<number> {
  const view = temporalView(opts);
  return withWired(ctx, async (w) => {
    const now = new Date();
    const result = await runRecall(w, text, view, now);
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
      ctx.io.out(`${JSON.stringify(plain, null, 2)}\n`);
    } else {
      const block = formatForInjection(result, w.config.recall.budgetChars, now);
      const ui = uiFor(ctx.io);
      const n = result.memories.length;
      ctx.io.out(ui.header('recall', `${n} ${n === 1 ? 'memory' : 'memories'}`, scopeLabel(w)));
      if (block.length > 0) ctx.io.out(`${block}\n`);
      else if (result.abstained === true)
        ctx.io.err('oort: no relevant memories (matches were below the relevance threshold).\n');
      else ctx.io.err('oort: no memories matched.\n');
    }
    return 0;
  });
}
