import { filterFor } from '@oortmem/claude-code';
import {
  FEEDBACK_SIGNALS,
  FEEDBACK_STATUSES,
  FeedbackError,
  FeedbackPurgeError,
  claimAge,
  claimIsStale,
  confirmFeedback,
  dismissFeedback,
  findFeedback,
  isAgentVia,
  listFeedback,
  recordFeedback,
  retireFeedback,
  supersedeFeedback,
  withoutInvisible,
  type Feedback,
  type FeedbackClaim,
  type FeedbackSignal,
  type FeedbackStatus,
} from '@oortmem/core';
import { emit, jsonMode } from '../output.js';
import { uiFor } from '../ui.js';
import {
  Refusal,
  agentLabel,
  clip,
  confirm,
  findMemory,
  short,
  shown,
  withWired,
  writeGrant,
  type Ctx,
} from '../util.js';
import type { Wired } from '../wire.js';
import { cliLabel, operatorOf, originFields, originTag } from './judge.js';

/**
 * `oort feedback …`: a person says a recalled memory helped, is wrong, is out of date, or did
 * not fit the query. What is given here counts at once. What an agent gives over MCP waits,
 * pending, until a person confirms it here; only this command (or the expert role over
 * `oort serve`) confirms, retires, supersedes or dismisses. Local store only.
 */

function localOnly(w: Wired): void {
  if (w.mode === 'cloud') {
    throw new Refusal(
      'Recall feedback is local-only for now: Oort Cloud does not keep it yet. Run `oort cloud use --local` to use it.',
      { code: 'refused' },
    );
  }
}

/** A `FeedbackError` as a refusal: its messages name states and fields, never stored text. */
async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FeedbackError) {
      // The message says what changed and what to run next (in-progress: run the same again).
      throw new Refusal(
        e.message,
        e.kind === 'invalid'
          ? { code: 'usage' }
          : e.kind === 'not-found'
            ? { code: 'not-found', fix: 'oort feedback list --status all' }
            : e.kind === 'memory-not-found'
              ? { code: 'not-found' }
              : e.kind === 'ambiguous'
                ? { code: 'ambiguous-id' }
                : { code: 'refused' },
      );
    }
    if (e instanceof FeedbackPurgeError) throw new Refusal(e.message, { code: 'internal' });
    throw e;
  }
}

function signalOf(raw: string): FeedbackSignal {
  if (!(FEEDBACK_SIGNALS as readonly string[]).includes(raw)) {
    throw new Refusal(`The signal must be one of: ${FEEDBACK_SIGNALS.join(', ')}.`);
  }
  return raw as FeedbackSignal;
}

function statusOf(raw: string | undefined): FeedbackStatus | undefined {
  if (raw === undefined || raw === 'all') return undefined;
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(raw)) {
    throw new Refusal(`--status must be all or one of: ${FEEDBACK_STATUSES.join(', ')}.`);
  }
  return raw as FeedbackStatus;
}

function limitOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new Refusal('--limit must be a whole number from 1 to 1000.');
  }
  return n;
}

/** Text as shown: invisible characters (zero-width, bidi, tag) taken out of older rows too. */
const seen = (s: string): string => withoutInvisible(s);

/**
 * A retire or supersede under way (or stopped part way): what it does, who started it, how long
 * ago, whether another resolve may take it over yet, and the fact a supersede would store.
 */
function claimOf(c: FeedbackClaim, now = new Date()) {
  return {
    action: c.action,
    by: seen(c.by),
    at: c.at,
    ageSeconds: Math.max(0, Math.floor(claimAge(c, now) / 1000)),
    canTakeOver: claimIsStale(c, now),
    ...(c.takenOverBy !== undefined && {
      takenOverBy: seen(c.takenOverBy),
      takenOverAt: c.takenOverAt,
    }),
    ...(c.undoing === true && { undoing: true }),
    ...(c.fact !== undefined && { fact: seen(c.fact) }),
    ...(c.memoryId !== undefined && { memoryId: c.memoryId }),
  };
}

