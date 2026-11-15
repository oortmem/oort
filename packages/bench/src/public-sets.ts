/**
 * Retrieval-level runs of public long-term memory sets (CON-147, design section 11). Each set is
 * read into haystacks: the dialogue turns one store holds, and the questions asked of it with the
 * turns that hold their evidence. Every turn goes through `observe` (with the verbatim controller
 * and writer, so one turn is one memory and no model is called), then every question through
 * `recall`, and the returned memories are mapped back to turns through `turnRef`. Scoring is
 * evidence recall@k, with no judge.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  capObservation,
  localScope,
  observe,
  recall,
  resolveConfig,
  scrubObservation,
  type Embedder,
  type MemoryStore,
  type Observation,
  type Reranker,
  type ResolvedConfig,
} from '@oortmem/core';
import { openSqliteStore } from '@oortmem/store-sqlite';
import {
  computeMetrics,
  gateOf,
  hitScore,
  type EvalReport,
  type EvalRow,
  type RowOutcome,
} from './eval.js';
import { EMBEDDING_DIMENSION } from './generate.js';
import { linksOverride, viaOf, type LinksMode } from './links.js';
import { ALL_SCOPE } from './seed.js';
import { fakeEmbedder } from './fake-embed.js';
import {
  questionResults,
  runLabel,
  type GateThresholds,
  type QuestionResult,
} from './per-question.js';
import { verbatimDecider, verbatimWriter, type EntitySource } from './verbatim.js';

export interface Turn {
  /** Unique within the haystack: what evidence names. */
  turnRef: string;
  sessionId: string;
  /** ISO time of the turn. */
  at: string;
  userText: string;
  assistantText: string;
}

export interface Question {
  id: string;
  question: string;
  /** The report group (a dataset category, or `abstention`). */
  group: string;
  /** Evidence turns. Empty for an abstention question. */
  evidence: string[];
  /** Turns that must not come back as current (an outdated answer, LongMemEval's knowledge-update). */
  stale?: string[];
  /** Sessions holding the answer (LongMemEval), for session-level recall. */
  answerSessions?: string[];
  /** Sessions holding an outdated answer, for session-level stale-leak. */
  staleSessions?: string[];
  abstention?: boolean;
}

export interface Haystack {
  id: string;
  /** Recall's `now`: after the last turn (LoCoMo) or the question's date (LongMemEval). */
  now: string;
  turns: Turn[];
  questions: Question[];
}

export interface PublicSet {
  name: string;
  haystacks: Haystack[];
  /** Report groups in print order. */
  groups: readonly string[];
  /** Evidence references that named no turn, dropped while reading (data errors in the set). */
  droppedEvidence: number;
  /** Questions left out because none of their evidence named a turn. */
  droppedQuestions: number;
}

export const observationOf = (t: Turn): Observation => ({
  userText: t.userText,
  assistantText: t.assistantText,
  toolSummaries: [],
  sessionId: t.sessionId,
  turnRef: t.turnRef,
  at: t.at,
});

/**
 * The observation as `observe` hands it on: scrubbed and capped first, exactly as `observe` does,
 * so what is prefetched for it is what `observe` asks for. Undefined when the scrubber drops it.
 */
export function observedOf(t: Turn): Observation | undefined {
  const s = scrubObservation(observationOf(t));
  return s.dropped ? undefined : capObservation(s.obs);
}

/** The text `observe` embeds for a turn (see `observedOf`). */
export function embedTextOf(t: Turn): string | undefined {
  const obs = observedOf(t);
  return obs === undefined ? undefined : `${obs.userText}\n${obs.assistantText}`;
}

/**
 * `full`: recall reranks when a reranker is given (as `oort recall` and MCP do). `fast`: no
 * reranker, as the prompt hook's default `recall.promptMode` `fast` runs it.
 */
export const SPEEDS = ['full', 'fast'] as const;
export type Speed = (typeof SPEEDS)[number];

