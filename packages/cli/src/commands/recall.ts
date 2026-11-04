import { filterFor } from '@oortmem/claude-code';
import { formatForInjection, recall, type RecallResult } from '@oortmem/core';
import { uiFor } from '../ui.js';
import {
  Refusal,
  degradedHint,
  scopeLabel,
  shapeLinks,
  withoutEmbedding,
  withWired,
  type Ctx,
} from '../util.js';
import type { Wired } from '../wire.js';

export interface RecallOptions {
  json?: boolean;
  asOf?: string;
}

/** Recall for the cwd's project plus global memories; lexical-only without a Voyage key. */
export async function runRecall(
  w: Wired,
  text: string,
  asOf: string | undefined,
  now: Date,
): Promise<RecallResult> {
  if (asOf !== undefined && Number.isNaN(Date.parse(asOf))) {
    // The value is not echoed: it is free text the user typed.
    throw new Refusal('--as-of is not an ISO date or timestamp.');
  }
  return recall(
    { text, scope: filterFor(w.scope), ...(asOf !== undefined && { asOf }) },
    {
      store: w.store,
      config: w.config,
      now,
      ...(w.embed !== undefined && { embed: w.embed }),
      ...(w.rerank !== undefined && { rerank: w.rerank }),
    },
  );
}

/** `oort recall "<text>" [--json] [--as-of <iso>]` */
export async function recallCommand(text: string, opts: RecallOptions, ctx: Ctx): Promise<number> {
  return withWired(ctx, async (w) => {
    const now = new Date();
    const result = await runRecall(w, text, opts.asOf, now);
    degradedHint(ctx.io, w, result.degraded);
    if (opts.json === true) {
      const filter = filterFor(w.scope);
      const shaped = await Promise.all(result.memories.map((m) => shapeLinks(w.store, filter, m)));
      const plain = { ...result, memories: shaped.map(withoutEmbedding) };
      ctx.io.out(`${JSON.stringify(plain, null, 2)}\n`);
    } else {
      const block = formatForInjection(result, w.config.recall.budgetChars, now);
      const ui = uiFor(ctx.io);
      const n = result.memories.length;
      ctx.io.out(ui.header('recall', `${n} ${n === 1 ? 'memory' : 'memories'}`, scopeLabel(w)));
      if (block.length > 0) ctx.io.out(`${block}\n`);
      else ctx.io.err('oort: no memories matched.\n');
    }
    return 0;
  });
}
