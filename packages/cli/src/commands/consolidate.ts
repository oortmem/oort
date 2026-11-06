import { readConsolidationState, recordConsolidation } from '@oortmem/claude-code';
import {
  consolidateGrant,
  principalGrant,
  readAgents,
  type ConsolidateResult,
} from '@oortmem/core';
import { emit, jsonMode } from '../output.js';
import { uiFor } from '../ui.js';
import { Refusal, scopeLabel, withWired, type Ctx } from '../util.js';

/**
 * `oort consolidate`: expire, re-tier and evict your memories, every project and the global ones
 * (each ranked on its own): your Planet and this agent's Star, plus the Star of every agent
 * configured as one (`oort connect <host> --star`), which no other agent's consolidation reaches.
 * Each node is consolidated on its own. The run is recorded where the hook drain looks, so the
 * drain's next automatic run is a day later (CON-48).
 */
export async function consolidateCommand(ctx: Ctx): Promise<number> {
  return withWired(ctx, async (w) => {
    if (w.mode === 'cloud') {
      throw new Refusal('In cloud mode Oort Cloud consolidates your memories itself (daily).', {
        code: 'refused',
      });
    }
    const now = new Date();
    const t0 = performance.now();
    const savesAtStart = readConsolidationState(w.config.home).savesSince;
    const stars = Object.entries(readAgents(w.config.home))
      .filter(([id, a]) => a.star && id !== w.agent.id)
      .map(([id]) => id);
    const total: ConsolidateResult = {
      promoted: [],
      demoted: [],
      evicted: [],
      expired: [],
      skipped: 0,
      complete: true,
    };
    const { orgId, customerId } = w.scope;
    for (const agentId of [w.agent.id, ...stars]) {
      const r = await consolidateGrant(principalGrant({ orgId, customerId, agentId }), {
        store: w.store,
        config: w.config,
        now,
      });
      // The Planet is consolidated again for each agent: idempotent for one `now`.
      for (const k of ['promoted', 'demoted', 'evicted', 'expired'] as const) {
        total[k].push(...r[k].filter((id) => !total[k].includes(id)));
      }
      total.skipped += r.skipped;
      total.complete &&= r.complete;
    }
    recordConsolidation(w.config.home, now, savesAtStart, total, performance.now() - t0);
    if (jsonMode(ctx)) {
      emit(ctx, {
        promoted: total.promoted,
        demoted: total.demoted,
        evicted: total.evicted,
        expired: total.expired,
        counts: {
          promoted: total.promoted.length,
          demoted: total.demoted.length,
          evicted: total.evicted.length,
          expired: total.expired.length,
          skipped: total.skipped,
        },
        complete: total.complete,
        agents: [w.agent.id, ...stars],
      });
      return 0;
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