export interface RunPublicOptions {
  set: PublicSet;
  /** Recall's query and document embedder; absent: lexical-only recall (fake vectors stored). */
  embed?: Embedder & { prefetch?(texts: string[], kind: 'document'): Promise<void> };
  rerank?: Reranker;
  ks?: number[];
  links?: LinksMode;
  /** `fast` leaves the reranker out, as the prompt hook does (default `full`). */
  speed?: Speed;
  /**
   * Entities for each stored turn (`entities.ts`). Default none, as every earlier run: then no
   * memory names an entity and `about` links never form.
   */
  entities?: { source: EntitySource; prefetch?(observations: Observation[]): Promise<void> };
  /** Apply recall's relevance gate (default true: today's recall). */
  gate?: boolean;
  log?: (message: string) => void;
}

export interface PublicReport {
  set: string;
  haystacks: number;
  turns: number;
  questions: number;
  droppedEvidence: number;
  droppedQuestions: number;
  /** Turns the scrubber dropped (a secret-shaped string), so they hold no memory. */
  scrubbed: number;
  links: LinksMode;
  speed: Speed;
  /** Evidence recall over turns. */
  turn: EvalReport;
  /** Recall over answer sessions: @k counts the sessions of the top k returned turns. */
  session?: EvalReport;
  ms: number;
}

/** A run's totals and its per-question results (`per-question.ts`), turn level then session. */
export interface PublicRun extends PublicReport {
  perQuestion: QuestionResult[];
}

/** Each turn's text, embedded in batches before the turns are observed. */
async function prefetch(set: PublicSet, embed: RunPublicOptions['embed']): Promise<void> {
  if (embed?.prefetch === undefined) return;
  const texts = set.haystacks.flatMap((h) => h.turns.flatMap((t) => embedTextOf(t) ?? []));
  await embed.prefetch(texts, 'document');
}

/**
 * The session of each returned round, in rank order and repeated, so session recall@k reads
 * the sessions of the top k rounds (not the top k distinct sessions, which would reach past
 * rank k).
 */
export function sessionsOfRounds(ids: string[], sessionOf: Map<string, string>): string[] {
  return ids.flatMap((id) => {
    const s = sessionOf.get(id);
    return s === undefined ? [] : [s];
  });
}

/** Each turn's entities, asked for before the turns are observed. */
async function prefetchEntities(set: PublicSet, src: RunPublicOptions['entities']): Promise<void> {
  if (src?.prefetch === undefined) return;
  await src.prefetch(set.haystacks.flatMap((h) => h.turns.flatMap((t) => observedOf(t) ?? [])));
}

