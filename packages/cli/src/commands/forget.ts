import { filterFor } from '@oortmem/claude-code';
import { forgetMemory, MAX_CHAIN, restatedValues, type ForgetOutcome } from '@oortmem/core';
import {
  copiesLabel,
  everywhereTarget,
  type CloudNotRewrittenReason,
  type CloudRewrites,
  findCloudMemory,
  liveCopies,
  namedOutcome,
  sharesOf,
  type CloudClient,
  type CloudMemory,
  type SharedCopy,
} from '../cloud.js';
import { emit, jsonMode } from '../output.js';
import {
  Refusal,
  clip,
  cloudOf,
  confirm,
  findMemory,
  noteWarning,
  short,
  shown,
  warn,
  withWired,
  refuseStarInCloud,
  writeGrantFor,
  type Ctx,
} from '../util.js';

/** The `--json` data of `oort forget` (docs/cli.md): Constellation ids, and their names. */
interface ForgetData {
  id: string;
  forgotten: true;
  everywhere: boolean;
  /** `--everywhere`: the copies only you contributed to, withdrawn. */
  withdrawnFrom: string[];
  /** `--everywhere`: others contributed, so a removal request went to the maintainers. */
  removalRequested: string[];
  /** `--everywhere`: not reached; the copy stays. */
  unreachable: string[];
  /** The Constellations still holding a copy after this command. */
  stillShared: SharedCopy[];
  /** Every Constellation named above, with its name. */
  constellations: SharedCopy[];
  /**
   * Later memories that restated it, rewritten to their current fact (CON-144; Oort Cloud's,
   * CON-161). Absent from an Oort Cloud from before CON-156.
   */
  rewritten?: string[];
  /** Later memories that restate it and were left as they were. Absent as `rewritten`. */
  notRewritten?: string[];
  /**
   * Oort Cloud: how many more it left as they were, named with something that is not a memory id
   * (as the SDK's). Absent when there were none.
   */
  notRewrittenUnnamed?: number;
}

const WHY: Record<CloudNotRewrittenReason, string> = {
  'no-writer': 'no memory writer is set up (oort doctor says why)',
  failed: 'the memory writer failed',
  rejected: 'the rewrite added words or kept a value of it, so it was not used',
  unchanged: 'the memory writer left it as it was',
  changed: 'it changed while this command ran',
  'not-writable': 'it is outside what this agent may change',
  'chain-too-long': `it lies past the first ${MAX_CHAIN} later memories of the chain, the most one forget rewrites`,
  // Oort Cloud's own (CON-161).
  quota: 'the account is at a usage cap',
  unpaid: 'the plan does not allow model calls now',
  timeout: 'the rewrite did not finish in time',
};

/** Why a memory was left as it was, in words; a reason this version does not know is quoted. */
function why(reason: string | undefined): string {
  if (reason !== undefined && Object.hasOwn(WHY, reason)) {
    return WHY[reason as CloudNotRewrittenReason];
  }
  return reason === undefined
    ? 'Oort Cloud left it as it was'
    : `Oort Cloud left it as it was (reason: ${shown(clip(reason, 40))})`;
}

/** What a forget did to the later memories that restated it: local (CON-144) or Oort Cloud's. */
export interface Successors {
  /** `text`: the rewrite, when it could be read. */
  rewritten: readonly { id: string; text?: string }[];
  /** `reason`: core's, Oort Cloud's own, one a newer cloud added, or none given. */
  notRewritten: readonly { id: string; reason?: string }[];
  /** Oort Cloud's, named with something that is not a memory id (see `CloudRewrites`). */
  unnamed?: readonly { name: string; reason?: string }[];
}

/** One line per memory rewritten, with its new text when it could be read. */
function reportRewritten(ctx: Ctx, rewritten: Successors['rewritten']): void {
  for (const m of rewritten) {
    ctx.io.out(
      m.text === undefined
        ? `Rewrote ${short(m.id)} to its current fact. Read it with \`oort inspect ${m.id}\`.\n`
        : `Rewrote ${short(m.id)} to its current fact: "${shown(clip(m.text, 80))}"\n`,
    );
  }
}

