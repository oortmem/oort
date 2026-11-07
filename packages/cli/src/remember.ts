import { observe, type Grant, type MemoryType, type Scope } from '@oortmem/core';
import { createHash } from 'node:crypto';
import type { CloudClient } from './cloud.js';
import { scrubForCloud } from './cloud-scrub.js';
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

/** Every outcome the write path reports; anything else Oort Cloud says is `unknown`. */
export const REMEMBER_OUTCOMES: readonly RememberResult['outcome'][] = [
  'added',
  'reinforced',
  'updated',
  'superseded',
  'corrected',
  'skipped',
];

/** A memory id as Oort Cloud issues them: a UUID. */
const MEMORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A cloud remember's result: as `RememberResult`, with `unknown` for an outcome Oort never reports. */
export type CloudRememberResult = Omit<RememberResult, 'outcome'> & {
  outcome: RememberResult['outcome'] | 'unknown';
};

/**
 * The `turnRef` a cloud remember sends, so a retry after a lost response is a duplicate, not a
 * second save: the project, the type hint and the scrubbed fact, hashed, and the UTC day. A
 * fact stated again on a later day is observed again (and reinforced).
 */
export function rememberTurnRef(
  fact: string,
  type: MemoryType | undefined,
  project: string | undefined,
  at: string,
): string {
  const h = createHash('sha256')
    .update(`${project ?? ''}\n${type ?? ''}\n${fact}`)
    .digest('hex');
  return `remember:${h}:${at.slice(0, 10)}`;
}

/**
 * The observe request for one fact bound for Oort Cloud: framed as `rememberTurn` frames it,
 * scrubbed on this machine (`scrubForCloud`), with a stable `turnRef`. `dropped`: the fact is
 * mostly secret, and nothing may be sent.
 */
export function cloudRememberRequest(
  fact: string,
  opts: {
    type?: MemoryType | undefined;
    at: string;
    project?: { project?: string; projectPrivate?: boolean };
  },
): { dropped: true } | { dropped: false; body: Parameters<CloudClient['observe']>[0] } {
  const s = scrubForCloud({ ...rememberTurn(fact, opts.type), at: opts.at });
  if (s.dropped) return { dropped: true };
  // The scrubbed fact, as the turn now carries it after "Noted: ".
  const clean = s.turn.assistant.slice('Noted: '.length);
  return {
    dropped: false,
    body: {
      ...opts.project,
      turnRef: rememberTurnRef(clean, opts.type, opts.project?.project, opts.at),
      observation: s.turn,
    },
  };
}

/**
 * The same in Oort Cloud: one observe per fact (`cloudRememberRequest`), for the project
 * `project` names (with its privacy statement). A fact that is mostly secret is `skipped` with
 * reason `secret` and never sent. The answer is checked: an outcome Oort never reports is
 * `unknown`, an id that is not a UUID is left out. A `skipped` fact's reason is otherwise `not
 * durable`: the API does not say more.
 */
export async function rememberFactsInCloud(
  client: Pick<CloudClient, 'observe'>,
  facts: readonly string[],
  opts: {
    type?: MemoryType;
    now?: () => Date;
    project?: { project: string; projectPrivate?: boolean };
  },
): Promise<CloudRememberResult[]> {
  const results: CloudRememberResult[] = [];
  for (const [i, fact] of facts.entries()) {
    const req = cloudRememberRequest(fact, {
      type: opts.type,
      at: (opts.now?.() ?? new Date()).toISOString(),
      ...(opts.project !== undefined && { project: opts.project }),
    });
    if (req.dropped) {
      results.push({ fact: i, outcome: 'skipped', reason: 'secret' });
      continue;
    }
    const r = await client.observe(req.body);
    const id = r.memories[0]?.id;
    const outcome = (REMEMBER_OUTCOMES as readonly string[]).includes(r.outcome)
      ? (r.outcome as RememberResult['outcome'])
      : 'unknown';
    results.push({
      fact: i,
      outcome,
      ...(typeof id === 'string' && MEMORY_ID.test(id) && { id }),
      ...(outcome === 'skipped' && { reason: 'not durable' }),
    });
  }
  return results;
}
