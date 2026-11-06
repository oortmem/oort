import { observe, type Grant, type MemoryType, type Scope } from '@oortmem/core';
import type { CloudClient } from './cloud.js';
import { turnObservation } from './engine/observe.js';
import { writePath } from './util.js';
import type { Wired } from './wire.js';
import { grantFor } from '@oortmem/claude-code';

/**
 * A fact as the turn the write path observes: the user's own statement ("Remember this: …"),
 * acknowledged by the assistant ("Noted: …"), so the gate and the writer treat it as user-stated
 * rather than as a suggestion. The one framing the MCP `remember` tool, the SDK's `remember()` and
 * `oort remember` share, locally and in Oort Cloud.
 */
export function rememberTurn(fact: string, type?: MemoryType): { user: string; assistant: string } {
  const hint = type === undefined ? '' : ` (a ${type} fact)`;
  return { user: `Remember this${hint}: ${fact}`, assistant: `Noted: ${fact}` };
}

export interface RememberResult {
  /** The fact's position in the request, from 0. */
  fact: number;
  outcome: 'added' | 'reinforced' | 'updated' | 'superseded' | 'corrected' | 'skipped';
  /** The memory written, rewritten or reinforced. */
  id?: string;
  /**
   * For `superseded`: the memory the new one replaced (kept, with its validity closed). For
   * `corrected`: the memory found wrong (kept for `known-at` reads, retracted everywhere else).
   */
  supersedes?: string;
  /** For `skipped`: `secret`, `not durable`, or the write path's own reason. */
  reason?: string;
}

/**
 * Saves facts the user stated or confirmed, one observation each, through the
 * normal write path (scrub, gate, reconcile, writer). A fact is framed as the
 * user's own statement, acknowledged by the assistant, so the gate and the
 * writer treat it as user-stated rather than as a suggestion. Refuses (a
 * `Refusal`) when the embed, decide or write adapter is missing.
 */
export async function rememberFacts(
  w: Pick<
    Wired,
    | 'store'
    | 'config'
    | 'scope'
    | 'agent'
    | 'embed'
    | 'decide'
    | 'write'
    | 'unavailable'
    | 'keyStore'
  >,
  facts: readonly string[],
  opts: {
    harness: string;
    scope?: Scope;
    type?: MemoryType;
    now?: Date;
    /** The grant to read and write with (the SDK's principal); default the scope's local grant. */
    grant?: Grant;
  },
): Promise<RememberResult[]> {
  const adapters = writePath(w, 'remember');
  const scope = opts.scope ?? w.scope;
  const results: RememberResult[] = [];
  for (const [i, fact] of facts.entries()) {
    const at = (opts.now ?? new Date()).toISOString();
    const turn = rememberTurn(fact, opts.type);
    const obs = turnObservation(turn.user, turn.assistant, at);
    const r = await observe({ ...obs, turnRef: `remember:${i}` }, scope, {
      store: w.store,
      ...adapters,
      config: w.config,
      harness: opts.harness,
      home: w.agent.home,
      ...(opts.now !== undefined && { now: opts.now }),
      ...(opts.grant !== undefined && { grant: opts.grant }),
    });
    const out: RememberResult = { fact: i, outcome: r.outcome };
    if (r.memoryId !== undefined) out.id = r.memoryId;
    if ((r.outcome === 'superseded' || r.outcome === 'corrected') && r.memoryId !== undefined) {
      const prior = (await w.store.get(opts.grant ?? grantFor(w.scope), r.memoryId))?.supersedes;
      if (prior !== null && prior !== undefined) out.supersedes = prior;
    }
    if (r.outcome === 'skipped') out.reason = r.reason ?? 'not durable';
    results.push(out);
  }
  return results;
}

/**
 * The same in Oort Cloud: one observe per fact, framed as `rememberTurn` frames it, for the
 * project `project` names (with its privacy statement). A `skipped` fact's reason is `not durable`:
 * the API does not say more.
 */
export async function rememberFactsInCloud(
  client: Pick<CloudClient, 'observe'>,
  facts: readonly string[],
  opts: {
    type?: MemoryType;
    now?: () => Date;
    project?: { project: string; projectPrivate?: boolean };
  },
): Promise<RememberResult[]> {
  const results: RememberResult[] = [];
  for (const [i, fact] of facts.entries()) {
    const r = await client.observe({
      ...opts.project,
      observation: {
        ...rememberTurn(fact, opts.type),
        at: (opts.now?.() ?? new Date()).toISOString(),
      },
    });
    const first = r.memories[0];
    results.push({
      fact: i,
      outcome: r.outcome as RememberResult['outcome'],
      ...(first?.id !== undefined && { id: first.id }),
      ...(r.outcome === 'skipped' && { reason: 'not durable' }),
    });
  }
  return results;
}