/**
 * One line (and `not-rewritten` warning) per memory left as it was, with the command that forgets
 * it too: with `--everywhere` when the forgotten memory was shared, as its later ones may be. One
 * Oort Cloud named with something that is not a memory id is shown escaped, with no command.
 * True when there is none.
 */
function reportLeft(
  ctx: Ctx,
  r: Pick<Successors, 'notRewritten' | 'unnamed'>,
  opts: { everywhere?: boolean } = {},
): boolean {
  const flag = opts.everywhere === true ? ' --everywhere' : '';
  for (const m of r.notRewritten) {
    const what =
      m.reason === 'chain-too-long'
        ? 'is a later memory of its chain and may restate it'
        : 'may still restate it';
    const msg = `${short(m.id)} ${what}, because ${why(m.reason)}. Check it with \`oort inspect ${m.id}\`, or forget it too: \`oort forget ${m.id}${flag}\`.`;
    ctx.io.out(`${msg}\n`);
    noteWarning(ctx, 'not-rewritten', msg);
  }
  for (const m of r.unnamed ?? []) {
    const msg = `A later memory may still restate it, because ${why(m.reason)}, but Oort Cloud named it "${shown(clip(m.name, 40))}", which is not a memory id.`;
    ctx.io.out(`${msg}\n`);
    noteWarning(ctx, 'not-rewritten', msg);
  }
  return r.notRewritten.length + (r.unnamed?.length ?? 0) === 0;
}

/**
 * What a forget did to the later memories that restated it (CON-144, in Oort Cloud CON-161): one
 * line per memory rewritten, and one per memory left as it was, with the command that forgets it
 * too. True when every one was rewritten.
 */
export function reportSuccessors(ctx: Ctx, r: Successors): boolean {
  reportRewritten(ctx, r.rewritten);
  return reportLeft(ctx, r);
}

const ids = (copies: readonly SharedCopy[]): string[] => copies.map((c) => c.constellation);

/** `--json`'s `rewritten` and `notRewritten` (memory ids): absent from before CON-156. */
const lists = (
  r: Successors | undefined,
): Pick<ForgetData, 'rewritten' | 'notRewritten' | 'notRewrittenUnnamed'> =>
  r === undefined
    ? {}
    : {
        rewritten: r.rewritten.map((x) => x.id),
        notRewritten: r.notRewritten.map((x) => x.id),
        ...((r.unnamed?.length ?? 0) > 0 && { notRewrittenUnnamed: r.unnamed?.length }),
      };

/**
 * Reading rewrites back (CON-161): how long one read may take, how long they all may take, how
 * many run at once, and how long an abandoned read may take to wind down.
 */
const READ_TIMEOUT_MS = 5_000;
const READ_DEADLINE_MS = 10_000;
const PARALLEL_READS = 4;
const WIND_DOWN_MS = 1_000;

/**
 * Each id with its memory's text, read with `read`: the first `limit` only, at most `parallel`
 * at once, each aborted (through its signal) after `timeoutMs`, and all of them after
 * `deadlineMs`; the rest are not read. A read that fails, is aborted, or answers with another
 * memory or a text that is not a string leaves the text out.
 *
 * An aborted read is waited for until it settles, so it never holds a connection past this call
 * and never runs beside `parallel` others. One that does not settle within `WIND_DOWN_MS` keeps
 * its place: that worker starts no other read.
 */
