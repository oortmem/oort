import { filterFor } from '@oortmem/claude-code';
import {
  ScopeDeniedError,
  isIncludeLevel,
  readableNodes,
  recall,
  type DecisionController,
  type Embedder,
  type Grant,
  type IncludeLevel,
  type MemoryStore,
  type RecallMode,
  type RecallResult,
  type Reranker,
  type ResolvedConfig,
  type Scope,
} from '@oortmem/core';
import { Refusal, cloudOf, echo } from '../util.js';
import { privacyStatement, type Wired, type WiredAgent } from '../wire.js';

/**
 * Recall as the CLI, the MCP server and the SDK share it: no terminal, no colours (CON-108). The
 * commands print; this module only reads.
 */

/** `--include`, checked: known level names, no repeats kept. Undefined: read every level. */
export function includeLevels(raw: string | undefined): IncludeLevel[] | undefined {
  if (raw === undefined) return undefined;
  const names = [...new Set(raw.split(',').map((x) => x.trim().toLowerCase()))].filter(
    (x) => x !== '',
  );
  if (names.length === 0) throw new Refusal('--include needs at least one level.');
  const bad = names.filter((x) => !isIncludeLevel(x));
  if (bad.length > 0) {
    throw new Refusal(
      `--include: unknown level ${echo(bad[0]!)}; expected self, planet, star, constellation or galaxy.`,
    );
  }
  return names as IncludeLevel[];
}

/** The temporal flags `recall` and `explain` share (CON-34). One view at a time. */
export interface TemporalFlags {
  asOf?: string;
  knownAt?: string;
  history?: boolean;
}

/** What `runRecall` passes on: an explicit view, or nothing (the query decides). */
export interface TemporalView {
  mode?: RecallMode;
  asOf?: string;
  knownAt?: string;
}

/** Checks the flags; dates are validated without echoing them (they are free text). */
export function temporalView(f: TemporalFlags): TemporalView {
  const set = [f.asOf !== undefined, f.knownAt !== undefined, f.history === true].filter(Boolean);
  if (set.length > 1) throw new Refusal('Use one of --as-of, --known-at and --history.');
  if (f.asOf !== undefined) {
    if (Number.isNaN(Date.parse(f.asOf))) {
      throw new Refusal('--as-of is not an ISO date or timestamp.');
    }
    return { mode: 'as-of', asOf: new Date(f.asOf).toISOString() };
  }
  if (f.knownAt !== undefined) {
    if (Number.isNaN(Date.parse(f.knownAt))) {
      throw new Refusal('--known-at is not an ISO date or timestamp.');
    }
    return { mode: 'known-at', knownAt: new Date(f.knownAt).toISOString() };
  }
  return f.history === true ? { mode: 'history' } : {};
}

/**
 * True when a view was asked for explicitly but the result reports none: a backend (an older
 * cloud API) that ignores time modes. The results are then probably current facts.
 */
export function viewIgnored(view: TemporalView, r: RecallResult): boolean {
  return view.mode !== undefined && r.temporal === undefined;
}

/** The warning for `viewIgnored` (stderr, and `time-mode-unreported` in `--json`). */
export function viewIgnoredWarning(view: TemporalView): string {
  return `the store did not report the time mode, so "${view.mode}" may not have been applied; these may be current facts.`;
}

/** The temporal view in a few words: `current`, `as-of 2026-04-01`. */
export function timeMode(t: RecallResult['temporal']): string {
  // A backend that reports no view (an older cloud API) gets no claim either way.
  if (t === undefined) return 'not reported';
  const at = t.asOf ?? t.knownAt;
  return at === undefined ? t.mode : `${t.mode} ${at.slice(0, 10)}`;
}

/**
 * What a recall needs: the engine (store or cloud client, config, adapters) and the principal
 * (scope, agent, and optionally the grant to read with). `Wired` is one.
 */
export interface RecallTarget extends Pick<
  Wired,
  'mode' | 'cloud' | 'cloudProblem' | 'statedPrivacy'
