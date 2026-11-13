import { filterFor } from '@oortmem/claude-code';
import type { AssertedBy } from '@oortmem/core';
import { emit, jsonMode } from '../output.js';
import { Refusal, cloudOf, findMemory, short, withWired, writeGrant, type Ctx } from '../util.js';

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
    // `user` records that the change was confirmed at a terminal: stdin and stdout are both a
    // terminal and the answer is read from the controlling terminal, never from stdin. It is
    // not proof that a person did it (a program can drive a pseudo-terminal), and it grants
    // nothing: its one effect is that an agent call cannot remove the link.
    let assertedBy: AssertedBy = 'agent';
    const atTerminal =
      ctx.io.stdinIsTTY && ctx.io.stdoutIsTTY === true && !json && opts.yes !== true;
    if (atTerminal && ctx.io.askTerminal !== undefined) {
      const question = `${remove ? 'Unlink' : 'Link'} ${short(a.id)} and ${short(b.id)}? [y/N] `;
      const answer = await ctx.io.askTerminal(question);
      if (answer !== undefined) {
        if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
          ctx.io.out('Nothing changed.\n');
          return 0;
        }
        assertedBy = 'user';
      }
    }
    const g = writeGrant(w);
    const r = remove
      ? await store.unlink!(g, a.id, b.id, { assertedBy })
      : await store.link!(g, a.id, b.id, { assertedBy });
    if (r === null) {
      // Names neither id: which of the two was refused would say something about it.
      throw new Refusal('No such pair of memories to link in this project.', {
        code: 'not-found',
      });
    }
    if ('refused' in r && r.refused !== undefined) {
      throw new Refusal(
        remove
          ? 'That link was confirmed at a terminal, so only `oort unlink` confirmed at a terminal removes it.'
          : 'That pair was unlinked at a terminal, so only `oort link` confirmed at a terminal links it again.',
        { code: 'refused' },
      );
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
