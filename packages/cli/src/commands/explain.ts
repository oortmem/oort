import { uiFor } from '../ui.js';
import { age, clip, degradedHint, fixed, scopeLabel, short, withWired, type Ctx } from '../util.js';
import { runRecall } from './recall.js';

/** `oort explain "<query>" [--json]`: recall, with each stage's rank and score per memory. */
export async function explainCommand(
  query: string,
  opts: { json?: boolean },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    const now = new Date();
    const result = await runRecall(w, query, undefined, now);
    degradedHint(ctx.io, w, result.degraded);
    if (opts.json === true) {
      const memories = result.memories.map((m, i) => ({
        rank: i + 1,
        id: m.id,
        type: m.type,
        tier: m.tier,
        validFrom: m.validFrom,
        text: m.text,
        explanation: m.explanation,
      }));
      const out = {
        memories,
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
        clip(m.text, 80),
      ];
    });
    const t = result.timings;
    ctx.io.out(
      ui.header(
        'explain',
        `${result.memories.length} memories in ${fixed(t['totalMs'], 1)} ms`,
        scopeLabel(w),
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
          'text',
        ],
        rows,
      ),
    );
    return 0;
  });
}
