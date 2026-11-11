import type { MemoryStore } from '@oortmem/core';
import type { CloudClient } from '../cloud.js';
import type { RecallTarget, TemporalView } from '../engine/recall.js';
import type { Engine, Principal } from '../wire.js';
import { OortUsageError } from './errors.js';
import type { JudgeRole, RecallOptions, Warning } from './types.js';
import { iso } from './validate.js';

/** What every operation takes: the shared engine and this handle's principal (CON-108 §3.1). */
export interface Ctx {
  engine: Engine;
  principal: Principal;
  /** The end user, or null for the person (`self`). */
  user: string | null;
  /**
   * The Oort Cloud client this handle's memory calls use (cloud mode): the engine's, or for an
   * end user the one that sends `Oort-User` (CON-132). whoami and the account's own routes use
   * the engine's.
   */
  cloud?: CloudClient;
  now: () => Date;
  /** The cwd project's own privacy statement, only while the handle reads that project. */
  statedPrivacy: boolean | undefined;
  judge: { role: JudgeRole; operator: string };
  /** Config problems found when the engine was wired (`project-id-untrusted`, …). */
  warnings: readonly Warning[];
}

/** The engine and principal as the shared recall reads them. */
export function target(ctx: Ctx): RecallTarget {
  const e = ctx.engine;
  const cloud = ctx.cloud ?? e.cloud;
  return {
    mode: e.mode,
    config: e.config,
    ...(cloud !== undefined && { cloud }),
    ...(e.cloudProblem !== undefined && { cloudProblem: e.cloudProblem }),
    ...(e.store !== undefined && { store: e.store }),
    ...(e.embed !== undefined && { embed: e.embed }),
    ...(e.rerank !== undefined && { rerank: e.rerank }),
    ...(ctx.statedPrivacy !== undefined && { statedPrivacy: ctx.statedPrivacy }),
    scope: ctx.principal.scope,
    agent: ctx.principal.agent,
    grant: ctx.principal.grant,
  };
}

/** The local store (local mode always has one). */
export function storeOf(ctx: Ctx): MemoryStore {
  const s = ctx.engine.store;
  if (s === undefined) throw new Error('unreachable: local mode without a store');
  return s;
}

/**
 * The recall options as a temporal view, exactly as the MCP server's `viewOf`: `mode` names the
 * view and comes with its own date; without it one date picks the view, and with none
 * `inferTime` decides (false: the current view).
 */
export function viewOf(o: RecallOptions): TemporalView {
  const { mode, asOf, knownAt } = o;
  if (asOf !== undefined && knownAt !== undefined) {
    throw new OortUsageError('Use asOf or knownAt, not both.', { reason: 'invalid-argument' });
  }
  switch (mode) {
    case undefined:
      if (asOf !== undefined) return { mode: 'as-of', asOf: iso(asOf) };
      if (knownAt !== undefined) return { mode: 'known-at', knownAt: iso(knownAt) };
      return o.inferTime === false ? { mode: 'current' } : {};
    case 'as-of':
      if (asOf === undefined)
        throw new OortUsageError('mode "as-of" needs asOf.', { reason: 'invalid-argument' });
      return { mode, asOf: iso(asOf) };
    case 'known-at':
      if (knownAt === undefined)
        throw new OortUsageError('mode "known-at" needs knownAt.', { reason: 'invalid-argument' });
      return { mode, knownAt: iso(knownAt) };
    case 'current':
    case 'history':
      if (asOf !== undefined || knownAt !== undefined) {
        throw new OortUsageError(`mode "${mode}" takes no asOf or knownAt.`, {
          reason: 'invalid-argument',
        });
      }
      return { mode };
  }
}

/** An abort, carried through the error mapping untouched: the caller gets the signal's reason. */
export class Aborted {
  constructor(readonly reason: unknown) {}
}

/**
 * Waits for `work`, or rejects with the signal's reason (wrapped in `Aborted` until the handle
 * unwraps it) as soon as it aborts. Work already sent or started may still land (§4.4): the SDK
 * only stops waiting.
 */
export async function abortable<T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (signal === undefined) return work();
  if (signal.aborted) throw new Aborted(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Aborted(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    work().then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
