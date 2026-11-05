import { OortCloudError, type CloudGalaxy, type CloudGalaxyRole } from '../cloud.js';
import { uiFor } from '../ui.js';
import { Refusal, safeJson, shown, type Ctx } from '../util.js';
import { clientFor } from './cloud.js';
import { platformOpener } from './login.js';

/**
 * Galaxies (CON-97): your team on Oort Cloud. A Galaxy is created and its people invited on
 * oortcloud.dev, signed in; the API answers who is in it and with which role. Every rule is the
 * API's, and every string it sends is printed through `shown()`.
 */

export const GALAXY_PAGE = 'https://oortcloud.dev/dashboard/galaxies';

const ROLE: Record<CloudGalaxyRole, string> = { owner: 'owner', admin: 'admin', member: 'member' };
const roleOf = (r: unknown): string =>
  typeof r === 'string' && Object.hasOwn(ROLE, r) ? ROLE[r as CloudGalaxyRole] : shown(r);

/** How a Galaxy reads in a list: `Acme (acme) admin`. */
export function galaxyLine(g: Pick<CloudGalaxy, 'name' | 'slug' | 'id' | 'role'>): string {
  return `Galaxy ${shown(g.name)} (${shown(g.slug ?? g.id)}, ${roleOf(g.role)})`;
}

/**
 * One of your Galaxies by id, slug or name (case-insensitive). Every match is collected first, so
 * a reference that is one Galaxy's slug and another's name is refused with both ids, never
 * resolved to the first.
 */
export function resolveGalaxy(all: CloudGalaxy[], ref: string): CloudGalaxy {
  const low = ref.toLowerCase();
  // Whatever the server sent, only strings can match (a missing or odd name never throws).
  const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
  const matches = all.filter(
    (g) => str(g.id) === ref || str(g.slug) === low || (str(g.name) ?? '').toLowerCase() === low,
  );
  if (matches.length > 1) {
    throw new Refusal(
      `Several of your Galaxies match that: ${matches.map((g) => `${galaxyLine(g)} ${shown(g.id)}`).join(', ')}. Use its id.`,
    );
  }
  const found = matches[0];
  if (found === undefined) {
    throw new Refusal('No such Galaxy among yours. See `oort galaxy list`.');
  }
  return found;
}

/** `oort galaxy list [--json]`: your Galaxies and your role in each. */
export async function galaxyListCommand(opts: { json?: boolean }, ctx: Ctx): Promise<number> {
  const client = await clientFor(ctx);
  const all = await client.galaxies();
  if (opts.json === true) {
    ctx.io.out(`${safeJson(all)}\n`);
    return 0;
  }
  const ui = uiFor(ctx.io);
  ctx.io.out(ui.header('galaxies', `${all.length}`));
  if (all.length === 0) {
    ctx.io.out(`None yet. Create one with \`oort galaxy create <name>\`, or at ${GALAXY_PAGE}.\n`);
    return 0;
  }
  for (const g of all) {
    // Counts are printed as numbers, never as whatever the server sent.
    const n = Number(g.members);
    const k = Number(g.constellations);
    const people = n === 1 ? '1 person' : `${n} people`;
    const cs = k === 1 ? '1 Constellation' : `${k} Constellations`;
    ctx.io.out(
      `  ${shown(g.name)}  ${roleOf(g.role)}  ${people}  ${cs}  ${shown(g.slug ?? g.id)}\n`,
    );
  }
  return 0;
}

/** `oort galaxy members <g> [--json]`: who is in a Galaxy, and their roles. */
export async function galaxyMembersCommand(
  galaxy: string,
  opts: { json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const ref = galaxy.trim();
  if (ref === '') throw new Refusal('Name the Galaxy: its slug, name or id.');
  const client = await clientFor(ctx);
  let r: Awaited<ReturnType<typeof client.galaxyMembers>>;
  try {
    r = await client.galaxyMembers(ref);
  } catch (e) {
    // The API's 404 for a Galaxy you are not in (or that does not exist).
    if (e instanceof OortCloudError && e.kind === 'not-found') {
      throw new Refusal('No such Galaxy among yours. See `oort galaxy list`.');
    }
    throw e;
  }
  if (opts.json === true) {
    ctx.io.out(`${safeJson(r)}\n`);
    return 0;
  }
  const ui = uiFor(ctx.io);
  ctx.io.out(ui.header('members', `${shown(r.galaxy.name)} · ${r.members.length}`));
  for (const m of r.members) {
    const who = m.you ? 'you' : shown(m.email ?? 'a member');
    // Added in Clerk, not yet joined: listed to admins only, and granted nothing.
    const pending = m.pending === true ? '  (pending: not joined yet)' : '';
    ctx.io.out(
      `  ${shown(m.member)}  ${roleOf(m.role)}  ${who}  joined ${shown(String(m.joinedAt).slice(0, 10))}${pending}\n`,
    );
  }
  ctx.io.out(
    ui.dim(
      `Invite people and change roles at ${GALAXY_PAGE}, signed in. People join there too: being added grants nothing until they do.`,
    ) + '\n',
  );
  return 0;
}

/**
 * `oort galaxy create <name>`: a Galaxy is a team account on oortcloud.dev, created there signed
 * in, so this opens that page (or prints it, outside a terminal or with --no-browser).
 */
export async function galaxyCreateCommand(
  name: string,
  opts: { browser?: boolean },
  ctx: Ctx,
): Promise<number> {
  const n = name.trim();
  if (n === '' || n.length > 64) throw new Refusal('Give the Galaxy a name of 1 to 64 characters.');
  const page = `${GALAXY_PAGE}?name=${encodeURIComponent(n)}`;
  const terminal = ctx.io.stdinIsTTY && ctx.io.stdoutIsTTY === true;
  const opened =
    terminal && opts.browser !== false
      ? await (ctx.login?.openBrowser ?? platformOpener())(page)
      : false;
  ctx.io.out(
    opened
      ? 'Opened oortcloud.dev in your browser: create the Galaxy and invite people there, signed in.\n'
      : `Create the Galaxy on oortcloud.dev, signed in:\n  ${page}\n`,
  );
  ctx.io.out(
    'Then `oort galaxy list` shows it, and `oort constellation create <name> --galaxy <slug>` adds a Constellation to it.\n',
  );
  return 0;
}
