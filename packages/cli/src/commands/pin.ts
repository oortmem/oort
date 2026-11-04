import { filterFor } from '@oortmem/claude-code';
import { findMemory, withWired, type Ctx } from '../util.js';

/** `oort pin <id>` / `oort unpin <id>`: consolidation never sends a pinned memory to cold. */
export async function pinCommand(id: string, pinned: boolean, ctx: Ctx): Promise<number> {
  return withWired(ctx, async (w) => {
    const m = await findMemory(w.store, filterFor(w.scope), id);
    if (m.pinned === pinned) {
      ctx.io.out(`${m.id} is already ${pinned ? 'pinned' : 'unpinned'}.\n`);
      return 0;
    }
    await w.store.upsert({ ...m, pinned, updatedAt: new Date().toISOString() });
    ctx.io.out(`${pinned ? 'Pinned' : 'Unpinned'} ${m.id}.\n`);
    return 0;
  });
}
