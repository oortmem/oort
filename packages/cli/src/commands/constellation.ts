import { ANONYMOUS_AGENT, isAgentId } from '@oortmem/core';
import { OortCloudError, type CloudConstellation } from '../cloud.js';
import { emit, jsonMode } from '../output.js';
import { uiFor } from '../ui.js';
import { Refusal, clip, confirm, echo, shown, type Ctx } from '../util.js';
import { clientFor } from './cloud.js';
import { galaxyLine, resolveGalaxy } from './galaxy.js';
import { platformOpener } from './login.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

/** `oort constellation list [--json]`: the Oort Cloud Constellations you belong to. */
export async function constellationListCommand(
  opts: { json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const client = await clientFor(ctx);
  const all = await client.constellations();
  if (jsonMode(ctx)) return json(ctx, { constellations: all });
  const ui = uiFor(ctx.io);
  ctx.io.out(ui.header('constellations', `${all.length}`));
  if (all.length === 0) {
    ctx.io.out('None yet. Create one with `oort constellation create <name>`.\n');
    return 0;
  }
  for (const c of all) ctx.io.out(`${row(c)}\n`);
  return 0;
}

function row(c: CloudConstellation): string {
  const n = Number(c.members);
  const who = n === 1 ? '1 member' : `${n} members`;
  const archived =
    typeof c.archivedUntil === 'string'
      ? `  archived: read-only, deleted ${shown(c.archivedUntil.slice(0, 10))}`
      : '';
  return `  ${shown(c.name)}  ${shown(c.role)}${c.owner ? ' (owner)' : ''}  ${who}  ${shown(c.id)}${archived}`;
}

/**
 * `oort constellation create <name> [--galaxy <g>]`: a new Constellation, with you as its
 * maintainer; in a Galaxy (CON-97) when you are its admin or owner, and then every admin of the
 * Galaxy maintains it too.
 */
export async function constellationCreateCommand(
  name: string,
  opts: { json?: boolean; galaxy?: string },
  ctx: Ctx,
): Promise<number> {
  const n = name.trim();
  if (!NAME.test(n)) {
    throw new Refusal(
      'A Constellation name is 1 to 40 letters, digits, spaces, dots, dashes or underscores.',
    );
  }
  const galaxy = opts.galaxy?.trim();
  if (galaxy !== undefined && (galaxy === '' || galaxy.length > 120)) {
    throw new Refusal('--galaxy takes a Galaxy slug, name or id (see `oort galaxy list`).');
  }
  const client = await clientFor(ctx);
  // The API takes a Galaxy by id only: resolve the slug or name here first, among your own
  // Galaxies, and refuse a reference that matches more than one (CON-97).
  const target = galaxy === undefined ? undefined : resolveGalaxy(await client.galaxies(), galaxy);
  const c = await client.createConstellation(n, target?.id);
  if (jsonMode(ctx)) emit(ctx, c);
  else
    ctx.io.out(
      `Created Constellation ${shown(c.name)} (${shown(c.id)})${target === undefined ? '' : ` in ${galaxyLine(target)}`}. Share a memory with \`oort share <id> --to ${shown(c.name)}\`.\n`,
    );
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Members (CON-64). Every rule (who may invite, remove, change roles; the plan's member limit;
// the owner) is the API's: refusals arrive with its own message.

const ROLES = ['maintainer', 'member', 'reader'] as const;
type Role = (typeof ROLES)[number];
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;
const INVITE_TOKEN = /^oort_iv_[A-Za-z0-9_-]{43}$/;
export const INVITE_PAGE = 'https://oortcloud.dev/invite';

function roleArg(role: string | undefined, fallback?: Role): Role {
  const r = role ?? fallback;
  if (r === undefined || !(ROLES as readonly string[]).includes(r)) {
    throw new Refusal(`--role must be one of ${ROLES.join(', ')}.`);
  }
  return r as Role;
}

function agentArg(agent: string | undefined): string {
  if (agent === undefined || agent.trim() === '') {
    throw new Refusal('Name the agent with --agent <name> (claude-code, codex, cursor, …).');
  }
  if (!isAgentId(agent) || agent === ANONYMOUS_AGENT) {
    throw new Refusal(
      `Agent ${echo(agent)} is not an agent id: lowercase letters, digits, ".", "_" or "-".`,
    );
  }
  return agent;
}

/** Prints `v` as this run's `oort.v1` data; exit 0. */
function json(ctx: Ctx, v: object): number {
  emit(ctx, v);
  return 0;
}

/** `oort constellation invite <c> <email> [--role …]`: a single-use link, valid for 7 days. */
export async function constellationInviteCommand(
  c: string,
  email: string,
  opts: { role?: string; json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const address = email.trim();
  if (!EMAIL.test(address)) throw new Refusal('Give the email address to invite.');
  const role = roleArg(opts.role, 'member');
  const client = await clientFor(ctx);
  const inv = await client.invite(c, address, role);
  if (jsonMode(ctx)) return json(ctx, inv);
  const ui = uiFor(ctx.io);
  ctx.io.out(
    `Invited ${shown(inv.email)} to ${shown(inv.constellation)} as ${shown(inv.role)}. ${
      inv.emailed ? 'They have an email with the link;' : 'Nothing was emailed:'
    } send them this link (single use, expires ${shown(inv.expiresAt.slice(0, 10))}):\n\n  ${shown(inv.link)}\n\n` +
      (inv.note !== undefined ? `${shown(inv.note)}\n\n` : '') +
      ui.dim(
        'They accept it signed in to oortcloud.dev with that email address. Anyone with the link can see the invite, so send it only to them.',
      ) +
      '\n',
  );
  return 0;
}

/** The token in an invite link (`…/invite#oort_iv_…`) or the bare token. */
export function inviteToken(arg: string): string | null {
  const t = arg.trim();
  const fromLink = /#(oort_iv_[A-Za-z0-9_-]{43})$/.exec(t)?.[1];
  const token = fromLink ?? t;
  return INVITE_TOKEN.test(token) ? token : null;
}

/**
 * `oort constellation join <link|token>`: accepting needs the email address the invite was sent
 * to, which only your signed-in account on oortcloud.dev can prove, so this opens the invite page
 * there (or prints it, outside a terminal or with --no-browser).
 */
export async function constellationJoinCommand(
  arg: string,
  opts: { browser?: boolean },
  ctx: Ctx,
): Promise<number> {
  const token = inviteToken(arg);
  if (token === null) {
    throw new Refusal(
      'That is not an Oort invite link: it looks like https://oortcloud.dev/invite#oort_iv_….',
    );
  }
  const page = `${INVITE_PAGE}#${token}`;
  const terminal = ctx.io.stdinIsTTY && ctx.io.stdoutIsTTY === true;
  const opened =
    terminal && opts.browser !== false
      ? await (ctx.login?.openBrowser ?? platformOpener())(page)
      : false;
  ctx.io.out(
    opened
      ? 'Opened the invite in your browser. Accept it there, signed in with the invited email address.\n'
      : `Open this page in a browser and accept it, signed in with the invited email address:\n  ${page}\n`,
  );
  if (jsonMode(ctx)) emit(ctx, { url: page, opened });
  return 0;
}

/** `oort constellation invites <c>`: invites nobody has accepted yet. */
export async function constellationInvitesCommand(
  c: string,
  opts: { json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const client = await clientFor(ctx);
  const all = await client.invites(c);
  if (jsonMode(ctx)) return json(ctx, { invites: all });
  const ui = uiFor(ctx.io);
  ctx.io.out(ui.header('invites', `${all.length}`));
  if (all.length === 0) ctx.io.out('No open invites.\n');
  for (const i of all) {
    ctx.io.out(
      `  ${shown(i.id)}  ${shown(i.email)}  ${shown(i.role)}  expires ${shown(i.expiresAt.slice(0, 10))}\n`,
    );
  }
  return 0;
}

/** `oort constellation revoke <c> <invite id>` */
export async function constellationRevokeCommand(
  c: string,
  invite: string,
  ctx: Ctx,
): Promise<number> {
  const client = await clientFor(ctx);
  const r = await client.revokeInvite(c, invite.trim());
  ctx.io.out(r.revoked ? `Revoked invite ${echo(invite)}.\n` : `No open invite ${echo(invite)}.\n`);
  if (jsonMode(ctx)) emit(ctx, { constellation: c, invite: invite.trim(), revoked: r.revoked });
  return 0;
}

/** `oort constellation members <c>`: who is in it, their roles and attached agents. */
export async function constellationMembersCommand(
  c: string,
  opts: { json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const client = await clientFor(ctx);
  const all = await client.members(c);
  if (jsonMode(ctx)) return json(ctx, { members: all });
  const ui = uiFor(ctx.io);
  ctx.io.out(ui.header('members', `${all.length}`));
  for (const m of all) {
    const who = m.you ? 'you' : m.email === null ? 'a member' : shown(m.email);
    const stars =
      m.stars.length === 0
        ? ''
        : `  agents: ${m.stars.map((s) => `${shown(s.agent)} (${shown(s.rights.join('+')) || 'none'})`).join(', ')}`;
    ctx.io.out(
      `  ${shown(m.member)}  ${who}  ${shown(m.role)}${m.owner ? ' (owner)' : ''}  since ${shown(m.joinedAt.slice(0, 10))}${stars}\n`,
    );
  }
  return 0;
}

/** `oort constellation remove <c> <member|email> [--yes]`: their contributions stay. */
export async function constellationRemoveCommand(
  c: string,
  member: string,
  opts: { yes?: boolean },
  ctx: Ctx,
): Promise<number> {
  const client = await clientFor(ctx);
  const ok = await confirm(
    ctx.io,
    `Remove ${echo(member)} from ${echo(c)}? Their access ends within a minute; what they shared stays.`,
    opts.yes === true,
    'remove them',
    { json: jsonMode(ctx) },
  );
  if (!ok) {
    ctx.io.out('Nobody was removed.\n');
    return 0;
  }
  await client.removeMember(c, member.trim());
  ctx.io.out(`Removed ${echo(member)} from ${echo(c)}. Their access ends within a minute.\n`);
  if (jsonMode(ctx)) emit(ctx, { constellation: c, member: member.trim(), removed: true });
  return 0;
}

/** `oort constellation role <c> <member|email> <role>` */
export async function constellationRoleCommand(
  c: string,
  member: string,
  role: string,
  ctx: Ctx,
): Promise<number> {
  const client = await clientFor(ctx);
  const r = await client.setRole(c, member.trim(), roleArg(role));
  ctx.io.out(`${shown(r.member)} is now a ${shown(r.role)} of ${echo(c)}.\n`);
  if (jsonMode(ctx)) emit(ctx, { constellation: c, member: r.member, role: r.role });
  return 0;
}

/** `oort constellation leave <c> [--yes]`: what you shared stays, as a former member's. */
export async function constellationLeaveCommand(
  c: string,
  opts: { yes?: boolean },
  ctx: Ctx,
): Promise<number> {
  const client = await clientFor(ctx);
  const ok = await confirm(
    ctx.io,
    `Leave ${echo(c)}? You and your agents stop reading it; what you shared stays.`,
    opts.yes === true,
    'leave it',
    { json: jsonMode(ctx) },
  );
  if (!ok) {
    ctx.io.out('Still a member.\n');
    return 0;
  }
  await client.leave(c);
  ctx.io.out(`Left ${echo(c)}.\n`);
  if (jsonMode(ctx)) emit(ctx, { constellation: c, left: true });
  return 0;
}

/** `oort constellation transfer <c> <member|email> [--yes]`: the owner hands it over. */
export async function constellationTransferCommand(
  c: string,
  member: string,
  opts: { yes?: boolean },
  ctx: Ctx,
): Promise<number> {
  const client = await clientFor(ctx);
  const ok = await confirm(
    ctx.io,
    `Make ${echo(member)} the owner of ${echo(c)}? You stay a maintainer; only they can delete it then.`,
    opts.yes === true,
    'transfer it',
    { json: jsonMode(ctx) },
  );
  if (!ok) {
    ctx.io.out('Ownership unchanged.\n');
    return 0;
  }
  const r = await client.transfer(c, member.trim());
  ctx.io.out(`${shown(r.member)} now owns ${echo(c)}.\n`);
  if (jsonMode(ctx)) emit(ctx, { constellation: c, owner: r.member });
  return 0;
}

/** `oort constellation delete <c> [--yes]`: the owner deletes it and every memory in it. */
export async function constellationDeleteCommand(
  c: string,
  opts: { yes?: boolean },
  ctx: Ctx,
): Promise<number> {
  const client = await clientFor(ctx);
  const ok = await confirm(
    ctx.io,
    `Delete ${echo(c)} and every memory shared in it, for every member? This cannot be undone.`,
    opts.yes === true,
    'delete it',
    { json: jsonMode(ctx) },
  );
  if (!ok) {
    ctx.io.out('Nothing was deleted.\n');
    return 0;
  }
  const r = await client.deleteConstellation(c);
  ctx.io.out(
    `Deleted ${echo(c)} (${shown(r.memories)} ${r.memories === 1 ? 'memory' : 'memories'}). Members' own memories are untouched.\n`,
  );
  if (jsonMode(ctx)) emit(ctx, { constellation: c, deleted: true, memories: r.memories });
  return 0;
}

/**
 * `oort constellation adopt <c>`: an archived Constellation (its team's organization was deleted)
 * moves into your own account, within its 30 days. Owner only, with your own Oort Pro, within the
 * plan's Constellations; the API says why when it can't.
 */
export async function constellationAdoptCommand(
  c: string,
  opts: { json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const client = await clientFor(ctx);
  const r = await client.adoptConstellation(c.trim());
  if (jsonMode(ctx)) return json(ctx, r);
  ctx.io.out(`Adopted ${echo(c)}: it is yours now, outside any team, and no longer archived.\n`);
  return 0;
}

/** The most `--min-support` takes (the API's MIN_SUPPORT_MAX). */
export const MIN_SUPPORT_MAX = 10;

/**
 * `oort constellation policy <c> [--confirm|--open] [--supersede-trust member|maintainer]
 * [--min-support <1-10>]`: how shares are accepted, the least trust a contradiction of someone
 * else's memory needs to supersede it (below it, both are kept as contested until a maintainer
 * decides), and how many members a memory needs to survive an erasure (CON-67). Maintainers with
 * a full key only: the API refuses the rest.
 */
export async function constellationPolicyCommand(
  c: string,
  opts: { open?: boolean; confirm?: boolean; supersedeTrust?: string; minSupport?: string },
  ctx: Ctx,
): Promise<number> {
  const both = opts.open === true && opts.confirm === true;
  const policy = opts.open === true ? 'open' : opts.confirm === true ? 'confirm' : undefined;
  const trust = opts.supersedeTrust;
  if (both || (policy === undefined && trust === undefined && opts.minSupport === undefined)) {
    throw new Refusal(
      'Pick --confirm (every share is confirmed by a person) or --open, and/or --supersede-trust member|maintainer, and/or --min-support <1-10>.',
    );
  }
  if (trust !== undefined && trust !== 'member' && trust !== 'maintainer') {
    throw new Refusal('--supersede-trust must be member or maintainer.');
  }
  let minSupport: number | undefined;
  if (opts.minSupport !== undefined) {
    minSupport = /^\d{1,2}$/.test(opts.minSupport.trim()) ? Number(opts.minSupport) : NaN;
    if (!(minSupport >= 1 && minSupport <= MIN_SUPPORT_MAX)) {
      throw new Refusal(
        `--min-support must be a whole number from 1 to ${MIN_SUPPORT_MAX}: the members a memory needs to survive an erasure.`,
      );
    }
  }
  const client = await clientFor(ctx);
  const r = await client.setPolicy(c, {
    ...(policy !== undefined && { policy }),
    ...(trust !== undefined && { supersedeTrust: trust }),
    ...(minSupport !== undefined && { minSupport }),
  });
  ctx.io.out(
    `${echo(c)} now uses the ${shown(r.policy)} policy` +
      (r.supersedeTrust === undefined
        ? '.\n'
        : `; a contradiction of someone else's memory needs ${shown(r.supersedeTrust)} trust to supersede it.\n`),
  );
  if (minSupport !== undefined && typeof r.minSupport === 'number') {
    const n = r.minSupport;
    ctx.io.out(
      `When a member is erased, a shared memory they wrote stays only while at least ${n} remaining member${n === 1 ? '' : 's'} support${n === 1 ? 's' : ''} it.\n`,
    );
  }
  if (jsonMode(ctx)) emit(ctx, { constellation: c, ...r });
  return 0;
}

/**
 * `oort constellation contested <c> [--json]`: memories held against each other because a member
 * below the Constellation's supersedeTrust contradicted another's. Both are served, labelled
 * contested, until a maintainer resolves the pair.
 */
export async function constellationContestedCommand(
  c: string,
  opts: { json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const client = await clientFor(ctx);
  const all = await client.contested(c).catch((e: unknown) => {
    if (e instanceof OortCloudError && e.kind === 'not-found') {
      throw new Refusal(`No Constellation ${echo(c)} among yours.`, {
        code: 'not-found',
        fix: 'oort constellation list',
      });
    }
    throw e;
  });
  if (jsonMode(ctx)) return json(ctx, { contested: all });
  const ui = uiFor(ctx.io);
  ctx.io.out(ui.header('contested', `${all.length}`));
  if (all.length === 0) {
    ctx.io.out(`Nothing in ${echo(c)} is contested.\n`);
    return 0;
  }
  for (const x of all) {
    ctx.io.out(
      `  current     ${shown(x.current.id)}  "${shown(clip(x.current.text, 60))}"\n` +
        `  challenger  ${shown(x.challenger.id)}  "${shown(clip(x.challenger.text, 60))}"\n` +
        ui.dim(
          `              asks to ${shown(x.action)}, since ${shown(x.openedAt.slice(0, 10))}`,
        ) +
        '\n\n',
    );
  }
  ctx.io.out(
    ui.dim(
      `A maintainer keeps one: oort constellation resolve ${echo(c)} <challenger id> --keep <id>`,
    ) + '\n',
  );
  return 0;
}

const ENDED: Record<string, string> = {
  SUPERSEDE: 'superseded (kept in its history)',
  CORRECT: 'marked as corrected (kept in its history)',
  RETRACT: 'retracted (kept in its history)',
};

/** `oort constellation resolve <c> <id> --keep <id>`: a maintainer settles a contest. */
export async function constellationResolveCommand(
  c: string,
  id: string,
  opts: { keep?: string; json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const keep = opts.keep?.trim();
  if (keep === undefined || keep === '') {
    throw new Refusal(
      'Name the memory that stays with --keep <id> (from `oort constellation contested`).',
    );
  }
  const client = await clientFor(ctx);
  const r = await client.resolve(c, id.trim(), keep).catch((e: unknown) => {
    if (e instanceof OortCloudError && e.kind === 'not-found') {
      throw new Refusal(
        `No open contest in ${echo(c)} holds ${echo(id.trim())} and ${echo(keep)}. See \`oort constellation contested ${echo(c)}\`.`,
        { code: 'not-found' },
      );
    }
    throw e;
  });
  if (jsonMode(ctx)) return json(ctx, r);
  ctx.io.out(
    `Kept ${shown(r.kept)} in ${echo(c)}; ${shown(r.ended)} is ${
      Object.hasOwn(ENDED, r.action) ? ENDED[r.action] : shown(String(r.action).toLowerCase())
    }.\n`,
  );
  return 0;
}

/**
 * `oort constellation attach <c> --agent <name> [--share]`: lets one of your agents read the
 * Constellation (and with --share, share into it). It never gets more than your own role allows.
 */
export async function constellationAttachCommand(
  c: string,
  opts: { agent?: string; share?: boolean; json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const agent = agentArg(opts.agent);
  const client = await clientFor(ctx);
  const r = await client.attach(c, agent, opts.share === true);
  if (jsonMode(ctx)) return json(ctx, r);
  const capped = r.asked.filter((x) => !r.rights.includes(x));
  ctx.io.out(
    `${shown(r.agent)} can now ${r.rights.includes('share') ? 'read and share into' : 'read'} ${echo(c)}.` +
      (capped.length > 0
        ? ` It asked to ${shown(capped.join(', '))}, which your role does not allow.`
        : '') +
      '\n',
  );
  return 0;
}

/** `oort constellation detach <c> --agent <name>` */
export async function constellationDetachCommand(
  c: string,
  opts: { agent?: string },
  ctx: Ctx,
): Promise<number> {
  const agent = agentArg(opts.agent);
  const client = await clientFor(ctx);
  const r = await client.detach(c, agent);
  ctx.io.out(
    r.detached
      ? `${agent} no longer reads ${echo(c)}.\n`
      : `${agent} was not attached to ${echo(c)}.\n`,
  );
  if (jsonMode(ctx)) emit(ctx, { constellation: c, agent, detached: r.detached });
  return 0;
}
