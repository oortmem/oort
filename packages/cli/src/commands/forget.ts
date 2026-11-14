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
   * CON-161). Absent from an Oort Cloud that does not rewrite them.
   */
  rewritten?: string[];
  /** Later memories that restate it and were left as they were. Absent as `rewritten`. */
  notRewritten?: string[];
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
}

/**
 * What a forget did to the later memories that restated it (CON-144, in Oort Cloud CON-161): one
 * line per memory rewritten, and one per memory left as it was, with the command that forgets it
 * too. True when every one was rewritten.
 */
export function reportSuccessors(ctx: Ctx, r: Successors): boolean {
  for (const m of r.rewritten) {
    ctx.io.out(
      m.text === undefined
        ? `Rewrote ${short(m.id)} to its current fact. Read it with \`oort inspect ${m.id}\`.\n`
        : `Rewrote ${short(m.id)} to its current fact: "${shown(clip(m.text, 80))}"\n`,
    );
  }
  for (const m of r.notRewritten) {
    const what =
      m.reason === 'chain-too-long'
        ? 'is a later memory of its chain and may restate it'
        : 'may still restate it';
    const msg = `${short(m.id)} ${what}, because ${why(m.reason)}. Check it with \`oort inspect ${m.id}\`, or forget it too: \`oort forget ${m.id}\`.`;
    ctx.io.out(`${msg}\n`);
    noteWarning(ctx, 'not-rewritten', msg);
  }
  return r.notRewritten.length === 0;
}

const ids = (copies: readonly SharedCopy[]): string[] => copies.map((c) => c.constellation);

/** `--json`'s `rewritten` and `notRewritten`: absent when nobody rewrote (an older Oort Cloud). */
const lists = (r: Successors | undefined): Pick<ForgetData, 'rewritten' | 'notRewritten'> =>
  r === undefined
    ? {}
    : { rewritten: r.rewritten.map((x) => x.id), notRewritten: r.notRewritten.map((x) => x.id) };

/**
 * The rewrites Oort Cloud reported, each with its new text when it can be read (best effort: a
 * failed read only leaves the text out).
 */
async function withTexts(cloud: CloudClient, r: CloudRewrites): Promise<Successors> {
  const rewritten = await Promise.all(
    r.rewritten.map(async (id) => {
      try {
        return { id, text: (await cloud.get(id)).text };
      } catch {
        return { id };
      }
    }),
  );
  return { rewritten, notRewritten: r.notRewritten };
}

/**
 * `oort forget <id> [--yes] [--everywhere]`: deletes a memory everywhere (main record and cold
 * copy). The later memories of its chain that restate it are rewritten to their current fact,
 * locally (CON-144) and by Oort Cloud (CON-161); any left as they were are named, with exit 3. An
 * Oort Cloud that does not rewrite answers without the lists: then the CLI finds the later
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
    let rewrites: Successors | undefined;
    let restating: CloudSuccessors = { restating: [] };
    if (cloud !== undefined) {
      const answer = await cloud.forget(m.id);
      // An Oort Cloud that does not rewrite left the chain as it was: find the later memories
      // that restate it, to name them.
      if (answer === null) restating = await laterRestating(cloud, m);
      else rewrites = await withTexts(cloud, answer);
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
    const reported = local ?? rewrites;
    const complete =
      reported !== undefined
        ? reportSuccessors(ctx, reported)
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
 * following `supersededBy`, for an Oort Cloud that does not rewrite them (it leaves the chain as
 * it was, so this runs after the forget). A lookup that fails ends the walk, and is reported.
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
 * Names each later memory that may still restate the forgotten one in an Oort Cloud that does not
 * rewrite them, and the Constellations it is shared to, and one the walk could not read. True
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
  // As a plain forget: an Oort Cloud that does not rewrite answers without the lists.
  const rewrites = answer.rewrites === null ? undefined : await withTexts(cloud, answer.rewrites);
  const restating: CloudSuccessors =
    rewrites !== undefined || t.memory === null
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
    rewrites !== undefined
      ? reportSuccessors(ctx, rewrites)
      : await reportCloudSuccessors(cloud, restating, ctx);
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
