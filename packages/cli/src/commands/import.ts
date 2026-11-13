import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ExportFormatError,
  addressOf,
  fileOrigin,
  importedJudgment,
  judgmentText,
  nodeGrant,
  type Decision,
  type Judgment,
  type JudgmentPackOrigin,
  type MemorySource,
  parseExport,
  planetNode,
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
  shown,
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
const END_REASONS: ReadonlySet<unknown> = new Set(['superseded', 'corrected', 'expired']);
const MEMORY_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** What one imported memory may hold (a file is not trusted to be small). */
const LINE_LIMITS = Object.freeze({
  text: 64_000,
  stub: 2_000,
  entities: 64,
  entity: 200,
  decisions: 64,
  decisionText: 4_000,
  harness: 128,
});
/** The largest file `oort import <file>` reads (a cap on memory, not on any real export). */
export const IMPORT_FILE_MAX_BYTES = 100 * 1024 * 1024;

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** The times a file may state: years 0000 to 9999 (re-review Info 3). */
const MIN_TIME = Date.parse('0000-01-01T00:00:00.000Z');
const MAX_TIME = Date.parse('9999-12-31T23:59:59.999Z');

/** A time from a file, in milliseconds; an extended year or an unreadable one: undefined. */
function fileTime(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.length > 64 || /^\s*[+-]/.test(v)) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) || t < MIN_TIME || t > MAX_TIME ? undefined : t;
}

/** An end a file states: null when there is none, undefined when it cannot be read. */
const endTime = (v: unknown): number | null | undefined =>
  v === null || v === undefined ? null : fileTime(v);

const iso = (t: number): string => new Date(t).toISOString();

/** Whether a line's judgment says it was withdrawn or purged. */
function endedJudgment(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const j = v as Record<string, unknown>;
  return (j['withdrawn'] ?? null) !== null || (j['purged'] ?? null) !== null;
}

/** A memory's source, when it has the shape a store writes; otherwise a plain one. */
function fileSource(v: unknown): MemorySource {
  const plain: MemorySource = { harness: 'oort import', decisions: [] };
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return plain;
  const o = v as Record<string, unknown>;
  const decisions = o['decisions'];
  if (!isText(o['harness'], LINE_LIMITS.harness) || !Array.isArray(decisions)) return plain;
  if (decisions.length > LINE_LIMITS.decisions) return plain;
  const out: Decision[] = [];
  for (const d of decisions) {
    if (typeof d !== 'object' || d === null) return plain;
    const x = d as Record<string, unknown>;
    const p = x['probability'];
    if (
      !isText(x['stage'], LINE_LIMITS.decisionText) ||
      !isText(x['question'], LINE_LIMITS.decisionText) ||
      !isText(x['answer'], LINE_LIMITS.decisionText) ||
      typeof p !== 'number' ||
      !Number.isFinite(p) ||
      p < 0 ||
      p > 1
    ) {
      return plain;
    }
    out.push({ stage: x['stage'], question: x['question'], answer: x['answer'], probability: p });
  }
  return {
    harness: o['harness'],
    ...(isText(o['sessionId'], LINE_LIMITS.harness) && { sessionId: o['sessionId'] }),
    ...(isText(o['turnRef'], LINE_LIMITS.harness) && { turnRef: o['turnRef'] }),
    decisions: out,
  };
}

/**
 * One export line as this store keeps it (security review of CON-137): rebuilt from its content
 * alone, so nothing else a file claims reaches the store. Kept: id, type, text, stub, entities,
 * salience (0 to 1), pin, source (when well formed), project and author, and the times. Reset as
 * for a new memory: tier warm, access log empty, never confirmed here, no provenance. Times are
 * normalised and clamped to now; an end that has passed must hold together. Links are
 * set afterwards (only to other lines of the file). A judgment is the one importedJudgment
 * builds, kept as recording one keeps it (pinned, its text and stub rendered from it); one the
 * file says was withdrawn or purged is 'ended'. 'invalid' when the line is not something a store
 * writes.
 */
