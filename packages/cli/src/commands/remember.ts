import { FACT_MAX_CHARS, MEMORY_TYPES } from '@oortmem/mcp';
import { resolveHome, scrubObservation, type MemoryType } from '@oortmem/core';
import { turnObservation } from '../engine/observe.js';
import { emit, jsonMode } from '../output.js';
import {
  rememberFacts,
  rememberFactsInCloud,
  rememberTurn,
  type CloudRememberResult,
} from '../remember.js';
import { uiFor } from '../ui.js';
import {
  Refusal,
  agentLabel,
  cloudOf,
  refuseStarInCloud,
  scopeLabel,
  short,
  shown,
  withWired,
  type Ctx,
} from '../util.js';
import { privacyStatement, resolveAgent } from '../wire.js';

export interface RememberOptions {
  /** `--type`: a hint for the kind of fact; the write path decides the final type. */
  type?: string;
  /** `--dry-run`: only report what the scrubber would redact; touches nothing. */
  dryRun?: boolean;
  json?: boolean;
}

/** Line breaks a terminal or a JSON reader may honour: CR, LF, NEL, LS and PS. */
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;

/** The fact as the MCP tool takes one: trimmed, one line, 1 to 500 characters. */
function checkedFact(words: readonly string[]): string {
  const fact = words.join(' ').trim();
  if (fact === '') {
    throw new Refusal(
      'Give the fact to remember, in quotes: oort remember "We deploy on Fridays."',
    );
  }
  if (LINE_BREAK.test(fact)) {
    throw new Refusal('A fact is one line: remember each line on its own.');
  }
  if (fact.length > FACT_MAX_CHARS) {
    throw new Refusal(
      `A fact is at most ${FACT_MAX_CHARS} characters (this one has ${fact.length}): split it into shorter facts.`,
    );
  }
  return fact;
}

function checkedType(raw: string | undefined): MemoryType | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim().toLowerCase();
  if (!(MEMORY_TYPES as readonly string[]).includes(t)) {
    throw new Refusal(
      `--type must be ${MEMORY_TYPES.slice(0, -1).join(', ')} or ${MEMORY_TYPES.at(-1)}.`,
    );
  }
  return t as MemoryType;
}

/** One result as a header detail: `added 1b2c3d4e`, `superseded 1b2c3d4e (replaces 9f8e7d6c)`. */
function said(r: CloudRememberResult): string {
  // Oort Cloud's answer is checked (remember.ts) and still printed through `shown`.
  if (r.outcome === 'skipped') return `skipped (${shown(r.reason ?? 'not durable')})`;
  const id = r.id === undefined ? '' : ` ${shown(short(r.id))}`;
  const replaces = r.supersedes === undefined ? '' : ` (replaces ${shown(short(r.supersedes))})`;
  return `${shown(r.outcome)}${id}${replaces}`;
}

/**
 * `oort remember "<fact>"`: saves a fact the user states, as the MCP `remember` tool and the
 * SDK's `remember()` do: one observation framed as the user's statement, through the write path
 * (scrub, gate, reconcile, writer), as the acting agent on the cwd's project. Words given without
 * quotes are one fact. `--dry-run` only scrubs the framed turn and reports what would be redacted;
 * it opens no store and calls no adapter.
 */
export async function rememberCommand(
  words: readonly string[],
  opts: RememberOptions,
  ctx: Ctx,
): Promise<number> {
  const fact = checkedFact(words);
  const type = checkedType(opts.type);
  const ui = uiFor(ctx.io);
  if (opts.dryRun === true) {
    // The agent id is checked as a real run checks it, without wiring anything.
    resolveAgent(resolveHome(ctx.io.env), ctx.io.env, ctx.agent);
    const turn = rememberTurn(fact, type);
    const s = scrubObservation(turnObservation(turn.user, turn.assistant));
    const detail = s.dropped
      ? 'would not be saved: it is mostly secret'
      : s.redactions.length === 0
        ? 'nothing would be redacted'
        : `would redact ${s.redactions.map((r) => `${r.kind} (${r.count})`).join(', ')}`;
    ctx.io.out(ui.header('remember', 'dry run', detail));
    if (jsonMode(ctx)) emit(ctx, { dryRun: true, dropped: s.dropped, redactions: s.redactions });
    return 0;
  }
  return withWired(ctx, async (w) => {
    const cloud = cloudOf(w);
    let results: CloudRememberResult[];
    if (cloud !== undefined) {
      refuseStarInCloud(w);
      const project = w.scope.projectId;
      results = await rememberFactsInCloud(cloud, [fact], {
        ...(type !== undefined && { type }),
        ...(project !== undefined && { project: { project, ...privacyStatement(w) } }),
      });
    } else {
      results = await rememberFacts(w, [fact], {
        harness: 'cli',
        ...(type !== undefined && { type }),
      });
    }
    ctx.io.out(ui.header('remember', ...results.map(said), scopeLabel(w), agentLabel(w)));
    if (jsonMode(ctx)) emit(ctx, { results });
    return 0;
  });
}
