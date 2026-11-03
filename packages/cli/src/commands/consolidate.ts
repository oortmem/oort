import { filterFor } from '@oortmem/claude-code';
import { consolidate } from '@oortmem/core';
import { withWired, type Ctx } from '../util.js';

/** `oort consolidate`: expire, re-tier and evict the memories visible from the cwd. */
export async function consolidateCommand(ctx: Ctx): Promise<number> {
  return withWired(ctx, async (w) => {
    const r = await consolidate(filterFor(w.scope), { store: w.store, config: w.config });
    ctx.io.out(
      `promoted ${r.promoted.length}\ndemoted ${r.demoted.length}\nevicted ${r.evicted.length}\nexpired ${r.expired.length}\n`,
    );
    return 0;
  });
}
