import { filterFor } from '@oortmem/claude-code';
import { formatForInjection, type RecallResult } from '@oortmem/core';
import {
  includeLevels,
  runRecall,
  temporalView,
  viewIgnored,
  viewIgnoredWarning,
  type TemporalFlags,
  type TemporalView,
} from '../engine/recall.js';
import { emit, jsonMode } from '../output.js';
import { uiFor } from '../ui.js';
import {
  agentLabel,
  degradedHint,
  scopeLabel,
  shapeLinks,
  withoutEmbedding,
  withWired,
  warn,
  type Ctx,
} from '../util.js';
import type { Wired } from '../wire.js';

// Moved to the UI-free engine (CON-108); re-exported for the commands and the MCP server.
export {
  includeLevels,
  runRecall,
  temporalView,
  viewIgnored,
  viewIgnoredWarning,
  type TemporalFlags,
  type TemporalView,
} from '../engine/recall.js';

export interface RecallOptions extends TemporalFlags {
  json?: boolean;
  /** `--include planet,star`: the levels to read (comma list). */
  include?: string;
  /** `--include-withdrawn`: also show withdrawn judgments (CON-71). */
  includeWithdrawn?: boolean;
}

/** Recall's warnings, on stderr and in the envelope: a degraded stage, an ignored time mode. */
export function recallWarnings(ctx: Ctx, w: Wired, view: TemporalView, result: RecallResult): void {
  degradedHint(ctx, w, result.degraded);
  if (viewIgnored(view, result)) warn(ctx, 'time-mode-unreported', viewIgnoredWarning(view));
}

/** `oort recall "<text>" [--json] [--as-of <iso> | --known-at <iso> | --history]` */
export async function recallCommand(text: string, opts: RecallOptions, ctx: Ctx): Promise<number> {
  const view = temporalView(opts);
  const include = includeLevels(opts.include);
  return withWired(ctx, async (w) => {
    const now = new Date();
    const result = await runRecall(w, text, view, now, include, opts.includeWithdrawn === true);
    recallWarnings(ctx, w, view, result);
    if (jsonMode(ctx)) {
      const filter = filterFor(w.scope);
      // Cloud memories arrive already shaped for this account.
      const shaped =
        w.mode === 'cloud'
          ? result.memories
          : await Promise.all(result.memories.map((m) => shapeLinks(w.store, filter, m)));
      emit(ctx, { ...result, memories: shaped.map(withoutEmbedding) });
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
