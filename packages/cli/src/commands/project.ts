import {
  CONFIGURED_ID_PREFIX,
  configuredProjectId,
  linkProject,
  projectRootFor,
  readProjectLinks,
  resolveHome,
  unlinkProject,
} from '@oortmem/core';
import { Refusal, echo, type Ctx } from '../util.js';

function rootOrRefuse(ctx: Ctx, action: string): string {
  const root = projectRootFor(ctx.io.cwd);
  if (root === undefined) {
    throw new Refusal(`project ${action} needs a git repository; none found above the cwd.`);
  }
  return root;
}

/**
 * `oort project link [--id <id>]`: trusts a project id for this repository by
 * binding its main root (shared by every worktree) to `--id`, or to the
 * `project.id` in `oort.config.json`. The binding lives in
 * `$OORT_HOME/project-links.json` (0600); without it a repository file's
 * `project.id` is ignored, since a cloned repository could name another
 * project's scope. For the same reason a repository-supplied id already bound
 * to another root is refused; an explicit `--id` is the user's own choice.
 */
export async function projectLinkCommand(opts: { id?: string }, ctx: Ctx): Promise<number> {
  const root = rootOrRefuse(ctx, 'link');
  let id = opts.id;
  if (id === undefined) {
    try {
      id = configuredProjectId(ctx.io.cwd);
    } catch (e) {
      throw new Refusal((e as Error).message);
    }
  }
  if (id === undefined || id === '') {
    throw new Refusal('no project.id in oort.config.json; pass --id <id>.');
  }
  const home = resolveHome(ctx.io.env);
  if (opts.id === undefined) {
    // The id came from the repository: it must not join another repository's scope unasked.
    const other = Object.entries(readProjectLinks(home)).find(([r, v]) => v === id && r !== root);
    if (other !== undefined) {
      throw new Refusal(
        `project.id ${echo(id)} from oort.config.json is already linked to ${other[0]}. ` +
          `To share that project's memories here, pass --id ${echo(id)} explicitly.`,
      );
    }
  }
  try {
    linkProject(home, root, id);
  } catch (e) {
    if (e instanceof RangeError) throw new Refusal(`--id ${echo(id)}: ${e.message}.`);
    throw e;
  }
  ctx.io.out(`Linked ${root} to project ${echo(`${CONFIGURED_ID_PREFIX}${id}`)}\n`);
  return 0;
}

/** `oort project unlink`: removes this repository's trust binding (back to the derived id). */
export async function projectUnlinkCommand(ctx: Ctx): Promise<number> {
  const root = rootOrRefuse(ctx, 'unlink');
  const removed = unlinkProject(resolveHome(ctx.io.env), root);
  ctx.io.out(removed ? `Unlinked ${root}\n` : `No link for ${root}\n`);
  return 0;
}