> {
  config: ResolvedConfig;
  store?: MemoryStore;
  embed?: Embedder;
  rerank?: Reranker;
  /** Answers the adaptive stop's question on a full recall (CON-17); the rule decides otherwise. */
  decide?: DecisionController;
  scope: Scope;
  agent: WiredAgent;
  /** The principal's grant; default the agent's local grant for `scope` (`filterFor`). */
  grant?: Grant;
}

/** How much of the model pipeline a recall uses: everything, no rerank, or no model at all. */
export type RecallSpeed = 'full' | 'fast' | 'lexical';

/** The speeds, as `--speed` and the SDK's `speed` take them. */
export const RECALL_SPEEDS: readonly RecallSpeed[] = ['full', 'fast', 'lexical'];

/** Degradations the caller chose (`speed`) are not reported as degradations. */
export function chosenDegradations<T extends string>(
  degraded: readonly T[],
  speed: RecallSpeed,
): T[] {
  return degraded.filter(
    (d) =>
      !(speed !== 'full' && d === 'no-reranker') && !(speed === 'lexical' && d === 'no-embedder'),
  );
}

/**
 * Recall for the scope's project plus global memories, as `w.agent`: the person's Planet and this
 * agent's own Star (`include` narrows it); lexical-only without a Voyage key. A level the agent
 * cannot read is a refusal (`scope_denied`), not an empty answer. `opts.k` caps the results
 * (default: the config's, 10 in cloud mode) and `opts.speed` skips stages.
 */
export async function runRecall(
  w: RecallTarget,
  text: string,
  view: TemporalView,
  now: Date,
  include?: IncludeLevel[],
  includeWithdrawn = false,
  opts: { k?: number; speed?: RecallSpeed } = {},
): Promise<RecallResult> {
  const speed = opts.speed ?? 'full';
  const cloud = cloudOf(w);
  if (cloud !== undefined) {
    // Oort Cloud reads the account's Planet and, in the hive beta, its Constellations; `include`
    // narrows that, and a level the account cannot read is the API's own scope_denied.
    // The cloud API reads the same three fields; an older API ignores mode and knownAt.
    return cloud.recall({
      text,
      ...(w.scope.projectId !== undefined && {
        project: w.scope.projectId,
        ...privacyStatement(w),
      }),
      ...(include !== undefined && { include }),
      // A named agent reads only the Constellations it is attached to (CON-64).
      ...(w.agent.source !== 'none' && { agent: w.agent.id }),
      ...view,
      k: opts.k ?? 10,
      ...(speed !== 'full' && { rerank: false }),
      ...(speed === 'lexical' && { embed: false }),
    });
  }
  if (w.store === undefined) throw new Error('unreachable: a local recall without a store');
  const config =
    opts.k === undefined
      ? w.config
      : { ...w.config, recall: { ...w.config.recall, returnK: opts.k } };
  try {
    return await recall(
      {
        text,
        ...(w.grant !== undefined
          ? { grant: w.grant }
          : { scope: filterFor(w.scope), home: w.agent.home }),
        ...(include !== undefined && { include }),
        ...view,
        ...(includeWithdrawn && { includeWithdrawn: true }),
      },
      {
        store: w.store,
        config,
        now,
        ...(w.embed !== undefined && speed !== 'lexical' && { embed: w.embed }),
        ...(w.rerank !== undefined && speed === 'full' && { rerank: w.rerank }),
        ...(w.decide !== undefined && speed === 'full' && { decide: w.decide }),
      },
    );
  } catch (e) {
    if (e instanceof ScopeDeniedError) {
      // The CLI's grant is always the Planet and the agent's own Star; a principal's grant (the
      // SDK's end users) may be narrower, so say what it really reads.
      const reads =
        w.grant === undefined
          ? 'it reads your Planet and its own Star'
          : `this handle reads only ${readableNodes(w.grant)
              .map((n) =>
                n.level === 'user' ? 'its Planet' : n.level === 'agent' ? 'its Star' : n.level,
              )
              .join(' and ')}`;
      throw new Refusal(
        `scope_denied: ${w.agent.id} cannot read ${e.levels.join(', ')} (${reads}).`,
        { code: 'refused' },
      );
    }
    throw e;
  }
}
