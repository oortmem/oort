import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ExportFormatError,
  addressOf,
  nodeGrant,
  normaliseJudgment,
  packInput,
  parseExport,
  planetNode,
  type Judgment,
  type JudgmentPackOrigin,
  type Memory,
} from '@oortmem/core';
import { importTranscripts } from '@oortmem/claude-code';
import { importProgressFor } from '../import-progress.js';
import { LOCAL_PROVIDER } from '../local-models.js';
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
  /**
   * Stops the import between observations. Default: the first Ctrl-C (SIGINT) while observing,
   * and a second one quits at once, as without this.
   */
  signal?: AbortSignal;
  /** The progress line's clock (tests pass a fake one). */
  clock?: () => number;
}

/**
 * `nothing`: no observations to import (or `--estimate-only`); `declined`: the person said no;
 * `imported`: every session; `partial`: some sessions stopped at a failed observation (exit 3);
 * `interrupted`: Ctrl-C stopped it between observations (exit 130; a re-run imports the rest).
 */
export type ImportOutcome = 'nothing' | 'declined' | 'imported' | 'partial' | 'interrupted';

/** The exit code of an import Ctrl-C stopped: 128 + SIGINT, as a shell reports it. */
export const INTERRUPTED_EXIT = 130;

/**
 * The signal that stops an import: `given`, or one the first Ctrl-C aborts (with a line saying
 * so); a second Ctrl-C removes the handler and re-raises SIGINT, so it quits at once as before.
 */
function interruptOnSigint(
  given: AbortSignal | undefined,
  before: () => void,
  say: (text: string) => void,
): { signal: AbortSignal; release: () => void } {
  if (given !== undefined) return { signal: given, release: () => {} };
  const stop = new AbortController();
  const onSigint = (): void => {
    before();
    if (!stop.signal.aborted) {
      say('Stopping after the observation in progress (Ctrl-C again quits now) …\n');
      stop.abort();
      return;
    }
    process.off('SIGINT', onSigint);
    process.kill(process.pid, 'SIGINT');
  };
  process.on('SIGINT', onSigint);
  return { signal: stop.signal, release: () => void process.off('SIGINT', onSigint) };
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
          { code: 'refused' },
        );
      }
      const deps = { ...w, log: w.harnessLog, home: w.agent.home };
      const base = {
        projectsDir,
        ...(since !== undefined && { since }),
        includeUnresolved: opts.includeUnresolved === true,
      };
      const json = jsonMode(ctx);
      const scanning = importProgressFor(ctx.io, json, opts.clock);
      const est = await importTranscripts(
        { ...base, estimateOnly: true, onProgress: (p) => scanning.update(p) },
        deps,
      ).finally(() => scanning.clear());
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
      const progress = importProgressFor(ctx.io, json, opts.clock);
      const { signal, release } = interruptOnSigint(
        opts.signal,
        () => progress.clear(),
        (t) => ctx.io.err(t),
      );
      const r = await importTranscripts(
        { ...base, estimateOnly: false, signal, onProgress: (p) => progress.update(p) },
        deps,
      ).finally(() => {
        progress.clear();
        release();
      });
      const outcomes = Object.entries(r.outcomes ?? {})
        .map(([k, n]) => `${k} ${n}`)
        .join(', ');
      const attempted =
        r.interrupted === undefined
          ? `${r.observations}`
          : `${r.observations - r.interrupted.notAttempted} of ${r.observations}`;
      ctx.io.out(`Imported ${attempted} observations: ${outcomes || 'nothing new'}.\n`);
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
        ...(r.interrupted !== undefined && { notAttempted: r.interrupted.notAttempted }),
      };
      if (r.interrupted !== undefined) {
        // Every session's cursor is at an observation that finished: a re-run imports the rest.
        const n = r.interrupted.notAttempted;
        const msg = `Stopped by Ctrl-C: ${n} ${n === 1 ? 'observation was' : 'observations were'} not attempted; run the same command again to import them.`;
        if (json) warn(ctx, 'interrupted', msg);
        else ctx.io.out(`${msg}\n`);
        opts.onOutcome?.('interrupted');
        if (json) emit(ctx, { outcome: 'interrupted', estimate, imported });
        return INTERRUPTED_EXIT;
      }
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
const MEMORY_TYPES: ReadonlySet<string> = new Set([
  'semantic',
  'episodic',
  'procedural',
  'preference',
  'judgment',
]);
const TIERS: ReadonlySet<string> = new Set(['hot', 'warm', 'cold']);
const END_REASONS: ReadonlySet<unknown> = new Set([null, 'superseded', 'corrected', 'expired']);
const MEMORY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Whether an export line holds what a store writes (security review of CON-137, M1): a file is
 * not trusted, so a type, tier, salience, pin, id or judgment no store writes leaves it out.
 */
