import { filterFor } from '@oortmem/claude-code';
import type { AssertedBy } from '@oortmem/core';
import { emit, jsonMode } from '../output.js';
import {
  Refusal,
  cloudOf,
  confirm,
  echo,
  findMemory,
  short,
  withWired,
  writeGrant,
  type Ctx,
} from '../util.js';

export interface LinkOptions {
  yes?: boolean;
  json?: boolean;
}

/**
 * `oort link <a> <b>` / `oort unlink <a> <b>` (CON-148). A person asserts a link only on a
 * terminal, after confirming it: that is recorded as `user`. Anything else (stdin not a terminal,
 * `--yes`, `--json`) records `agent`, as an agent running the command would. Both memories must
 * be ones this agent writes, in one Planet or Star; any other pair is refused as a missing id.
 */
export async function linkCommand(
  from: string,
  to: string,
  remove: boolean,
  opts: LinkOptions,
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    if (cloudOf(w) !== undefined) {
      throw new Refusal(
        'Memory links are local-only for now: Oort Cloud does not hold them yet. Run `oort cloud use --local` to use them.',
        { code: 'refused' },
      );
    }
    const store = w.store;
    if (store.links !== true) {
      throw new Refusal('This store does not keep memory links.', { code: 'refused' });
    }
    const filter = filterFor(w.scope);
    const a = await findMemory(store, filter, from);
    const b = await findMemory(store, filter, to);
    const json = jsonMode(ctx);
    let assertedBy: AssertedBy = 'agent';
    if (ctx.io.stdinIsTTY && !json && opts.yes !== true) {
      const question = `${remove ? 'Unlink' : 'Link'} ${short(a.id)} and ${short(b.id)}?`;
      if (!(await confirm(ctx.io, question, false, remove ? 'unlink' : 'link', { json }))) {
        ctx.io.out('Nothing changed.\n');
        return 0;
      }
      assertedBy = 'user';
    }
    const g = writeGrant(w);
    const r = remove
      ? await store.unlink!(g, a.id, b.id, { assertedBy })
      : await store.link!(g, a.id, b.id, { assertedBy });
    if (r === null) {
      throw new Refusal(`No such memory in this project: ${echo(to)}.`, { code: 'not-found' });
    }
    if (json) {
      emit(ctx, { from: a.id, to: b.id, ...r });
      return 0;
    }
    const pair = `${short(a.id)} and ${short(b.id)}`;
    if ('removed' in r) {
      ctx.io.out(
        `${r.removed ? `Unlinked ${pair}` : `${pair} were not linked`}${r.blocked ? '; blocked: nothing links them again until you link them' : ''}.\n`,
      );
    } else {
      ctx.io.out(
        `${r.linked ? `Linked ${pair}` : `${pair} were already linked`} (asserted by ${r.assertedBy}${r.unblocked ? '; the block on them is removed' : ''}).\n`,
      );
    }
    return 0;
  });
}
