import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ExportFormatError,
  addressOf,
  nodeGrant,
  parseExport,
  planetNode,
  type Memory,
} from '@oortmem/core';
import { importTranscripts } from '@oortmem/claude-code';
import { emit, jsonMode } from '../output.js';
import { uiFor } from '../ui.js';
import {
  Refusal,
  adapterProblem,
  confirm,
  echo,
  tilde,
  warn,
  when,
  writePath,
  withWired,
  type Ctx,
} from '../util.js';

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
  /** What happened, for the setup wizard's summary (the exit code alone cannot tell a decline). */
  onOutcome?: (outcome: ImportOutcome) => void;
}

/**
 * `nothing`: no observations to import (or `--estimate-only`); `declined`: the person said no;
 * `imported`: every session; `partial`: some sessions stopped at a failed observation (exit 3).
 */
export type ImportOutcome = 'nothing' | 'declined' | 'imported' | 'partial';

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
          { code: 'refused' },
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
      const estimate = {
        projectsDir,
        since: since?.toISOString() ?? null,
        sessions: est.sessions,
        observations: est.observations,
        estimatedTokens: est.estimatedTokens,
        skippedUnresolved: est.skippedUnresolved,
        skippedUnreadable: est.skippedUnreadable,
      };
      const json = jsonMode(ctx);
      if (opts.estimateOnly === true || est.observations === 0) {
        opts.onOutcome?.('nothing');
        if (json) emit(ctx, { outcome: 'nothing', estimate, imported: null });
        return 0;
      }
      writePath(w, 'oort import claude-code');
      const go =
        opts.confirmWith !== undefined
          ? await opts.confirmWith(est)
          : await confirm(
              ctx.io,
              'Proceed?',
              opts.yes === true,
              `import ${est.observations} observations`,
              { json: jsonMode(ctx) },
            );
      if (!go) {
        ctx.io.out('Nothing imported.\n');
        opts.onOutcome?.('declined');
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
      const imported = {
        observations: r.observations,
        outcomes: r.outcomes ?? {},
        unwritable: r.unwritable ?? {},
        failedSessions: Object.entries(r.failedSessions ?? {}).map(([session, f]) => ({
          session,
          failed: f.failed,
          notAttempted: f.notAttempted,
          reason: f.reason,
        })),
      };
      if (failed > 0) {
        const reasons = new Set(Object.values(r.failedSessions ?? {}).map((f) => f.reason));
        if (json) {
          warn(
            ctx,
            'partial',
            `${failed} session(s) stopped at a failed observation; re-run the import to retry them. Reason: ${[...reasons].join('; ')}`,
          );
        } else {
          ctx.io.out(
            `${failed} session(s) stopped at a failed observation; re-run the import to retry them.\n`,
          );
          ctx.io.out(`Reason: ${[...reasons].join('; ')}\n`);
        }
        // Partial success: what was imported stays, and a re-run picks up the failed sessions.
        opts.onOutcome?.('partial');
        if (json) emit(ctx, { outcome: 'partial', estimate, imported });
        return 3;
      }
      opts.onOutcome?.('imported');
      if (json) emit(ctx, { outcome: 'imported', estimate, imported });
      return 0;
    },
    { agent: 'claude-code' },
  );
}

export interface ImportFileOptions {
  yes?: boolean;
}

/** How many memories one embedding request carries. */
const EMBED_BATCH = 64;

/**
 * `oort import <file>`: an Oort export (docs/export-format.md, version 1 or 2: `oort export`,
 * `oort cloud export`, or one end user's export from Oort Cloud, CON-137) into this machine's
 * store. Every Planet memory moves to this machine's Planet, everything else about it kept: its
 * project, author, type, text, validity and history, pin and tier. Memories at other levels (a
 * Star, a Constellation) are left out and counted. An id already here is skipped, so running it
 * again is safe. Each memory is embedded again with the store's embedder, since the file's
 * vectors may come from another model. Asks first (`--yes` skips the question).
 */
