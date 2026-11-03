import { age, clip, degradedHint, fixed, short, table, withWired, type Ctx } from '../util.js';
import { runRecall } from './recall.js';

/** `oort explain "<query>"`: recall, with each stage's rank and score per memory. */
export async function explainCommand(query: string, ctx: Ctx): Promise<number> {
  return withWired(ctx, async (w) => {
    const now = new Date();
    const result = await runRecall(w, query, undefined, now);
    degradedHint(ctx.io, w, result.degraded);
    const rows = result.memories.map((m, i) => {
      const e = m.explanation;
      return [
        String(i + 1),
        short(m.id),
        m.type,
        m.tier,
        age(m.validFrom, now),
        e.lexicalRank === undefined ? '-' : String(e.lexicalRank),
        e.denseRank === undefined ? '-' : String(e.denseRank),
        fixed(e.fused, 4),
        fixed(e.reranked, 3),
        fixed(e.activation),
        e.hydrated ? 'yes' : 'no',
        clip(m.text, 80),
      ];
    });
    ctx.io.out(
      table(
        [
          'rank',
          'id',
          'type',
          'tier',
          'age',
          'lexical',
          'dense',
          'fused',
          'reranked',
          'activation',
          'hydrated',
          'text',
        ],
        rows,
      ),
    );
    const t = result.timings;
    ctx.io.out(
      `${result.memories.length} memories in ${fixed(t['totalMs'], 1)} ms` +
        (result.degraded !== undefined ? ` (degraded: ${result.degraded.join(', ')})` : '') +
        '\n',
    );
    return 0;
  });
}