function rebuilt(
  m: Memory,
  now: Date,
  origin: (id: string) => JudgmentPackOrigin,
): Memory | 'invalid' | 'ended' {
  const x = m as unknown as Record<string, unknown>;
  const id = x['id'];
  const type = x['type'];
  if (typeof id !== 'string' || !MEMORY_ID.test(id)) return 'invalid';
  if (typeof type !== 'string' || !MEMORY_TYPES.has(type)) return 'invalid';
  if (!TIERS.has(x['tier'] as string) || typeof x['pinned'] !== 'boolean') return 'invalid';
  const salience = x['salience'];
  if (typeof salience !== 'number' || !Number.isFinite(salience)) return 'invalid';
  if (salience < 0 || salience > 1) return 'invalid';
  // Times as numbers (re-review Info 3), a start after now clamped to now.
  const nowT = now.getTime();
  const createdRaw = fileTime(x['createdAt']);
  const updatedRaw = fileTime(x['updatedAt']);
  const validFromRaw = fileTime(x['validFrom']);
  if (createdRaw === undefined || updatedRaw === undefined || validFromRaw === undefined) {
    return 'invalid';
  }
  const created = Math.min(createdRaw, nowT);
  const validFrom = Math.min(validFromRaw, nowT);
  const updated = Math.max(Math.min(updatedRaw, nowT), created);
  // An end is kept only when it holds together: in valid time after the start (both the start the
  // file gives and the clamped one), in transaction time with a reason and not before the record.
  // One that does not (including one a clamped start overtook) leaves the line out: an ended fact
  // never becomes current (re-review Info 2). A valid-time end still ahead is kept, so a fact
  // planned to end does so on time; a record cannot have been ended in the future, so an expiry
  // ahead of now is dropped.
  const validToT = endTime(x['validTo']);
  const expiredT = endTime(x['expiredAt']);
  if (validToT === undefined || expiredT === undefined) return 'invalid';
  const validTo = validToT;
  const expiredAt = expiredT !== null && expiredT <= nowT ? expiredT : null;
  if (validTo !== null && (validTo <= validFrom || validTo <= validFromRaw)) return 'invalid';
  if (expiredAt !== null && (expiredAt < created || !END_REASONS.has(x['endReason']))) {
    return 'invalid';
  }
  const scope = { ...m.scope, agentId: m.scope.agentId };
  const common = {
    id,
    scope,
    ...(m.address !== undefined && { address: m.address }),
    ...(m.author !== undefined && { author: { agentId: m.author.agentId } }),
    tier: 'warm' as const,
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom: iso(validFrom),
    validTo: validTo === null ? null : iso(validTo),
    expiredAt: expiredAt === null ? null : iso(expiredAt),
    endReason: expiredAt === null ? null : (x['endReason'] as Memory['endReason']),
    lastConfirmedAt: null,
    supersedes: null,
    supersededBy: null,
    source: fileSource(x['source']),
    createdAt: iso(created),
    updatedAt: iso(updated),
    // Checked by parseExport, as a write checks it (CON-84).
    ...(m.place !== undefined && { place: m.place }),
  };
  if (type === 'judgment') {
    // Ended in the file: only a person here may end a decision (re-review N1).
    if (endedJudgment(x['judgment'])) return 'ended';
    let j: Judgment;
    try {
      j = importedJudgment(x['judgment'], origin(id));
    } catch {
      return 'invalid';
    }
    // As recording one keeps it (judgment memories are the expert's, unbound to a project).
    const { projectId: _p, ...unbound } = scope;
    return {
      ...common,
      scope: unbound,
      type: 'judgment',
      text: judgmentText(j),
      stub: `${j.verdict}: ${j.subject.summary.slice(0, 80)}`,
      entities: [...new Set([j.domain, ...j.criteria])],
      salience: 0.8,
      pinned: true,
      judgment: j,
    };
  }
  if (x['judgment'] !== undefined) return 'invalid';
  const entities = x['entities'];
  if (
    !isText(x['text'], LINE_LIMITS.text) ||
    x['text'] === '' ||
    !isText(x['stub'], LINE_LIMITS.stub) ||
    !Array.isArray(entities) ||
    entities.length > LINE_LIMITS.entities ||
    !entities.every((e) => isText(e, LINE_LIMITS.entity))
  ) {
    return 'invalid';
  }
  return {
    ...common,
    type: type as Memory['type'],
    text: x['text'],
    stub: x['stub'],
    entities: [...entities],
    salience,
    pinned: x['pinned'],
  };
}