export async function readTexts(
  ids: readonly string[],
  read: (id: string, signal: AbortSignal) => Promise<{ id?: unknown; text?: unknown }>,
  opts: { limit?: number; parallel?: number; timeoutMs?: number; deadlineMs?: number } = {},
): Promise<{ id: string; text?: string }[]> {
  const {
    limit = MAX_CHAIN,
    parallel = PARALLEL_READS,
    timeoutMs = READ_TIMEOUT_MS,
    deadlineMs = READ_DEADLINE_MS,
  } = opts;
  const out: { id: string; text?: string }[] = ids.map((id) => ({ id }));
  const all = new AbortController();
  const deadline = setTimeout(() => all.abort(), deadlineMs);
  /** The text, if any, and whether the read settled (an abandoned one may not have). */
  const one = async (id: string): Promise<{ text?: string; settled: boolean }> => {
    const ctl = new AbortController();
    const stop = (): void => ctl.abort();
    all.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    let settled = false;
    const reading = read(id, ctl.signal).then(
      (m) => (m.id === id && typeof m.text === 'string' ? m.text : undefined),
      () => undefined,
    );
    void reading.finally(() => (settled = true));
    const aborted = new Promise<void>((r) => {
      if (ctl.signal.aborted) r();
      else ctl.signal.addEventListener('abort', () => r(), { once: true });
    });
    try {
      const text = await Promise.race([reading, aborted.then(() => undefined)]);
      if (!ctl.signal.aborted)
        return text === undefined ? { settled: true } : { text, settled: true };
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([reading, new Promise((r) => (grace = setTimeout(r, WIND_DOWN_MS)))]);
      clearTimeout(grace);
      return { settled };
    } finally {
      clearTimeout(timer);
      all.signal.removeEventListener('abort', stop);
    }
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!all.signal.aborted && next < Math.min(limit, ids.length)) {
      const i = next++;
      const r = await one(ids[i]!);
      if (r.text !== undefined) out[i] = { id: ids[i]!, text: r.text };
      if (!r.settled) return;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  } finally {
    clearTimeout(deadline);
  }
  return out;
}

/** The rewrites Oort Cloud reported, read back for their text (`readTexts`), best effort. */
const withTexts = async (
  cloud: CloudClient,
  r: CloudRewrites,
): Promise<{ id: string; text?: string }[]> =>
  readTexts(r.rewritten, (id, signal) => cloud.get(id, { timeoutMs: READ_TIMEOUT_MS, signal }));

/**
 * `oort forget <id> [--yes] [--everywhere]`: deletes a memory everywhere (main record and cold
 * copy). The later memories of its chain that restate it are rewritten to their current fact,
 * locally (CON-144) and by Oort Cloud (CON-161); any left as they were are named, with exit 3. An
 * Oort Cloud from before CON-156 answers without the lists: then the CLI finds the later
 * memories that restate it itself and names them, as before. In Oort Cloud a copy shared to a
 * Constellation is the team's memory and stays: the question (and `--json`'s warnings) say where,
 * and `--everywhere` withdraws the copies only you contributed to, filing a removal request with
 * the maintainers where others contributed (CON-67).
 */
export async function forgetCommand(
  id: string,
  opts: { yes?: boolean; everywhere?: boolean },
  ctx: Ctx,
): Promise<number> {
  return withWired(ctx, async (w) => {
    const cloud = cloudOf(w);
    if (opts.everywhere === true && cloud === undefined) {
      throw new Refusal('--everywhere is for Oort Cloud, where memories can be shared.', {
        code: 'cloud-only',
      });
    }
    if (cloud !== undefined && opts.everywhere === true) {
      refuseStarInCloud(w);
      return forgetEverywhere(cloud, id, opts, ctx);
    }
    const m =
      cloud !== undefined
        ? await findCloudMemory(cloud, id)
        : await findMemory(w.store, filterFor(w.scope), id);
    refuseStarInCloud(w);
    if (cloud === undefined) writeGrantFor(w, m);
    // Copies in Constellations: none outside the hive beta, where the route answers 403.
    const edges = cloud === undefined ? [] : await sharesOf(cloud, m.id);
    const live = liveCopies(edges ?? []);
    const hint = `add --everywhere to withdraw your copies`;
    const ok = await confirm(
      ctx.io,
      // Memory text may carry escape sequences: the prompt shows them, never runs them.
      `Forget ${short(m.id)} "${shown(clip(m.text, 60))}"` +
        (live.length > 0 ? ` (also shared to ${copiesLabel(live)}; ${hint})?` : '?'),
      opts.yes === true,
      'forget it',
      { json: jsonMode(ctx) },
    );
    if (!ok) {
      ctx.io.out('Kept.\n');
      return 0;
    }
    let local: ForgetOutcome | undefined;
    let answer: CloudRewrites | null = null;
    let restating: CloudSuccessors = { restating: [] };
    if (cloud !== undefined) {
      answer = await cloud.forget(m.id);
      // An Oort Cloud from before CON-156 left the chain as it was: find the later memories that
      // restate it, to name them.
      if (answer === null) restating = await laterRestating(cloud, m);
    } else {
      local = await forgetMemory(
        {
          store: w.store,
          ...(w.write !== undefined && { write: w.write }),
          ...(w.embed !== undefined && { embed: w.embed }),
        },
        writeGrantFor(w, m),
        m.id,
      );
    }
    ctx.io.out(`Forgot ${m.id}.\n`);
    // What Oort Cloud left as it was is printed before its rewrites are read back, so a slow read
    // (or Ctrl-C) never hides it.
    const complete =
      local !== undefined
        ? reportSuccessors(ctx, local)
        : answer !== null
          ? reportLeft(ctx, answer, { everywhere: live.length > 0 })
          : await reportCloudSuccessors(cloud, restating, ctx);
    if (live.length > 0) {
      ctx.io.out(
        `Still shared to ${copiesLabel(live)}: that copy is the team's now. \`oort forget ${m.id} --everywhere\` withdraws it.\n`,
      );
      noteWarning(ctx, 'still-shared', `Also shared to ${copiesLabel(live)}; ${hint}.`);
    }
    if (edges === undefined) {
      warn(ctx, 'shares-unknown', 'Could not check whether it was shared to a Constellation.');
    }
    const rewrites: Successors | undefined =
      cloud !== undefined && answer !== null
        ? { ...answer, rewritten: await withTexts(cloud, answer) }
        : undefined;
    if (rewrites !== undefined) reportRewritten(ctx, rewrites.rewritten);
    const reported = local ?? rewrites;
    if (jsonMode(ctx)) {
      emit<ForgetData>(ctx, {
        id: m.id,
        forgotten: true,
        everywhere: false,
        withdrawnFrom: [],
        removalRequested: [],
        unreachable: [],
        stillShared: live,
        constellations: live,
        ...lists(reported),
      });
    }
    // A memory that may still repeat it is a partial success (exit 3, as `--everywhere`).
    return complete ? 0 : 3;
  });
}