/** One row as JSON: the stored record, with who gave it said plainly. */
function plain(f: Feedback) {
  return {
    id: f.id,
    memoryId: f.memoryId,
    signal: f.signal,
    status: f.status,
    ...(f.note !== undefined && { note: seen(f.note) }),
    ...(f.query !== undefined && { query: seen(f.query) }),
    by: seen(f.by),
    agentRecorded: isAgentVia(f.via),
    ...originFields(f),
    ...(f.applied !== undefined && { applied: f.applied }),
    ...(f.reason !== undefined && { reason: f.reason }),
    createdAt: f.createdAt,
    ...(f.confirmed !== undefined && { confirmed: f.confirmed }),
    ...(f.claim !== undefined && { claim: claimOf(f.claim) }),
    ...(f.resolved !== undefined && { resolved: f.resolved }),
  };
}

/** One line for a row: id, signal, memory, status, who, and the note. */
function line(f: Feedback): string {
  const agent = isAgentVia(f.via) ? ' [agent]' : '';
  const note = f.note === undefined ? '' : `  "${shown(clip(seen(f.note), 120))}"`;
  const query = f.query === undefined ? '' : `  query: "${shown(clip(seen(f.query), 80))}"`;
  return `${short(f.id)}  ${f.signal.padEnd(10)} memory ${short(f.memoryId)}  ${f.status.padEnd(10)} by ${shown(seen(f.by))}${agent}${originTag(f)}${note}${query}${claimLine(f.claim)}`;
}

/**
 * A claim, on a row's line: `[supersede by ada, 7 min ago, can be taken over: "fact"]`, or
 * `[supersede by ada, taken over by grace, just now: "fact"]` (the age counts from the takeover).
 */
function claimLine(claim: FeedbackClaim | undefined): string {
  if (claim === undefined) return '';
  const c = claimOf(claim);
  const verb = c.action === 'retired' ? 'retire' : 'supersede';
  const age = c.ageSeconds < 60 ? 'just now' : `${Math.floor(c.ageSeconds / 60)} min ago`;
  const over = c.canTakeOver ? ', can be taken over' : '';
  const fact = c.fact === undefined ? '' : `: "${shown(clip(c.fact, 120))}"`;
  const taken =
    c.takenOverBy === undefined
      ? ''
      : `, ${c.undoing === true ? 'being put back' : 'taken over'} by ${shown(c.takenOverBy)}`;
  return `  [${verb} by ${shown(c.by)}${taken}, ${age}${over}${fact}]`;
}

const NEXT: Partial<Record<FeedbackSignal, string>> = {
  wrong: 'Recall labels the memory contested until a person retires, supersedes or dismisses this.',
  stale: 'Recall labels the memory contested until a person retires, supersedes or dismisses this.',
  irrelevant: 'Kept as a pair of the query and the memory; recall does not use it.',
};

export interface FeedbackGiveOptions {
  note?: string;
  query?: string;
  by?: string;
  json?: boolean;
}

