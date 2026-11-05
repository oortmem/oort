import { filterFor } from '@oortmem/claude-code';
import { consolidate, readAgents, type ConsolidateResult } from '@oortmem/core';
import { uiFor } from '../ui.js';
import { Refusal, scopeLabel, withWired, type Ctx } from '../util.js';

/**
 * `oort consolidate`: expire, re-tier and evict the memories visible from the cwd: your Planet and
 * this agent's Star, plus the Star of every agent configured as one (`oort connect <host> --star`),
 * which no other agent's consolidation reaches. Each node is consolidated on its own.
 */
export async function consolidateCommand(ctx: Ctx): Promise<number> {
  return withWired(ctx, async (w) => {
    if (w.mode === 'cloud') {
      throw new Refusal('In cloud mode Oort Cloud consolidates your memories itself (daily).');
    }
    const now = new Date();
    const stars = Object.entries(readAgents(w.config.home))
      .filter(([id, a]) => a.star && id !== w.agent.id)
      .map(([id]) => id);
    const total: ConsolidateResult = {
      promoted: [],
      demoted: [],
      evicted: [],
      expired: [],
      skipped: 0,
    };
    for (const agentId of [w.agent.id, ...stars]) {
      const r = await consolidate(
        { ...filterFor(w.scope), agentId },
        { store: w.store, config: w.config, now },
      );
      // The Planet is consolidated again for each agent: idempotent for one `now`.
      for (const k of ['promoted', 'demoted', 'evicted', 'expired'] as const) {
        total[k].push(...r[k].filter((id) => !total[k].includes(id)));
      }
      total.skipped += r.skipped;
    }
    const ui = uiFor(ctx.io);
    ctx.io.out(ui.header('consolidate', scopeLabel(w)));
    ctx.io.out(
      ui.kv([
        ['promoted', String(total.promoted.length)],
        ['demoted', String(total.demoted.length)],
        ['evicted', String(total.evicted.length)],
        ['expired', String(total.expired.length)],
        ['skipped', String(total.skipped)],
      ]),
    );
    return 0;
  });
}
