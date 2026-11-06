import {
  CONFIGURED_ID_PREFIX,
  configuredProjectId,
  linkProject,
  projectRootFor,
  readProjectLinks,
  resolveHome,
  unlinkProject,
} from '@oortmem/core';
import { Refusal, cloudOf, confirm, echo, withWired, type Ctx } from '../util.js';

function rootOrRefuse(ctx: Ctx, action: string): string {
  const root = projectRootFor(ctx.io.cwd);
  if (root === undefined) {
    throw new Refusal(
      `\`oort project ${action}\` needs a git repository; none found above the cwd.`,
    );
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
    throw new Refusal('No project.id in oort.config.json; pass --id <id>.');
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

/**
 * `oort project privacy public|private [--yes]` (Oort Cloud): the owner's explicit choice for
 * this repository's project. Oort Cloud keeps a project it was told is private private, whatever
 * a later client says; this is the only way to make its memories shareable again. `public` asks
 * first (a non-terminal needs --yes); `private` is always allowed.
 */
export async function projectPrivacyCommand(
  state: string,
  opts: { yes?: boolean },
  ctx: Ctx,
): Promise<number> {
  if (state !== 'public' && state !== 'private') {
    throw new Refusal('Project privacy takes public or private.');
  }
  return withWired(ctx, async (w) => {
    const cloud = cloudOf(w);
    if (cloud === undefined) {
      throw new Refusal(
        'Project privacy is kept in Oort Cloud: run this on a machine that uses it.',
      );
    }
    const project = w.scope.projectId;
    if (project === undefined) {
      throw new Refusal('Project privacy needs a git repository; none found above the cwd.');
    }
    if (state === 'public') {
      const ok = await confirm(
        ctx.io,
        `Mark project ${echo(project)} as not private in Oort Cloud? Its memories can then be shared to Constellations.`,
        opts.yes === true,
        'mark it public',
      );
      if (!ok) {
        ctx.io.out('Unchanged.\n');
        return 0;
      }
    }
    await cloud.setProjectPrivacy(project, state === 'private');
    ctx.io.out(
      state === 'private'
        ? `Project ${project} is private: its memories never leave it.\n`
        : `Project ${project} is not private: its memories can be shared with \`oort share\`.\n`,
    );
    return 0;
  });
}

/**
 * `oort project link|unlink --constellation <c>` (Oort Cloud, maintainers only): binds this
 * repository's project to a Constellation, so the Constellation knows which projects it serves.
 * The API refuses anyone but a maintainer.
 */
export async function projectConstellationCommand(
  c: string,
  bind: boolean,
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    const cloud = cloudOf(w);
    if (cloud === undefined) {
      throw new Refusal('Constellations live in Oort Cloud: run this on a machine that uses it.');
    }
    const project = w.scope.projectId;
    if (project === undefined) {
      throw new Refusal('This needs a git repository with a project; none found above the cwd.');
    }
    const r = bind ? await cloud.bindProject(c, project) : await cloud.unbindProject(c, project);
    ctx.io.out(
      r.bound
        ? `Bound project ${echo(r.project)} to Constellation ${echo(c)}.\n`
        : `Project ${echo(r.project)} is no longer bound to Constellation ${echo(c)}.\n`,
    );
    return 0;
  });
}
