import type { CloudConstellation } from '../cloud.js';
import { uiFor } from '../ui.js';
import { Refusal, type Ctx } from '../util.js';
import { clientFor } from './cloud.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

/** `oort constellation list [--json]`: the Oort Cloud Constellations you belong to. */
export async function constellationListCommand(
  opts: { json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const client = await clientFor(ctx);
  const all = await client.constellations();
  if (opts.json === true) {
    ctx.io.out(`${JSON.stringify(all, null, 2)}\n`);
    return 0;
  }
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
  const who = c.members === 1 ? '1 member' : `${c.members} members`;
  return `  ${c.name}  ${c.role}${c.owner ? ' (owner)' : ''}  ${who}  ${c.id}`;
}

/** `oort constellation create <name>`: a new Constellation, with you as its maintainer. */
export async function constellationCreateCommand(
  name: string,
  opts: { json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const n = name.trim();
  if (!NAME.test(n)) {
    throw new Refusal(
      'A Constellation name is 1 to 40 letters, digits, spaces, dots, dashes or underscores.',
    );
  }
  const client = await clientFor(ctx);
  const c = await client.createConstellation(n);
  if (opts.json === true) ctx.io.out(`${JSON.stringify(c, null, 2)}\n`);
  else
    ctx.io.out(
      `Created Constellation ${c.name} (${c.id}). Share a memory with \`oort share <id> --to ${c.name}\`.\n`,
    );
  return 0;
}
