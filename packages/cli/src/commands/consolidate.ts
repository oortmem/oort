import { filterFor } from '@oortmem/claude-code';
import { consolidate } from '@oortmem/core';
import { uiFor } from '../ui.js';
import { Refusal, scopeLabel, withWired, type Ctx } from '../util.js';

/** `oort consolidate`: expire, re-tier and evict the memories visible from the cwd. */
export async function consolidateCommand(ctx: Ctx): Promise<number> {
  return withWired(ctx, async (w) => {
    if (w.mode === 'cloud') {
      throw new Refusal('In cloud mode Oort Cloud consolidates your memories itself (daily).');
    }
    const r = await consolidate(filterFor(w.scope), { store: w.store, config: w.config });
    const ui = uiFor(ctx.io);
    ctx.io.out(ui.header('consolidate', scopeLabel(w)));
    ctx.io.out(
      ui.kv([
        ['promoted', String(r.promoted.length)],
        ['demoted', String(r.demoted.length)],
        ['evicted', String(r.evicted.length)],
        ['expired', String(r.expired.length)],
        ['skipped', String(r.skipped)],
      ]),
    );
    return 0;
  });
}
