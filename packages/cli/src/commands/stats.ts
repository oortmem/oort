import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  consolidationDue,
  filterFor,
  queueDir,
  readConsolidationState,
} from '@oortmem/claude-code';
import { isCurrent, type Tier, localGrant } from '@oortmem/core';
import { uiFor } from '../ui.js';
import { emit, jsonMode } from '../output.js';
import { cloudOf, scopeLabel, tilde, when, withWired, type Ctx } from '../util.js';

export interface Stats {
  scope: { projectId: string | null };
  tiers: Record<Tier, number>;
  validity: { current: number; superseded: number; expired: number; notYetValid: number };
  sqliteBytes: number;
  coldBytes: number;
  queue: { pending: number; deadLetters: number };
  /** The hooks' automatic consolidation (CON-48); `oort consolidate` counts too. */
  consolidation: {
    lastRunAt: string | null;
    lastCompleteAt: string | null;
    lastOutcome: 'complete' | 'partial' | 'error' | null;
    due: boolean;
    nextAt: string | null;
  };
  rssBytes: number;
}

const size = (file: string): number => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

function dirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else if (e.isFile()) total += size(p);
  }
  return total;
}

/** Non-empty lines across the `*.jsonl` files directly in `dir`. */
function jsonlLines(dir: string): number {
  let n = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.jsonl')) continue;
    try {
      for (const l of fs.readFileSync(path.join(dir, name), 'utf8').split('\n'))
        if (l.length > 0) n++;
    } catch {
      // Removed by a concurrent drain.
    }
  }
  return n;
}

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

/** `oort stats [--json]`: counts for the memories visible from the cwd, and on-disk sizes. */
export async function statsCommand(opts: { json?: boolean }, ctx: Ctx): Promise<number> {
  return withWired(ctx, async (w) => {
    const cloud = cloudOf(w);
    if (cloud !== undefined) {
      const c = await cloud.stats();
      const queue = queueDir(w.config.home);
      const out = {
        store: 'cloud' as const,
        url: cloud.url,
        ...c,
        queue: { pending: jsonlLines(queue), deadLetters: jsonlLines(path.join(queue, 'dead')) },
      };
      if (jsonMode(ctx)) {
        emit(ctx, out);
        return 0;
      }
      const ui = uiFor(ctx.io);
      const now = new Date();
      const t = (tier: Tier): string => `${ui.tierName(tier)} ${c.tiers[tier]}`;
      ctx.io.out(ui.header('stats', 'Oort Cloud'));
      ctx.io.out(
        ui.kv([
          ['store', `Oort Cloud (${cloud.url})`],
          ['memories', String(c.memories)],
          ['tiers', `${t('hot')}, ${t('warm')}, ${t('cold')}`],
          ['database', mb(c.databaseBytes)],
          [
            'consolidated',
            c.lastConsolidatedAt === null ? 'not yet' : when(c.lastConsolidatedAt, now),
          ],
          [
            'queue',
            `${out.queue.pending} pending upload, ${out.queue.deadLetters} dead-lettered (this machine)`,
          ],
        ]),
      );
      return 0;
    }
    const now = new Date();
    const all = await w.store.list(localGrant(filterFor(w.scope)), { validOnly: false });
    const tiers: Record<Tier, number> = { hot: 0, warm: 0, cold: 0 };
    const validity = { current: 0, superseded: 0, expired: 0, notYetValid: 0 };
    for (const m of all) {
      tiers[m.tier]++;
      if (isCurrent(m, now)) validity.current++;
      else if (m.endReason === 'superseded') validity.superseded++;
      else if (
        m.expiredAt !== null ||
        (m.validTo !== null && Date.parse(m.validTo) <= now.getTime())
      )
        validity.expired++;
      else validity.notYetValid++;
    }
    const home = w.config.home;
    const db = path.join(home, 'oort.sqlite');
    const queue = queueDir(home);
    const cs = readConsolidationState(home);
    const due = consolidationDue(cs, now);
    const stats: Stats = {
      scope: { projectId: w.scope.projectId ?? null },
      tiers,
      validity,
      sqliteBytes: size(db) + size(`${db}-wal`),
      coldBytes: dirBytes(path.join(home, 'cold')),
      queue: { pending: jsonlLines(queue), deadLetters: jsonlLines(path.join(queue, 'dead')) },
      consolidation: {
        lastRunAt: cs.lastRunAt,
        lastCompleteAt: cs.lastCompleteAt,
        lastOutcome: cs.lastOutcome,
        due: due.due,
        nextAt: due.nextAt,
      },
      rssBytes: process.memoryUsage().rss,
    };
    if (jsonMode(ctx)) {
      emit(ctx, stats);
      return 0;
    }
    const v = stats.validity;
    const ui = uiFor(ctx.io);
    const t = (tier: Tier): string => `${ui.tierName(tier)} ${tiers[tier]}`;
    ctx.io.out(ui.header('stats', scopeLabel(w)));
    ctx.io.out(
      ui.kv([
        ['scope', `${stats.scope.projectId ?? 'global'} (+ global memories)`],
        ['tiers', `${t('hot')}, ${t('warm')}, ${t('cold')}`],
        [
          'validity',
          `current ${v.current}, superseded ${v.superseded}, expired ${v.expired}` +
            (v.notYetValid > 0 ? `, not yet valid ${v.notYetValid}` : ''),
        ],
        [
          'sqlite',
          `${mb(stats.sqliteBytes)} ${ui.dim(`(${tilde(db, ctx.io.env['HOME'] ?? '')}, including -wal)`)}`,
        ],
        ['cold', mb(stats.coldBytes)],
        ['queue', `${stats.queue.pending} pending, ${stats.queue.deadLetters} dead-lettered`],
        [
          'consolidated',
          (cs.lastCompleteAt === null ? 'not yet' : when(cs.lastCompleteAt, now)) +
            (cs.lastOutcome === 'partial' ? ' (a later run stopped at its budget)' : '') +
            (cs.lastOutcome === 'error' ? ' (the last run failed)' : '') +
            ui.dim(
              due.due
                ? ' · due on the next drain'
                : ` · next ${due.nextAt === null ? '' : when(due.nextAt, now)}`,
            ),
        ],
        ['rss', mb(stats.rssBytes)],
      ]),
    );
    return 0;
  });
}
