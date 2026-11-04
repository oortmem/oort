import { observe, type MemoryType, type Scope } from '@oortmem/core';
import { turnObservation } from './commands/observe.js';
import { writePath } from './util.js';
import type { Wired } from './wire.js';
import { grantFor } from '@oortmem/claude-code';

export { FACT_MAX_CHARS, REMEMBER_MAX_FACTS } from '@oortmem/mcp';

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
  w: Wired,
  facts: readonly string[],
  opts: { harness: string; scope?: Scope; type?: MemoryType; now?: Date },
): Promise<RememberResult[]> {
  const adapters = writePath(w, 'remember');
  const scope = opts.scope ?? w.scope;
  const hint = opts.type === undefined ? '' : ` (a ${opts.type} fact)`;
  const results: RememberResult[] = [];
  for (const [i, fact] of facts.entries()) {
    const at = (opts.now ?? new Date()).toISOString();
    const obs = turnObservation(`Remember this${hint}: ${fact}`, `Noted: ${fact}`, at);
    const r = await observe({ ...obs, turnRef: `remember:${i}` }, scope, {
      store: w.store,
      ...adapters,
      config: w.config,
      harness: opts.harness,
      ...(opts.now !== undefined && { now: opts.now }),
    });
    const out: RememberResult = { fact: i, outcome: r.outcome };
    if (r.memoryId !== undefined) out.id = r.memoryId;
    if ((r.outcome === 'superseded' || r.outcome === 'corrected') && r.memoryId !== undefined) {
      const prior = (await w.store.get(grantFor(w.scope), r.memoryId))?.supersedes;
      if (prior !== null && prior !== undefined) out.supersedes = prior;
    }
    if (r.outcome === 'skipped') out.reason = r.reason ?? 'not durable';
    results.push(out);
  }
  return results;
}
