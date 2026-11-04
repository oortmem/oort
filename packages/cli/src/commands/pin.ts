import { filterFor, grantFor } from '@oortmem/claude-code';
import { findCloudMemory } from '../cloud.js';
import { cloudOf, findMemory, withWired, type Ctx } from '../util.js';

/** `oort pin <id>` / `oort unpin <id>`: consolidation never sends a pinned memory to cold. */
export async function pinCommand(id: string, pinned: boolean, ctx: Ctx): Promise<number> {
  return withWired(ctx, async (w) => {
    const cloud = cloudOf(w);
    if (cloud !== undefined) {
      const c = await findCloudMemory(cloud, id);
      if (c.pinned === pinned) {
        ctx.io.out(`${c.id} is already ${pinned ? 'pinned' : 'unpinned'}.\n`);
        return 0;
      }
      await cloud.pin(c.id, pinned);
      ctx.io.out(`${pinned ? 'Pinned' : 'Unpinned'} ${c.id}.\n`);
      return 0;
    }
    const m = await findMemory(w.store, filterFor(w.scope), id);
    if (m.pinned === pinned) {
      ctx.io.out(`${m.id} is already ${pinned ? 'pinned' : 'unpinned'}.\n`);
      return 0;
    }
    await w.store.upsert(grantFor(w.scope), { ...m, pinned, updatedAt: new Date().toISOString() });
    ctx.io.out(`${pinned ? 'Pinned' : 'Unpinned'} ${m.id}.\n`);
    return 0;
  });
}
