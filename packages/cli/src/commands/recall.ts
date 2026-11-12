import { filterFor } from '@oortmem/claude-code';
import { fitForInjection, formatForInjection, type RecallResult } from '@oortmem/core';
import {
  RECALL_SPEEDS,
  chosenDegradations,
  includeLevels,
  runRecall,
  temporalView,
  viewIgnored,
  viewIgnoredWarning,
  spatialFilter,
  type RecallSpeed,
  type SpatialFlags,
  type TemporalFlags,
  type TemporalView,
} from '../engine/recall.js';
import { emit, jsonMode } from '../output.js';
import { uiFor } from '../ui.js';
import { LIMITS } from '../sdk/validate.js';
import {
  Refusal,
  agentLabel,
  degradedHint,
  scopeLabel,
  shapeLinks,
  withoutEmbedding,
  withWired,
  warn,
  type Ctx,
  shown,
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

export interface RecallOptions extends TemporalFlags, SpatialFlags {
  json?: boolean;
  /** `--include planet,star`: the levels to read (comma list). */
  include?: string;
  /** `--include-withdrawn`: also show withdrawn judgments (CON-71). */
  includeWithdrawn?: boolean;
  /** `--limit <n>`: at most this many memories, 1 to 50 (the SDK's `limit`). */
  limit?: string;
  /** `--speed full|fast|lexical` (the SDK's `speed`). */
  speed?: string;
  /** `--budget-chars <n>`: the printed block's size (the SDK's `budgetChars`). */
  budgetChars?: string;
}

/** The SDK's recall options from the flags, checked before anything is wired. */
export interface RecallTuning {
  k?: number;
  speed: RecallSpeed;
  budgetChars?: number;
}

const WHOLE = /^[0-9]+$/;

/**
 * The `<oort-memory>` block's own tags take this many characters (core's `fitForInjection`), so a
 * smaller `--budget-chars` could never hold a memory.
 */
export const BLOCK_TAG_CHARS = '<oort-memory>\n'.length + '\n</oort-memory>'.length;

/** `--limit`, `--speed` and `--budget-chars`, with the SDK's bounds; a bad value is a usage error. */
export function recallTuning(
  o: Pick<RecallOptions, 'limit' | 'speed' | 'budgetChars'>,
): RecallTuning {
  const t: RecallTuning = { speed: 'full' };
  if (o.limit !== undefined) {
    const n = WHOLE.test(o.limit.trim()) ? Number(o.limit.trim()) : NaN;
    if (!(n >= 1 && n <= LIMITS.recallLimit)) {
      throw new Refusal(`--limit must be a whole number from 1 to ${LIMITS.recallLimit}.`);
    }
    t.k = n;
  }
  if (o.speed !== undefined) {
    const s = o.speed.trim().toLowerCase();
    if (!(RECALL_SPEEDS as readonly string[]).includes(s)) {
      throw new Refusal('--speed must be full, fast (no rerank) or lexical (no model call).');
    }
    t.speed = s as RecallSpeed;
  }
  if (o.budgetChars !== undefined) {
    const n = WHOLE.test(o.budgetChars.trim()) ? Number(o.budgetChars.trim()) : NaN;
    if (!(Number.isSafeInteger(n) && n > BLOCK_TAG_CHARS)) {
      throw new Refusal(
        `--budget-chars must be a whole number of characters, at least ${BLOCK_TAG_CHARS + 1} (the block's tags take ${BLOCK_TAG_CHARS}).`,
      );
    }
    t.budgetChars = n;
  }
  return t;
}

/** Recall's warnings, on stderr and in the envelope: a degraded stage, an ignored time mode. */
export function recallWarnings(
  ctx: Ctx,
  w: Wired,
  view: TemporalView,
  result: RecallResult,
  speed: RecallSpeed = 'full',
): void {
  degradedHint(ctx, w, result.degraded, speed);
  if (viewIgnored(view, result)) warn(ctx, 'time-mode-unreported', viewIgnoredWarning(view));
}

/**
 * `oort recall "<text>" [--json] [--as-of <iso> | --known-at <iso> | --history] [--limit <n>]
 * [--speed full|fast|lexical] [--budget-chars <n>]`
 */
export async function recallCommand(text: string, opts: RecallOptions, ctx: Ctx): Promise<number> {
  const view = temporalView(opts);
  const include = includeLevels(opts.include);
  const tuning = recallTuning(opts);
  const spatial = spatialFilter(opts);
  return withWired(ctx, async (w) => {
    const now = new Date();
    const raw = await runRecall(w, text, view, now, include, opts.includeWithdrawn === true, {
      ...(tuning.k !== undefined && { k: tuning.k }),
      speed: tuning.speed,
      ...(spatial !== undefined && { spatial }),
    });
    // A stage `--speed` turned off is the caller's choice, not a degradation (as the SDK).
    const result: RecallResult =
      raw.degraded === undefined
        ? raw
        : { ...raw, degraded: chosenDegradations(raw.degraded, tuning.speed) };
    recallWarnings(ctx, w, view, result, tuning.speed);
    if (jsonMode(ctx)) {
      const filter = filterFor(w.scope);
      // Cloud memories arrive already shaped for this account.
      const shaped =
        w.mode === 'cloud'
          ? result.memories
          : await Promise.all(result.memories.map((m) => shapeLinks(w.store, filter, m)));
      emit(ctx, { ...result, memories: shaped.map(withoutEmbedding) });
    } else {
      const budget = tuning.budgetChars ?? w.config.recall.budgetChars;
      const block = formatForInjection(result, budget, now);
      const ui = uiFor(ctx.io);
      // The count is what the block holds: the memories that fit the budget.
      const recalled = result.memories.length;
      const n = fitForInjection(result.memories, budget, now).kept.length;
      const which = tuning.budgetChars !== undefined ? '--budget-chars' : 'recall.budgetChars';
      ctx.io.out(
        ui.header(
          'recall',
          recalled > 0 && n === 0
            ? `none fit ${which}`
            : `${n} ${n === 1 ? 'memory' : 'memories'}${n < recalled ? ` (of ${recalled}; ${which})` : ''}`,
          scopeLabel(w),
          agentLabel(w),
        ),
      );
      // Memory text is a file's or a session's words: shown with its control characters escaped.
      if (block.length > 0) ctx.io.out(`${shown(block, { newlines: true })}\n`);
      else if (recalled > 0)
        ctx.io.err(
          `oort: none of the ${recalled} recalled memories fit within ${budget} characters (${which}).\n`,
        );
      else if (result.abstained === true)
        ctx.io.err('oort: no relevant memories (matches were below the relevance threshold).\n');
      else ctx.io.err('oort: no memories matched.\n');
    }
    return 0;
  });
}
