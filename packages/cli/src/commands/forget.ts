import { filterFor, grantFor } from '@oortmem/claude-code';
import { findCloudMemory } from '../cloud.js';
import { clip, cloudOf, confirm, findMemory, short, withWired, type Ctx } from '../util.js';

/** `oort forget <id> [--yes]`: deletes a memory everywhere (main record and cold copy). */
export async function forgetCommand(
  id: string,
  opts: { yes?: boolean },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    const cloud = cloudOf(w);
    const m =
      cloud !== undefined
        ? await findCloudMemory(cloud, id, w.scope.projectId)
        : await findMemory(w.store, filterFor(w.scope), id);
    const ok = await confirm(
      ctx.io,
      `Forget ${short(m.id)} "${clip(m.text, 60)}"?`,
      opts.yes === true,
      'forget it',
    );
    if (!ok) {
      ctx.io.out('Kept.\n');
      return 0;
    }
    if (cloud !== undefined) await cloud.forget(m.id);
    else await w.store.forget(grantFor(w.scope), m.id);
    ctx.io.out(`Forgot ${m.id}.\n`);
    return 0;
  });
}
