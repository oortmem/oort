import { emit, jsonMode } from '../output.js';
import { uiFor } from '../ui.js';
import {
  age,
  agentLabel,
  clip,
  fixed,
  scopeLabel,
  short,
  withWired,
  type Ctx,
  shown,
} from '../util.js';
import type { RecallResult, SpatialFilter } from '@oortmem/core';
import { timeMode } from '../engine/recall.js';

// Moved to the UI-free engine (CON-108).
export { timeMode } from '../engine/recall.js';
import {
  includeLevels,
  recallWarnings,
  runRecall,
  temporalView,
  type TemporalFlags,
} from './recall.js';
import { spatialFilter, type SpatialFlags } from '../engine/recall.js';

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

/**
 * How a link brought a memory in, for the table: the kind and the rank of the memory it was
 * reached from (`about <- #2`). `-` for a memory the search found itself.
 */
export function viaLabel(
  via: RecallResult['memories'][number]['explanation']['via'],
  rankOf: ReadonlyMap<string, number>,
): string {
  if (via === undefined) return '-';
  const rank = rankOf.get(via.from);
  return `${via.kind} <- ${rank === undefined ? short(via.from) : `#${rank}`}`;
}

/** The spatial filter in a few words: `within room:B, within 2 m of 1,2 on hq`. */
export function spatialLabel(f: SpatialFilter): string {
  const parts: string[] = [];
  if (f.within !== undefined) parts.push(`within ${shown(f.within)}`);
  const n = f.near;
  if (n !== undefined) {
    const at = [n.pose.x, n.pose.y, ...(n.pose.z === undefined ? [] : [n.pose.z])].join(',');
    const frame = n.frame === undefined ? '' : ` (${shown(n.frame)})`;
    parts.push(`within ${n.radius} m of ${at} on ${shown(n.mapId)}${frame}`);
  }
  return parts.join(', ');
}

/** `oort explain "<query>" [--json] [temporal flags]`: recall, with each stage's rank and score. */
export async function explainCommand(
  query: string,
  opts: {
    json?: boolean;
    include?: string;
    includeWithdrawn?: boolean;
    links?: boolean;
  } & TemporalFlags &
    SpatialFlags,
  ctx: Ctx,
): Promise<number> {
  const view = temporalView(opts);
  const include = includeLevels(opts.include);
  const spatial = spatialFilter(opts);
  return withWired(ctx, async (w) => {
    const now = new Date();
    const result = await runRecall(w, query, view, now, include, opts.includeWithdrawn === true, {
      ...(spatial !== undefined && { spatial }),
      ...(opts.links !== undefined && { links: opts.links }),
    });
    // The `via` column appears only when a link brought something in.
    const linked = result.memories.some((m) => m.explanation.via !== undefined);
    const rankOf = new Map(result.memories.map((m, i) => [m.id, i + 1]));
    recallWarnings(ctx, w, view, result);
    if (jsonMode(ctx)) {
      const memories = result.memories.map((m, i) => ({
        rank: i + 1,
        id: m.id,
        type: m.type,
        tier: m.tier,
        validFrom: m.validFrom,
        text: m.text,
        explanation: m.explanation,
        ...(m.origin !== undefined && { origin: m.origin }),
        ...(m.place !== undefined && { place: m.place }),
      }));
      const out = {
        agent: { id: w.agent.id, home: w.agent.home },
        ...(result.read !== undefined && { read: result.read }),
        memories,
        ...(result.temporal !== undefined && { temporal: result.temporal }),
        timings: result.timings,
        ...(result.degraded !== undefined && { degraded: result.degraded }),
        ...(result.spatial !== undefined && { spatial: result.spatial }),
      };
      emit(ctx, out);
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
        ...(linked ? [viaLabel(e.via, rankOf)] : []),
        ...(spatial === undefined
          ? []
          : [
              e.placePath === undefined ? '-' : shown(clip(e.placePath, 40)),
              e.distanceM === undefined ? '-' : fixed(e.distanceM, 2),
            ]),
        shown(clip(m.text, 80)),
      ];
    });
    const t = result.timings;
    ctx.io.out(
      ui.header(
        'explain',
        `${result.memories.length} ${result.memories.length === 1 ? 'memory' : 'memories'} in ${fixed(t['totalMs'], 1)} ms`,
        scopeLabel(w),
        agentLabel(w),
        ...(result.read !== undefined ? [`reads: ${result.read.join(', ')}`] : []),
        modeLabel(result.temporal),
        ...(spatial === undefined ? [] : [`place: ${spatialLabel(spatial)}`]),
        ...(result.degraded !== undefined ? [`degraded: ${result.degraded.join(', ')}`] : []),
      ),
    );
    if (rows.length === 0) {
      ctx.io.out(`${ui.info('No memories matched this query.')}\n`);
      return 0;
    }
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
          ...(linked ? ['via'] : []),
          ...(spatial === undefined ? [] : ['place', 'dist m']),
          'text',
        ],
        rows,
      ),
    );
    return 0;
  });
}