export async function importFileCommand(
  file: string,
  opts: ImportFileOptions,
  ctx: Ctx,
): Promise<number> {
  const full = path.resolve(ctx.io.cwd, file);
  let text: string;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'unreadable';
    throw new Refusal(`Cannot read ${echo(file)} (${code}).`, { fix: 'oort import <file.jsonl>' });
  }
  return withWired(ctx, async (w) => {
    if (w.mode === 'cloud') {
      throw new Refusal(
        'oort import <file> writes to the local store: run `oort cloud use --local` first (`oort cloud import` then uploads it).',
        { code: 'refused', fix: 'oort cloud use --local' },
      );
    }
    const { orgId, customerId, agentId } = w.scope;
    let memories: Memory[];
    try {
      memories = parseExport(text, { planet: { orgId, customerId } }).memories;
    } catch (e) {
      if (e instanceof ExportFormatError) {
        throw new Refusal(`${echo(file)} is not an Oort export: ${e.message}.`);
      }
      throw e;
    }
    const planet = { node: planetNode({ orgId, customerId }), projectIds: 'all' as const };
    const grant = nodeGrant({
      principal: { orgId, customerId, agentId },
      read: [planet],
      write: [planet],
    });
    const outside = memories.filter((m) => addressOf(m).level !== 'user').length;
    const fresh: Memory[] = [];
    let already = 0;
    for (const m of memories) {
      if (addressOf(m).level !== 'user') continue;
      if ((await w.store.get(grant, m.id)) !== null) already++;
      else fresh.push(m);
    }
    const json = jsonMode(ctx);
    const ui = uiFor(ctx.io);
    const shown = tilde(full, ctx.io.env['HOME'] || os.homedir());
    ctx.io.out(ui.header('import', 'an Oort export into this machine'));
    ctx.io.out(
      ui.kv([
        ['file', shown],
        ['memories', String(memories.length)],
        ['already here', String(already)],
        ['outside a Planet', `${outside}${outside > 0 ? ' (left out)' : ''}`],
      ]),
    );
    const result = (imported: number) => ({
      file: full,
      memories: memories.length,
      imported,
      skipped: already,
      outside,
    });
    if (fresh.length === 0) {
      ctx.io.out('Nothing to import.\n');
      if (json) emit(ctx, { outcome: 'nothing', ...result(0) });
      return 0;
    }
    const embed = w.embed;
    if (embed === undefined) {
      const why =
        adapterProblem(w.unavailable.embed, 'embed', w.keyStore !== false) ??
        'No embedder is configured.';
      throw new Refusal(`Importing embeds each memory with this store's embedder. ${why}`);
    }
    const go = await confirm(
      ctx.io,
      `Import ${fresh.length} memories (each embedded again by this store's embedder)?`,
      opts.yes === true,
      `import ${fresh.length} memories`,
      { json },
    );
    if (!go) {
      ctx.io.out('Nothing imported.\n');
      return 0;
    }
    // Written warm with a fresh vector; a cold memory is then moved to cold again, so the store
    // holds it as it held it before (stub indexed, the full text in its cold copy).
    const ready: Memory[] = [];
    for (let i = 0; i < fresh.length; i += EMBED_BATCH) {
      const batch = fresh.slice(i, i + EMBED_BATCH);
      const vectors = await embed.embed(
        batch.map((m) => m.text),
        'document',
      );
      batch.forEach((m, k) => {
        const { embedding: _old, ...rest } = m;
        const v = vectors[k];
        ready.push({
          ...rest,
          tier: m.tier === 'cold' ? 'warm' : m.tier,
          ...(v !== undefined && { embedding: v }),
        } as Memory);
      });
    }
    await w.store.upsertMany(grant, ready);
    const cold: Memory[] = [];
    for (const m of fresh) {
      if (m.tier !== 'cold') continue;
      const stored = await w.store.get(grant, m.id);
      if (stored !== null) cold.push(stored);
    }
    if (cold.length > 0) await w.store.coldPutMany(grant, cold);
    ctx.io.out(
      `Imported ${ready.length} memories from ${shown}${already > 0 ? ` (${already} already here)` : ''}.\n`,
    );
    if (json) emit(ctx, { outcome: 'imported', ...result(ready.length) });
    return 0;
  });
}