export async function runPublicSet(opts: RunPublicOptions): Promise<PublicRun> {
  const { set } = opts;
  const ks = [...new Set([...(opts.ks ?? [5, 10]), 10])].sort((a, b) => a - b);
  const maxK = Math.max(...ks);
  const log = opts.log ?? (() => {});
  const links = opts.links ?? 'off';
  const speed = opts.speed ?? 'full';
  const rerank = speed === 'full' ? opts.rerank : undefined;
  const t0 = performance.now();
  await prefetch(set, opts.embed);
  await prefetchEntities(set, opts.entities);
  const rows: EvalRow[] = [];
  const outcomes: RowOutcome[] = [];
  const groups: string[] = [];
  const ids: string[] = [];
  const sessionRows: EvalRow[] = [];
  const sessionOutcomes: RowOutcome[] = [];
  const sessionGroups: string[] = [];
  const sessionIds: string[] = [];
  let turns = 0;
  let scrubbed = 0;
  let gate: GateThresholds | undefined;
  const docEmbed: Embedder = opts.embed ?? fakeEmbedder(EMBEDDING_DIMENSION);
  for (const [n, h] of set.haystacks.entries()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-public-'));
    try {
      const store = await openSqliteStore({
        path: path.join(dir, 'oort.sqlite'),
        coldDir: path.join(dir, 'cold'),
        dimension: EMBEDDING_DIMENSION,
        log: () => {},
      });
      try {
        const base = resolveConfig(dir, { OORT_HOME: dir }, { projectConfig: false });
        const config = {
          ...base,
          recall: {
            ...base.recall,
            returnK: maxK,
            rerankK: Math.max(base.recall.rerankK, maxK),
            ...(opts.gate === false && { minRerankScore: 0, minCoverage: 0, minDenseScore: 0 }),
            ...linksOverride(links, base),
          },
        } as ResolvedConfig;
        gate = gateOf(config);
        const sessionOf = new Map<string, string>();
        const idOf = new Map<string, string>();
        for (const t of h.turns) {
          const r = await observe(observationOf(t), localScope(), {
            store,
            embed: docEmbed,
            decide: verbatimDecider(),
            write: verbatimWriter(
              opts.entities === undefined ? {} : { entities: opts.entities.source },
            ),
            config,
            now: new Date(t.at),
            harness: 'bench-public',
          });
          if (r.memoryId === undefined) {
            scrubbed++;
            continue;
          }
          turns++;
          sessionOf.set(r.memoryId, t.sessionId);
          idOf.set(t.turnRef, r.memoryId);
        }
        // Questions must not influence each other: no access records, no hydration.
        const frozenStore: MemoryStore = {
          ...store,
          recordAccess: async () => {},
          upsert: async () => {},
        };
        for (const q of h.questions) {
          const r = await recall(
            { text: q.question, scope: ALL_SCOPE },
            {
              store: frozenStore,
              config,
              now: new Date(h.now),
              ...(opts.embed !== undefined && { embed: opts.embed }),
              ...(rerank !== undefined && { rerank }),
            },
          );
          const returned = r.memories.map((m) => m.id);
          const scores = r.memories.map(hitScore);
          const ref = (refs: string[]): string[] =>
            refs.flatMap((x) => {
              const id = idOf.get(x);
              return id === undefined ? [] : [id];
            });
          rows.push({
            question: q.question,
            expectedMemoryIds: q.abstention === true ? [] : ref(q.evidence),
            ...(q.abstention === true && { category: 'abstention' as const }),
            ...(q.stale !== undefined && { notExpectedMemoryIds: ref(q.stale) }),
          });
          outcomes.push({
            ids: returned,
            aboveThreshold: returned.length,
            linked: r.memories.filter((m) => viaOf(m) !== undefined).map((m) => m.id),
            scores,
            ...(r.adaptiveStop !== undefined && { adaptiveStop: true }),
          });
          groups.push(q.group);
          ids.push(q.id);
          if (q.answerSessions !== undefined && q.abstention !== true) {
            const sessions = sessionsOfRounds(returned, sessionOf);
            // The scores of the same rounds, so they stay beside their sessions.
            const sessionScores = scores.filter((_, i) => sessionOf.has(returned[i] as string));
            sessionRows.push({
              question: q.question,
              expectedMemoryIds: q.answerSessions,
              ...(q.staleSessions !== undefined && { notExpectedMemoryIds: q.staleSessions }),
            });
            sessionOutcomes.push({
              ids: sessions,
              aboveThreshold: sessions.length,
              scores: sessionScores,
              ...(r.adaptiveStop !== undefined && { adaptiveStop: true }),
            });
            sessionGroups.push(q.group);
            sessionIds.push(q.id);
          }
        }
      } finally {
        await store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if ((n + 1) % 10 === 0 || n + 1 === set.haystacks.length) {
      log(`${set.name}: ${n + 1} of ${set.haystacks.length} haystacks`);
    }
  }
  const run = runLabel({ links, speed });
  const grouping = (names: string[]) => ({
    of: (_: EvalRow, i: number) => names[i] as string,
    order: set.groups,
  });
  return {
    set: set.name,
    haystacks: set.haystacks.length,
    turns,
    questions: rows.length,
    droppedEvidence: set.droppedEvidence,
    droppedQuestions: set.droppedQuestions,
    scrubbed,
    links,
    speed,
    turn: computeMetrics(rows, outcomes, ks, 0, grouping(groups)),
    ...(sessionRows.length > 0 && {
      session: computeMetrics(sessionRows, sessionOutcomes, ks, 0, grouping(sessionGroups)),
    }),
    ms: performance.now() - t0,
    perQuestion: [
      ...questionResults(rows, outcomes, ks, {
        run,
        level: 'turn',
        ids,
        groups,
        ...(gate !== undefined && { gate }),
      }),
      ...questionResults(sessionRows, sessionOutcomes, ks, {
        run,
        level: 'session',
        ids: sessionIds,
        groups: sessionGroups,
        ...(gate !== undefined && { gate }),
      }),
    ],
  };
}