/** `oort feedback <memoryId> <signal> [--note] [--query]`: a person's feedback, counted at once. */
export async function feedbackCommand(
  memoryRef: string,
  rawSignal: string,
  o: FeedbackGiveOptions,
  ctx: Ctx,
): Promise<number> {
  const signal = signalOf(rawSignal);
  return withWired(ctx, async (w) => {
    localOnly(w);
    const m = await findMemory(w.store, filterFor(w.scope), memoryRef);
    const by = operatorOf(w, o.by);
    const r = await refusing(() =>
      recordFeedback(
        {
          memoryId: m.id,
          signal,
          by,
          ...(o.note !== undefined && { note: o.note }),
          ...(o.query !== undefined && { query: o.query }),
        },
        {
          store: w.store,
          grant: writeGrant(w),
          scope: w.scope,
          via: 'cli',
          label: cliLabel(ctx),
          helpedAccesses: w.config.feedback.helpedAccesses,
        },
      ),
    );
    if (!r.kept) throw new Refusal('Too much feedback is waiting here.', { code: 'refused' });
    const f = r.feedback;
    if (signal === 'helped') {
      ctx.io.out(
        r.applied === true
          ? `Recorded ${short(f.id)}: ${short(m.id)} helped. It counts as recently used.\n`
          : r.reason === 'disabled'
            ? `Recorded ${short(f.id)}: ${short(m.id)} helped (feedback.helpedAccesses is 0, so recall is unchanged).\n`
            : `Recorded ${short(f.id)}: ${short(m.id)} helped. ${shown(by)} already marked it helped today, so it counts once.\n`,
      );
    } else {
      ctx.io.out(`Recorded ${short(f.id)}: ${short(m.id)} is ${signal}. ${NEXT[signal] ?? ''}\n`);
      if (signal === 'wrong' || signal === 'stale') {
        ctx.io.out(
          `  oort feedback retire ${short(f.id)}     end the memory\n  oort feedback supersede ${short(f.id)} "<the right fact>"\n  oort feedback dismiss ${short(f.id)}    keep it as it is\n`,
        );
      }
    }
    if (jsonMode(ctx)) {
      emit(ctx, {
        feedback: plain(f),
        ...(r.applied !== undefined && { applied: r.applied }),
        ...(r.reason !== undefined && { reason: r.reason }),
      });
    }
    return 0;
  });
}

/** `oort feedback list [--status <s>|all] [--memory <id>] [--signal <s>] [--limit <n>]`. */
export async function feedbackListCommand(
  o: { status?: string; memory?: string; signal?: string; limit?: string; json?: boolean },
  ctx: Ctx,
): Promise<number> {
  const status = statusOf(o.status ?? 'all');
  const signal = o.signal === undefined ? undefined : signalOf(o.signal);
  const limit = limitOf(o.limit);
  return withWired(ctx, async (w) => {
    localOnly(w);
    const memoryId =
      o.memory === undefined
        ? undefined
        : (await findMemory(w.store, filterFor(w.scope), o.memory)).id;
    const rows = await refusing(() =>
      listFeedback(w.store, writeGrant(w), {
        ...(status !== undefined && { status }),
        ...(memoryId !== undefined && { memoryId }),
        ...(signal !== undefined && { signal }),
        ...(limit !== undefined && { limit }),
      }),
    );
    if (jsonMode(ctx)) {
      emit(ctx, { feedback: rows.map(plain) });
      return 0;
    }
    const ui = uiFor(ctx.io);
    ctx.io.out(ui.header('feedback', `${rows.length} ${status ?? 'kept'}`, agentLabel(w)));
    if (rows.length === 0) {
      ctx.io.err('oort: no feedback yet.\n');
      return 0;
    }
    for (const f of rows) ctx.io.out(`${line(f)}\n`);
    return 0;
  });
}

interface ResolveOptions {
  yes?: boolean;
  by?: string;
  json?: boolean;
}

/** The row an id or unique prefix names, asked about first unless `--yes`. */
async function resolving(
  ctx: Ctx,
  w: Wired,
  ref: string,
  o: ResolveOptions,
  question: (f: Feedback) => string,
  flagHint: string,
): Promise<{ f: Feedback; by: string } | undefined> {
  const f = await refusing(() => findFeedback(w.store, writeGrant(w), ref));
  const by = operatorOf(w, o.by);
  const ok = await confirm(ctx.io, `${question(f)}\n  ${line(f)}`, o.yes === true, flagHint, {
    json: jsonMode(ctx),
  });
  if (!ok) {
    ctx.io.out('Nothing changed.\n');
    return undefined;
  }
  return { f, by };
}