function wellFormed(m: Memory): boolean {
  const x = m as unknown as Record<string, unknown>;
  if (typeof x['id'] !== 'string' || !MEMORY_ID.test(x['id'])) return false;
  if (!MEMORY_TYPES.has(x['type'] as string) || !TIERS.has(x['tier'] as string)) return false;
  const salience = x['salience'];
  if (typeof salience !== 'number' || !Number.isFinite(salience)) return false;
  if (salience < 0 || salience > 1) return false;
  if (typeof x['pinned'] !== 'boolean' || typeof x['text'] !== 'string') return false;
  if (!END_REASONS.has(x['endReason'])) return false;
  if (m.type !== 'judgment') return x['judgment'] === undefined;
  if (typeof m.judgment !== 'object' || m.judgment === null) return false;
  try {
    normaliseJudgment(packInput(m.judgment), new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * A judgment from a file arrives as an imported one, as from a pack: `via: 'pack'` with this file
 * as its origin, never confirmed, so it counts only when judging asks for imports (CON-71). What
 * the line says about how it was recorded is not trusted. A withdrawal or purge it carries stays.
 */
function asImported(j: Judgment, origin: JudgmentPackOrigin): Judgment {
  const { confirmed: _confirmed, pack: _pack, via: _via, ...rest } = j;
  return { ...rest, via: 'pack', pack: origin };
}

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
    const now = new Date().toISOString();
    const digest = createHash('sha256').update(text).digest('hex');
    const exportedAt = /"exportedAt"\s*:\s*"([^"]{1,64})"/.exec(text.slice(0, 4096))?.[1] ?? now;
    const origin = (originalId: string): JudgmentPackOrigin => ({
      id: digest.slice(0, 16),
      name: path.basename(full),
      exportedAt,
      exportedBy: 'oort import',
      originalId,
      importedAt: now,
    });
    const fresh: Memory[] = [];
    let already = 0;
    let invalid = 0;
    for (const m of memories) {
      if (addressOf(m).level !== 'user') continue;
      if (!wellFormed(m)) {
        invalid++;
        continue;
      }
      if ((await w.store.get(grant, m.id)) !== null) already++;
      else
        fresh.push(
          m.judgment === undefined ? m : { ...m, judgment: asImported(m.judgment, origin(m.id)) },
        );
    }
    const pinned = fresh.filter((m) => m.pinned).length;
    const judgments = fresh.filter((m) => m.type === 'judgment').length;
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
        ['not valid', `${invalid}${invalid > 0 ? ' (left out)' : ''}`],
      ]),
    );
    const result = (imported: number) => ({
      file: full,
      memories: memories.length,
      imported,
      skipped: already,
      outside,
      invalid,
      pinned,
      judgments,
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
    const what = [
      ...(pinned > 0 ? [`${pinned} pinned`] : []),
      ...(judgments > 0
        ? [
            `${judgments} ${judgments === 1 ? 'judgment' : 'judgments'}, counted only when judging includes imports`,
          ]
        : []),
    ];
    // Where each memory's text goes to be embedded again: the person decides with that in view.
    const where =
      w.config.embed.provider === LOCAL_PROVIDER
        ? 'embedded on this machine by the local model'
        : 'sent to Voyage AI to be embedded (with your Voyage key, or through the Oort relay with Oort Pro)';
    const go = await confirm(
      ctx.io,
      `Import ${fresh.length} memories${what.length > 0 ? ` (${what.join('; ')})` : ''}? Each memory's text is ${where}.`,
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
