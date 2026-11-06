import * as os from 'node:os';
import * as path from 'node:path';
import { importTranscripts } from '@oortmem/claude-code';
import { uiFor } from '../ui.js';
import { Refusal, confirm, echo, tilde, when, writePath, withWired, type Ctx } from '../util.js';

export interface ImportCommandOptions {
  since?: string;
  yes?: boolean;
  estimateOnly?: boolean;
  includeUnresolved?: boolean;
  projectsDir?: string;
  /**
   * Asks before importing, given the estimate (the setup wizard's prompt);
   * by default a y/N question on the terminal, or `--yes`.
   */
  confirmWith?: (estimate: { observations: number; estimatedTokens: number }) => Promise<boolean>;
}

const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 } as const;

/** `30d`, `12h`, `2w` → the instant that long before `now`. */
export function parseSince(raw: string, now: Date): Date {
  const m = /^(\d+)([hdw])$/.exec(raw.trim());
  if (m === null) throw new Refusal(`--since ${echo(raw)} must look like 12h, 30d or 2w.`);
  return new Date(now.getTime() - Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS]);
}

/**
 * `oort import claude-code`: prints the estimate (sessions, observations,
 * writer tokens, skipped sessions) first, then asks before observing anything. Exits 3 when
 * some sessions stopped at a failed observation (the rest are imported; a re-run retries them).
 */
export async function importCommand(opts: ImportCommandOptions, ctx: Ctx): Promise<number> {
  const since = opts.since === undefined ? undefined : parseSince(opts.since, new Date());
  const home = ctx.io.env['HOME'] || os.homedir();
  const projectsDir = path.resolve(
    ctx.io.cwd,
    opts.projectsDir ?? path.join(home, '.claude', 'projects'),
  );
  return withWired(
    ctx,
    async (w) => {
      if (w.mode === 'cloud') {
        throw new Refusal(
          'Transcript import writes to the local store: run it with `oort cloud use --local`, then `oort cloud import`.',
        );
      }
      const deps = { ...w, log: w.harnessLog, home: w.agent.home };
      const base = {
        projectsDir,
        ...(since !== undefined && { since }),
        includeUnresolved: opts.includeUnresolved === true,
      };
      const est = await importTranscripts({ ...base, estimateOnly: true }, deps);
      const ui = uiFor(ctx.io);
      ctx.io.out(ui.header('import claude-code', 'estimate first, then asks'));
      const unresolvedHint =
        est.skippedUnresolved > 0 && opts.includeUnresolved !== true
          ? ' (--include-unresolved imports them as global)'
          : '';
      ctx.io.out(
        ui.kv([
          ['transcripts', tilde(projectsDir, home)],
          ...(since !== undefined
            ? [['since', when(since.toISOString(), new Date())] as [string, string]]
            : []),
          ['sessions', String(est.sessions)],
          ['observations', String(est.observations)],
          ['estimated tokens', `${est.estimatedTokens} (writer, approximate)`],
          ['skipped (unresolved)', `${est.skippedUnresolved}${unresolvedHint}`],
          ['skipped (unreadable)', String(est.skippedUnreadable)],
        ]),
      );
      if (opts.estimateOnly === true || est.observations === 0) return 0;
      writePath(w, 'oort import claude-code');
      const go =
        opts.confirmWith !== undefined
          ? await opts.confirmWith(est)
          : await confirm(
              ctx.io,
              'Proceed?',
              opts.yes === true,
              `import ${est.observations} observations`,
            );
      if (!go) {
        ctx.io.out('Nothing imported.\n');
        return 0;
      }
      const r = await importTranscripts({ ...base, estimateOnly: false }, deps);
      const outcomes = Object.entries(r.outcomes ?? {})
        .map(([k, n]) => `${k} ${n}`)
        .join(', ');
      ctx.io.out(`Imported ${r.observations} observations: ${outcomes || 'nothing new'}.\n`);
      const skippedWhy = Object.entries(r.unwritable ?? {});
      if (skippedWhy.length > 0) {
        ctx.io.out(
          `Skipped as unwritable (a retry would fail the same way): ${skippedWhy.map(([k, n]) => `${k} x${n}`).join('; ')}\n`,
        );
      }
      const failed = Object.keys(r.failedSessions ?? {}).length;
      if (failed > 0) {
        ctx.io.out(
          `${failed} session(s) stopped at a failed observation; re-run the import to retry them.\n`,
        );
        const reasons = new Set(Object.values(r.failedSessions ?? {}).map((f) => f.reason));
        ctx.io.out(`Reason: ${[...reasons].join('; ')}\n`);
        // Partial success: what was imported stays, and a re-run picks up the failed sessions.
        return 3;
      }
      return 0;
    },
    { agent: 'claude-code' },
  );
}