export async function importFileCommand(
  file: string,
  opts: ImportFileOptions,
  ctx: Ctx,
): Promise<number> {
  const full = path.resolve(ctx.io.cwd, file);
  let text: string;
  try {
    const size = fs.statSync(full).size;
    if (size > IMPORT_FILE_MAX_BYTES) {
      throw new Refusal(
        `${echo(file)} is ${Math.ceil(size / 1024 / 1024)} MB; oort import reads at most ${IMPORT_FILE_MAX_BYTES / 1024 / 1024} MB.`,
        { fix: 'oort import <file.jsonl>' },
      );
    }
    text = fs.readFileSync(full, 'utf8');
  } catch (e) {
    if (e instanceof Refusal) throw e;
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
    let explicit: [string, string][];
    let exportedAt: unknown;
    try {
      const parsed = parseExport(text, { planet: { orgId, customerId } });
      memories = parsed.memories;
      explicit = parsed.links;
      exportedAt = parsed.manifest.exportedAt;
    } catch (e) {
      if (e instanceof ExportFormatError) {
        throw new Refusal(`${echo(file)} is not an Oort export: ${e.message}.`);
      }
      throw e;
    }
    // An export never repeats an id: which copy is real is unknowable, and the counts asked
    // about would not match what is stored (re-review Info 1).
    const seen = new Set<unknown>();
    for (const m of memories) {
      const id = (m as unknown as Record<string, unknown>)['id'];
      if (seen.has(id)) {
        throw new Refusal(
          `${echo(file)} repeats the id ${shown(String(id).slice(0, 64))}, which an Oort export never does: nothing was imported.`,
        );
      }
      seen.add(id);
    }
    const planet = { node: planetNode({ orgId, customerId }), projectIds: 'all' as const };
    const grant = nodeGrant({
      principal: { orgId, customerId, agentId },
      read: [planet],
      write: [planet],
    });
    const outside = memories.filter((m) => addressOf(m).level !== 'user').length;
    const now = new Date();
    const digest = createHash('sha256').update(text).digest('hex');
    const origin = (id: string) =>
      fileOrigin({ digest, name: path.basename(full), exportedAt, originalId: id, now });
    const fresh: Memory[] = [];
    const links = new Map<string, { supersedes: unknown; supersededBy: unknown }>();
    let already = 0;
    let invalid = 0;
    let ended = 0;
    for (const m of memories) {
      if (addressOf(m).level !== 'user') continue;
      const r = rebuilt(m, now, origin);
      if (r === 'invalid' || r === 'ended') {
        invalid++;
        if (r === 'ended') ended++;
        continue;
      }
      if ((await w.store.get(grant, r.id)) !== null) {
        already++;
        continue;
      }
      fresh.push(r);
      links.set(r.id, { supersedes: m.supersedes, supersededBy: m.supersededBy });
    }
    // A link is kept only to another memory of this file that is being imported.
    for (const r of fresh) {
      const l = links.get(r.id)!;
      const to = (v: unknown): string | null =>
        typeof v === 'string' && v !== r.id && links.has(v) ? v : null;
      r.supersedes = to(l.supersedes);
      r.supersededBy = to(l.supersededBy);
    }
    // Judgments are pinned as recorded ones are, and counted on their own.
    const pinned = fresh.filter((m) => m.pinned && m.type !== 'judgment').length;
    const judgments = fresh.filter((m) => m.type === 'judgment').length;
    const json = jsonMode(ctx);
    const ui = uiFor(ctx.io);
    // The name is the file's own: printed with its control characters escaped (L-c).
    const fileShown = shown(tilde(full, ctx.io.env['HOME'] || os.homedir()));
    ctx.io.out(ui.header('import', 'an Oort export into this machine'));
    ctx.io.out(
      ui.kv([
        ['file', fileShown],
        ['memories', String(memories.length)],
        ['already here', String(already)],
        ['outside a Planet', `${outside}${outside > 0 ? ' (left out)' : ''}`],
        [
          'not valid',
          `${invalid}${invalid > 0 ? ` (left out${ended > 0 ? `; ${ended} ended ${ended === 1 ? 'decision is' : 'decisions are'} not imported` : ''})` : ''}`,
        ],
      ]),
    );
    const result = (imported: number, linked = 0) => ({
      file: full,
      memories: memories.length,
      imported,
      links: linked,
      skipped: already,
      outside,
      invalid,
      ended,
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
      // Pinned memories are shown to the agent at every session start: the person sees that.
      ...(pinned > 0 ? [`${pinned} pinned, shown at every session start`] : []),
      ...(judgments > 0
        ? [
            `${judgments} ${judgments === 1 ? 'judgment' : 'judgments'}, pinned and shown at every session start, counted only when judging includes imports`,
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
    // Written warm, with a fresh vector from this store's embedder.
    const ready: Memory[] = [];
    for (let i = 0; i < fresh.length; i += EMBED_BATCH) {
      const batch = fresh.slice(i, i + EMBED_BATCH);
      const vectors = await embed.embed(
        batch.map((m) => m.text),
        'document',
      );
      batch.forEach((m, k) => {
        const v = vectors[k];
        ready.push({ ...m, ...(v !== undefined && { embedding: v }) });
      });
    }
    await w.store.upsertMany(grant, ready);
    // The file's explicit links between memories now in this Planet (CON-148), asserted by
    // `agent`: a file never says a person asserted one. A pair the store cannot link is skipped.
    let linked = 0;
    if (w.store.links === true) {
      const imported = new Set(ready.map((m) => m.id));
      for (const [a, b] of explicit) {
        if (!imported.has(a) && !imported.has(b)) continue;
        const r = await w.store.link!(grant, a, b, { assertedBy: 'agent' });
        if (r?.linked === true) linked++;
      }
    }
    ctx.io.out(
      `Imported ${ready.length} memories from ${fileShown}${already > 0 ? ` (${already} already here)` : ''}${linked > 0 ? `, and ${linked} ${linked === 1 ? 'link' : 'links'}` : ''}.\n`,
    );
    if (json) emit(ctx, { outcome: 'imported', ...result(ready.length, linked) });
    return 0;
  });
}