/** The later memories of a memory in Oort Cloud that restate it, and the first one unread. */
interface CloudSuccessors {
  restating: CloudMemory[];
  /** A later memory the walk could not read: it and any after it were not checked. */
  unread?: string;
}

/**
 * The later memories of `m`'s chain in Oort Cloud that restate one of its values (CON-144),
 * following `supersededBy`, for an Oort Cloud from before CON-156, which does not rewrite them (it
 * leaves the chain as it was, so this runs after the forget). A lookup that fails ends the walk, and is reported.
 */
async function laterRestating(cloud: CloudClient, m: CloudMemory): Promise<CloudSuccessors> {
  const restating: CloudMemory[] = [];
  const seen = new Set([m.id]);
  let next = m.supersededBy;
  while (next !== null && next !== undefined && !seen.has(next)) {
    seen.add(next);
    let s: CloudMemory;
    try {
      s = await cloud.get(next);
    } catch {
      return { restating, unread: next };
    }
    if (restatedValues(s, m).length > 0) restating.push(s);
    next = s.supersededBy;
  }
  return { restating };
}

/**
 * Names each later memory that may still restate the forgotten one in an Oort Cloud from before
 * CON-156, which does not rewrite them, and the Constellations it is shared to, and one the walk could not read. True
 * when there is none of either.
 */
async function reportCloudSuccessors(
  cloud: CloudClient | undefined,
  found: CloudSuccessors,
  ctx: Ctx,
): Promise<boolean> {
  if (cloud === undefined) return true;
  for (const s of found.restating) {
    const shared = liveCopies((await sharesOf(cloud, s.id)) ?? []);
    const where = shared.length > 0 ? `; it is also shared to ${copiesLabel(shared)}` : '';
    const msg = `${short(s.id)} may still restate it: Oort Cloud does not rewrite later memories yet${where}. Check it with \`oort inspect ${s.id}\`, or forget it too: \`oort forget ${s.id}${shared.length > 0 ? ' --everywhere' : ''}\`.`;
    ctx.io.out(`${msg}\n`);
    noteWarning(ctx, 'not-rewritten', msg);
  }
  if (found.unread !== undefined) {
    const msg = `Could not read ${short(found.unread)}, a later memory of it, so it and any after it may still restate it. Check it with \`oort inspect ${found.unread}\`.`;
    ctx.io.out(`${msg}\n`);
    noteWarning(ctx, 'successors-unknown', msg);
  }
  return found.restating.length === 0 && found.unread === undefined;
}

