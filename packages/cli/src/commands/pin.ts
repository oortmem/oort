import { filterFor } from '@oortmem/claude-code';
import { findCloudMemory } from '../cloud.js';
import { emit, jsonMode } from '../output.js';
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
  const done = (memoryId: string, changed: boolean): number => {
    ctx.io.out(
      changed
        ? `${pinned ? 'Pinned' : 'Unpinned'} ${memoryId}.\n`
        : `${memoryId} is already ${pinned ? 'pinned' : 'unpinned'}.\n`,
    );
    if (jsonMode(ctx)) emit(ctx, { id: memoryId, pinned, changed });
    return 0;
  };
  return withWired(ctx, async (w) => {
    const cloud = cloudOf(w);
    if (cloud !== undefined) {
      refuseStarInCloud(w);
      const c = await findCloudMemory(cloud, id);
      if (c.pinned === pinned) return done(c.id, false);
      await cloud.pin(c.id, pinned);
      return done(c.id, true);
    }
    const m = await findMemory(w.store, filterFor(w.scope), id);
    if (m.pinned === pinned) return done(m.id, false);
    await w.store.upsert(writeGrantFor(w, m), {
      ...m,
      pinned,
      updatedAt: new Date().toISOString(),
    });
    return done(m.id, true);
  });
}