/** `oort feedback confirm <id>`: a person vouches for an agent's pending feedback. */
export async function feedbackConfirmCommand(
  ref: string,
  o: ResolveOptions,
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    localOnly(w);
    const r = await resolving(
      ctx,
      w,
      ref,
      o,
      (f) => `Confirm this feedback from ${shown(f.by)}? It counts as yours from now on.`,
      'confirm it',
    );
    if (r === undefined) return 0;
    const f = await refusing(() =>
      confirmFeedback(r.f.id, {
        store: w.store,
        grant: writeGrant(w),
        by: r.by,
        label: cliLabel(ctx, o.yes),
        helpedAccesses: w.config.feedback.helpedAccesses,
      }),
    );
    ctx.io.out(
      `Confirmed ${short(f.id)} (by ${shown(r.by)}): it is ${f.status} now${f.applied === false ? ', and the memory was already marked helped today' : ''}.\n`,
    );
    if (jsonMode(ctx)) emit(ctx, { feedback: plain(f) });
    return 0;
  });
}

/** `oort feedback retire <id>`: end the memory a wrong or stale feedback names. */
export async function feedbackRetireCommand(
  ref: string,
  o: ResolveOptions,
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    localOnly(w);
    const r = await resolving(
      ctx,
      w,
      ref,
      o,
      (f) =>
        `End memory ${short(f.memoryId)} as ${f.signal === 'wrong' ? 'corrected (it was wrong)' : 'expired (it held until now)'}? Recall leaves it out from now on.`,
      'retire it',
    );
    if (r === undefined) return 0;
    const done = await refusing(() =>
      retireFeedback(r.f.id, { store: w.store, grant: writeGrant(w), by: r.by }),
    );
    ctx.io.out(
      `Retired ${short(done.memory.id)} (${done.endReason}); feedback ${short(done.feedback.id)} is closed. \`oort inspect ${short(done.memory.id)}\` shows it.\n`,
    );
    if (jsonMode(ctx)) {
      emit(ctx, {
        feedback: plain(done.feedback),
        memoryId: done.memory.id,
        endReason: done.endReason,
      });
    }
    return 0;
  });
}

/** `oort feedback supersede <id> "<right fact>"`: store the right fact; the old memory ends. */
export async function feedbackSupersedeCommand(
  ref: string,
  fact: string,
  o: ResolveOptions,
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    localOnly(w);
    const r = await resolving(
      ctx,
      w,
      ref,
      o,
      (f) =>
        `Replace memory ${short(f.memoryId)} with "${shown(clip(fact, 200))}"? The old memory ends as superseded.`,
      'supersede it',
    );
    if (r === undefined) return 0;
    const done = await refusing(() =>
      supersedeFeedback(r.f.id, fact, {
        store: w.store,
        grant: writeGrant(w),
        scope: w.scope,
        by: r.by,
        ...(w.embed !== undefined && { embed: w.embed }),
        harness: 'cli',
      }),
    );
    const redacted =
      done.redacted.length > 0 ? ` Redacted before storing: ${done.redacted.join(', ')}.` : '';
    ctx.io.out(
      `Stored ${short(done.memory.id)}; it supersedes ${short(done.supersedes)}. Feedback ${short(done.feedback.id)} is closed.${redacted}\n`,
    );
    if (jsonMode(ctx)) {
      emit(ctx, {
        feedback: plain(done.feedback),
        memoryId: done.memory.id,
        supersedes: done.supersedes,
        redacted: done.redacted,
      });
    }
    return 0;
  });
}

/** `oort feedback dismiss <id>`: close the feedback and keep the memory as it is. */
export async function feedbackDismissCommand(
  ref: string,
  o: ResolveOptions,
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    localOnly(w);
    const r = await resolving(
      ctx,
      w,
      ref,
      o,
      () => 'Dismiss this feedback? The memory stays as it is, and recall stops labelling it.',
      'dismiss it',
    );
    if (r === undefined) return 0;
    const f = await refusing(() =>
      dismissFeedback(r.f.id, { store: w.store, grant: writeGrant(w), by: r.by }),
    );
    ctx.io.out(`Dismissed ${short(f.id)}; memory ${short(f.memoryId)} is unchanged.\n`);
    if (jsonMode(ctx)) emit(ctx, { feedback: plain(f) });
    return 0;
  });
}
