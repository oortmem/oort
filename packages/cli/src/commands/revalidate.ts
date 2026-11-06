import { filterFor } from '@oortmem/claude-code';
import { isStale, lastConfirmed, localGrant, type Memory } from '@oortmem/core';
import { uiFor } from '../ui.js';
import { age, clip, cloudOf, safeJson, scopeLabel, short, withWired, type Ctx } from '../util.js';

/** Pages of 100 read from the cloud API; the local store is read whole. */
const CLOUD_PAGES = 20;

/**
 * `oort revalidate [--json]` (CON-34): the current volatile facts (a status, a current version,
 * an owner) that nobody confirmed within `recall.staleAfterDays`, oldest confirmation first.
 * Recall marks these "may be outdated"; confirming one in a session (a REINFORCE) clears it.
 */
export async function revalidateCommand(opts: { json?: boolean }, ctx: Ctx): Promise<number> {
  return withWired(ctx, async (w) => {
    const now = new Date();
    const days = w.config.recall.staleAfterDays;
    const cloud = cloudOf(w);
    let current: Omit<Memory, 'embedding'>[] = [];
    if (cloud !== undefined) {
      let cursor: string | undefined;
      for (let page = 0; page < CLOUD_PAGES; page++) {
        const r = await cloud.list({
          ...(w.scope.projectId !== undefined && { project: w.scope.projectId }),
          limit: 100,
          ...(cursor !== undefined && { cursor }),
        });
        current.push(...r.memories);
        if (r.next === undefined) break;
        cursor = r.next;
      }
    } else {
      current = await w.store.list(localGrant(filterFor(w.scope)));
    }
    // A cloud copy without decisions cannot be judged, so it is left out rather than guessed.
    const stale = current
      .filter((m) => Array.isArray(m.source?.decisions) && isStale(m, now, days))
      .sort((a, b) => Date.parse(lastConfirmed(a)) - Date.parse(lastConfirmed(b)));
    if (opts.json === true) {
      const rows = stale.map((m) => ({
        id: m.id,
        type: m.type,
        text: m.text,
        lastConfirmed: lastConfirmed(m),
      }));
      ctx.io.out(`${safeJson(rows)}\n`);
      return 0;
    }
    const ui = uiFor(ctx.io);
    const n = stale.length;
    ctx.io.out(
      ui.header(
        'revalidate',
        `${n} volatile ${n === 1 ? 'fact' : 'facts'} not confirmed in ${days} days`,
        scopeLabel(w),
      ),
    );
    if (n === 0) return 0;
    ctx.io.out(
      ui.table(
        ['id', 'type', 'confirmed', 'text'],
        stale.map((m) => [
          short(m.id),
          m.type,
          `${age(lastConfirmed(m), now)} ago`,
          clip(m.text, 80),
        ]),
      ),
    );
    ctx.io.out(
      'Confirm one in a session to refresh it, or `oort forget <id>` one that no longer holds.\n',
    );
    return 0;
  });
}
