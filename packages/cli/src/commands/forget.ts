import { filterFor } from '@oortmem/claude-code';
import { findCloudMemory } from '../cloud.js';
import { emit, jsonMode } from '../output.js';
import {
  Refusal,
  clip,
  cloudOf,
  confirm,
  findMemory,
  short,
  shown,
  withWired,
  refuseStarInCloud,
  writeGrantFor,
  type Ctx,
} from '../util.js';

/**
 * `oort forget <id> [--yes] [--everywhere]`: deletes a memory everywhere (main record and cold
 * copy). In Oort Cloud a copy shared to a Constellation is the team's memory and stays; the
 * command says so, and `--everywhere` withdraws the copies only you contributed to.
 */
export async function forgetCommand(
  id: string,
  opts: { yes?: boolean; everywhere?: boolean },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    const cloud = cloudOf(w);
    if (opts.everywhere === true && cloud === undefined) {
      throw new Refusal('--everywhere is for Oort Cloud, where memories can be shared.', {
        code: 'cloud-only',
      });
    }
    const m =
      cloud !== undefined
        ? await findCloudMemory(cloud, id)
        : await findMemory(w.store, filterFor(w.scope), id);
    refuseStarInCloud(w);
    if (cloud === undefined) writeGrantFor(w, m);
    const ok = await confirm(
      ctx.io,
      // Memory text may carry escape sequences: the prompt shows them, never runs them.
      `Forget ${short(m.id)} "${shown(clip(m.text, 60))}"?`,
      opts.yes === true,
      'forget it',
      { json: jsonMode(ctx) },
    );
    if (!ok) {
      ctx.io.out('Kept.\n');
      return 0;
    }
    if (cloud !== undefined && opts.everywhere === true) {
      const r = await cloud.forgetEverywhere(m.id);
      ctx.io.out(`Forgot ${m.id}.\n`);
      if (r.withdrawn.length > 0)
        ctx.io.out(`Withdrawn from ${r.withdrawn.length} Constellation(s).\n`);
      if (r.requested.length > 0) {
        ctx.io.out(
          `Others contributed in ${r.requested.length} Constellation(s): their maintainers got a removal request.\n`,
        );
      }
      if (jsonMode(ctx)) {
        emit(ctx, {
          id: m.id,
          forgotten: true,
          withdrawnFrom: r.withdrawn,
          removalRequested: r.requested,
          stillShared: [],
        });
      }
      return 0;
    }
    // Copies in Constellations (none outside the hive beta, where the route answers 403).
    const shared = cloud === undefined ? [] : await cloud.shares(m.id).catch(() => []);
    if (cloud !== undefined) await cloud.forget(m.id);
    else await w.store.forget(writeGrantFor(w, m), m.id);
    ctx.io.out(`Forgot ${m.id}.\n`);
    const live = shared.filter((e) => e.withdrawnAt === null);
    if (live.length > 0) {
      const names = live.map((e) => e.name ?? e.constellation).join(', ');
      ctx.io.out(
        `Still shared to ${names}: that copy is the team's now. \`oort forget ${short(m.id)} --everywhere\` withdraws it.\n`,
      );
    }
    if (jsonMode(ctx)) {
      emit(ctx, {
        id: m.id,
        forgotten: true,
        withdrawnFrom: [],
        removalRequested: [],
        stillShared: live.map((e) => ({ constellation: e.constellation, name: e.name ?? null })),
      });
    }
    return 0;
  });
}
