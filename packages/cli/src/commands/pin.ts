import { filterFor } from '@oortmem/claude-code';
import { findCloudMemory } from '../cloud.js';
import {
  cloudOf,
  findMemory,
  refuseStarInCloud,
  withWired,
  writeGrantFor,
  type Ctx,
} from '../util.js';

/** `oort pin <id>` / `oort unpin <id>`: consolidation never sends a pinned memory to cold. */
export async function pinCommand(id: string, pinned: boolean, ctx: Ctx): Promise<number> {
  return withWired(ctx, async (w) => {
    const cloud = cloudOf(w);
    if (cloud !== undefined) {
      refuseStarInCloud(w);
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
    await w.store.upsert(writeGrantFor(w, m), {
      ...m,
      pinned,
      updatedAt: new Date().toISOString(),
    });
    ctx.io.out(`${pinned ? 'Pinned' : 'Unpinned'} ${m.id}.\n`);
    return 0;
  });
}