/** `forget --everywhere` in Oort Cloud: the source, then each shared copy (CON-67). */
async function forgetEverywhere(
  cloud: CloudClient,
  ref: string,
  opts: { yes?: boolean },
  ctx: Ctx,
): Promise<number> {
  const t = await everywhereTarget(cloud, ref);
  const live = liveCopies(t.edges);
  // The list is what the lookup saw a moment ago; the API acts on every copy it holds then, so
  // the question never promises an exact list, and the result printed is the API's own.
  const others = 'and any other Constellation you shared it to';
  const where =
    live.length === 0
      ? ' (no shared copies found; any you made will be withdrawn)'
      : ` and withdraw your copies from ${copiesLabel(live)} (${others}; where others contributed, its maintainers get a removal request)`;
  const ok = await confirm(
    ctx.io,
    t.memory === null
      ? `Withdraw your copies of ${short(t.id)} (already forgotten) from ${copiesLabel(live)} (${others})?`
      : `Forget ${short(t.id)} "${shown(clip(t.memory.text, 60))}"${where}?`,
    opts.yes === true,
    'forget it everywhere',
    { json: jsonMode(ctx) },
  );
  if (!ok) {
    ctx.io.out('Kept.\n');
    return 0;
  }
  const answer = await cloud.forgetEverywhere(t.id);
  const r = namedOutcome(answer, t.edges);
  // As a plain forget: an Oort Cloud from before CON-156 answers without the lists.
  const restating: CloudSuccessors =
    answer.rewrites !== null || t.memory === null
      ? { restating: [] }
      : await laterRestating(cloud, t.memory);
  ctx.io.out(t.memory === null ? `${t.id} was already forgotten.\n` : `Forgot ${t.id}.\n`);
  if (r.withdrawn.length > 0) ctx.io.out(`Withdrawn from ${copiesLabel(r.withdrawn)}.\n`);
  if (r.requested.length > 0) {
    const msg = `Others contributed in ${copiesLabel(r.requested)}: a removal request went to the maintainers, and the copy stays until they decide.`;
    ctx.io.out(`${msg}\n`);
    noteWarning(ctx, 'removal-requested', msg);
  }
  if (r.unreachable.length > 0) {
    const msg = `Not reached: ${copiesLabel(r.unreachable)}. The copy stays; run \`oort forget ${t.id} --everywhere\` again later (a Constellation you left needs a full key, or the dashboard).`;
    ctx.io.out(`${msg}\n`);
    noteWarning(ctx, 'unreachable', msg);
  }
  if (r.withdrawn.length + r.requested.length + r.unreachable.length === 0) {
    ctx.io.out('It was not shared to any Constellation.\n');
  }
  const complete =
    answer.rewrites !== null
      ? reportLeft(ctx, answer.rewrites, { everywhere: true })
      : await reportCloudSuccessors(cloud, restating, ctx);
  const rewrites: Successors | undefined =
    answer.rewrites !== null
      ? { ...answer.rewrites, rewritten: await withTexts(cloud, answer.rewrites) }
      : undefined;
  if (rewrites !== undefined) reportRewritten(ctx, rewrites.rewritten);
  if (jsonMode(ctx)) {
    const stillShared = [...r.requested, ...r.unreachable].filter(
      (c, i, all) => all.findIndex((x) => x.constellation === c.constellation) === i,
    );
    emit<ForgetData>(ctx, {
      id: t.id,
      forgotten: true,
      everywhere: true,
      withdrawnFrom: ids(r.withdrawn),
      removalRequested: ids(r.requested),
      unreachable: ids(r.unreachable),
      stillShared,
      constellations: [
        ...new Map(
          [...r.withdrawn, ...r.requested, ...r.unreachable].map((c) => [c.constellation, c]),
        ).values(),
      ],
      ...lists(rewrites),
    });
  }
  // A copy not reached, or a later memory that may restate it, is a partial success (exit 3).
  return r.unreachable.length > 0 || !complete ? 3 : 0;
}
