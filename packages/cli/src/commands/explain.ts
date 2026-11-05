import { uiFor } from '../ui.js';
import {
  age,
  agentLabel,
  clip,
  degradedHint,
  fixed,
  scopeLabel,
  short,
  withWired,
  type Ctx,
} from '../util.js';
import type { RecallResult } from '@oortmem/core';
import {
  includeLevels,
  runRecall,
  temporalView,
  viewIgnored,
  viewIgnoredWarning,
  type TemporalFlags,
} from './recall.js';

/** The temporal view in a few words: `current`, `as-of 2026-04-01`. */
export function timeMode(t: RecallResult['temporal']): string {
  // A backend that reports no view (an older cloud API) gets no claim either way.
  if (t === undefined) return 'not reported';
  const at = t.asOf ?? t.knownAt;
  return at === undefined ? t.mode : `${t.mode} ${at.slice(0, 10)}`;
}

/** The header line: `mode: as-of 2026-04-01 (from the query)`. */
export function modeLabel(t: RecallResult['temporal']): string {
  return `mode: ${timeMode(t)}${t?.inferred === true ? ' (from the query)' : ''}`;
}

/**
 * Where a memory came from, for the table: `your Planet`, `this agent's Star`, `Star cursor`, with
 * `(overridden)` when a narrower memory in the result contradicts it. `-` when not reported.
 */
export function fromLabel(o: RecallResult['memories'][number]['origin']): string {
  if (o === undefined) return '-';
  const where = o.from.replace(/^from /, '');
  return o.overriddenBy === undefined ? where : `${where} (overridden)`;
}

/** `oort explain "<query>" [--json] [temporal flags]`: recall, with each stage's rank and score. */
export async function explainCommand(
  query: string,
  opts: { json?: boolean; include?: string } & TemporalFlags,
  ctx: Ctx,
): Promise<number> {
  const view = temporalView(opts);
  const include = includeLevels(opts.include);
  return withWired(ctx, async (w) => {
    const now = new Date();
    const result = await runRecall(w, query, view, now, include);
    degradedHint(ctx.io, w, result.degraded);
    if (viewIgnored(view, result)) ctx.io.err(viewIgnoredWarning(view));
    if (opts.json === true) {
      const memories = result.memories.map((m, i) => ({
        rank: i + 1,
        id: m.id,
        type: m.type,
        tier: m.tier,
        validFrom: m.validFrom,
        text: m.text,
        explanation: m.explanation,
        ...(m.origin !== undefined && { origin: m.origin }),
      }));
      const out = {
        agent: { id: w.agent.id, home: w.agent.home },
        ...(result.read !== undefined && { read: result.read }),
        memories,
        ...(result.temporal !== undefined && { temporal: result.temporal }),
        timings: result.timings,
        ...(result.degraded !== undefined && { degraded: result.degraded }),
      };
      ctx.io.out(`${JSON.stringify(out, null, 2)}\n`);
      return 0;
    }
    const ui = uiFor(ctx.io);
    const rows = result.memories.map((m, i) => {
      const e = m.explanation;
      return [
        String(i + 1),
        short(m.id),
        m.type,
        ui.tier(m.tier),
        age(m.validFrom, now),
        e.lexicalRank === undefined ? '-' : String(e.lexicalRank),
        e.denseRank === undefined ? '-' : String(e.denseRank),
        fixed(e.rrf, 4),
        fixed(e.fused, 4),
        fixed(e.reranked, 3),
        fixed(e.activation),
        e.hydrated ? 'yes' : 'no',
        fromLabel(m.origin),
        clip(m.text, 80),
      ];
    });
    const t = result.timings;
    ctx.io.out(
      ui.header(
        'explain',
        `${result.memories.length} memories in ${fixed(t['totalMs'], 1)} ms`,
        scopeLabel(w),
        agentLabel(w),
        ...(result.read !== undefined ? [`reads: ${result.read.join(', ')}`] : []),
        modeLabel(result.temporal),
        ...(result.degraded !== undefined ? [`degraded: ${result.degraded.join(', ')}`] : []),
      ),
    );
    ctx.io.out(
      ui.table(
        [
          'rank',
          'id',
          'type',
          'tier',
          'age',
          'lexical',
          'dense',
          'rrf',
          'fused',
          'reranked',
          'activation',
          'hydrated',
          'from',
          'text',
        ],
        rows,
      ),
    );
    return 0;
  });
}
