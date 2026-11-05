import { VERSION } from '@oortmem/core';
import type { CloudSpace } from '../cloud.js';
import { uiFor } from '../ui.js';
import { cloudOf, safeJson, shown, withWired, type Ctx } from '../util.js';

/** How a space reads in a list: `Constellation oort-core (member: read, share)`. */
export function spaceLine(s: CloudSpace): string {
  return s.level === 'planet'
    ? 'your Planet'
    : `Constellation ${shown(s.name)} (${shown(s.role)}: ${shown(s.rights.join(', ')) || 'no rights'})`;
}

/**
 * `oort whoami [--json]`: which store this runs against, as which agent, and the spaces it
 * reaches with your role in each (CON-64). In cloud mode the API answers for this key and agent.
 */
export async function whoamiCommand(opts: { json?: boolean }, ctx: Ctx): Promise<number> {
  return withWired(ctx, async (w) => {
    const agent = w.agent.source === 'none' ? null : w.agent.id;
    const cloud = cloudOf(w);
    let out: Record<string, unknown>;
    if (cloud === undefined) {
      out = {
        mode: 'local',
        account: null,
        agent,
        spaces: [{ level: 'planet' }, ...(agent === null ? [] : [{ level: 'star', agent }])],
        version: VERSION,
      };
    } else {
      const me = await cloud.whoami(agent ?? undefined);
      out = {
        mode: 'cloud',
        account: me.account,
        plan: me.plan,
        key: me.scope ?? 'full',
        agent,
        spaces: me.spaces ?? [{ level: 'planet' }],
        version: VERSION,
      };
    }
    if (opts.json === true) {
      ctx.io.out(`${safeJson(out)}\n`);
      return 0;
    }
    const ui = uiFor(ctx.io);
    const spaces = (out['spaces'] as (CloudSpace | { level: 'star'; agent: string })[]).map((s) =>
      s.level === 'star' ? `Star ${s.agent} (this agent's own)` : spaceLine(s),
    );
    ctx.io.out(ui.header('whoami', out['mode'] === 'cloud' ? 'Oort Cloud' : 'local store'));
    ctx.io.out(
      ui.kv([
        [
          'account',
          out['mode'] === 'cloud'
            ? `${shown(out['account'])} (${shown(out['plan'])})`
            : 'none (local store)',
        ],
        ...(out['mode'] === 'cloud'
          ? [
              [
                'key',
                out['key'] === 'narrowed'
                  ? 'narrowed to the spaces below'
                  : 'everything this account may do',
              ] as [string, string],
            ]
          : []),
        ['agent', agent ?? 'none named (reads every space below)'],
        ...spaces.map((line, i) => [i === 0 ? 'spaces' : '', line] as [string, string]),
      ]),
    );
    return 0;
  });
}
