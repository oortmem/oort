/**
 * Link-shaped synthetic memories for the links latency bar (CON-146, design section 11): what a
 * gather step has to work with at 100k and 1M memories.
 *
 * - Sessions, written in turn order. Session lengths follow a Zipf law (most sessions are a few
 *   turns, a few run to hundreds), and about one turn in five splits into two or three facts that
 *   share a `turnRef` (CON-56), so `episode` has neighbours and same-turn facts.
 * - Entities drawn from a Zipf law over a vocabulary of `n / 10` names, so a few are hubs ("the
 *   repo") that `about` must spread nothing from, and most are a long tail of specific names.
 *   Within a session, most entities come from the session's own few topics.
 * - Streamed: `linkedBatches` yields batches and never holds the whole set, so a million memories
 *   fit in a bench process.
 *
 * The same `(n, seed)` always yields the same memories. Bump `LINKED_GENERATOR_VERSION` on any
 * change to what is generated: cached stores are keyed by it.
 */
import { localScope, tokenizeLexical, type Memory, type ObservedMemoryType } from '@oortmem/core';
import { fakeEmbedding } from './fake-embed.js';
import { EMBEDDING_DIMENSION, GENERATOR_NOW, PROJECTS } from './generate.js';
import { createRng, type Rng } from './prng.js';

export const LINKED_GENERATOR_VERSION = 1;

const DAY_MS = 86_400_000;

/** Zipf exponents: entity popularity, and session length. */
const ENTITY_S = 1.0;
const SESSION_S = 1.3;
const MAX_SESSION = 400;
/** The share of a session's entity draws that come from its own topics. */
const TOPIC_SHARE = 0.7;
const TOPICS_PER_SESSION = 3;

/** Names for the most popular entities, so hubs read like the ones a real store has. */
const HUB_NAMES = [
  'oort',
  'main',
  'ci',
  'auth-service',
  'billing-api',
  'postgres',
  'pnpm',
  'vitest',
  'staging',
  'docker',
  'search-gateway',
  'redis',
  'github-actions',
  'typescript',
  'ingest-worker',
  'zod',
];
const TAIL_PREFIXES = ['svc', 'lib', 'tbl', 'job', 'flag', 'repo', 'env', 'queue', 'host', 'bug'];

/** The entity of a popularity rank (0 is the most popular). */
export function entityName(rank: number): string {
  if (rank < HUB_NAMES.length) return HUB_NAMES[rank] as string;
  return `${TAIL_PREFIXES[rank % TAIL_PREFIXES.length]}-${rank.toString(36)}`;
}

/** A sampler of ranks 0..n-1 with probability proportional to 1 / (rank + 1)^s. */
export function zipf(n: number, s: number): (rng: Rng) => number {
  const cdf = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += 1 / (i + 1) ** s;
    cdf[i] = total;
  }
  return (rng) => {
    const x = rng.next() * total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((cdf[mid] as number) < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

const VERBS = [
  'now depends on',
  'was moved next to',
  'reads its settings from',
  'times out when calling',
  'replaced',
  'is deployed together with',
  'logs every request to',
  'was split out of',
  'caches results from',
  'pins the version of',
];
const FACTS = [
  'The change landed after review.',
  'Tests were green on the second run.',
  'It needs a follow-up next sprint.',
  'Nobody else touches that code path.',
  'The runbook was updated to match.',
  'Rollback is a single revert.',
  'Metrics stayed flat afterwards.',
  'A flag guards the new behaviour.',
];
const TYPE_WEIGHTS: [ObservedMemoryType, number][] = [
  ['semantic', 0.4],
  ['episodic', 0.35],
  ['procedural', 0.15],
  ['preference', 0.1],
];

function pickType(rng: Rng): ObservedMemoryType {
  let x = rng.next();
  for (const [t, w] of TYPE_WEIGHTS) {
    if (x < w) return t;
    x -= w;
  }
  return 'semantic';
}

export interface LinkedOptions {
  now?: Date;
  /** Distinct entity names (default `max(1,000, n / 10)`). */
  vocabulary?: number;
}

/** What `linkedBatches` saw, for the cached store's manifest. */
export interface LinkedStats {
  memories: number;
  sessions: number;
  /** Turns (distinct `turnRef`s); `memories - turns` facts share a turn with another. */
  turns: number;
  longestSession: number;
  /** Distinct entities used, and the memories naming the most popular ones. */
  entities: number;
  topEntities: [string, number][];
  /** Entities named by 50 or more memories: hubs that spread nothing at `F_max = 50`. */
  hubs: number;
  /** Median number of memories per entity. */
  medianFan: number;
}

/**
 * `n` link-shaped memories in batches of `batch`, in write order: session by session, turns in
 * order. `onStats` receives the totals once the last batch is out.
 */
export function* linkedBatches(
  n: number,
  seed: number,
  batch = 1000,
  opts: LinkedOptions & { onStats?: (s: LinkedStats) => void } = {},
): Generator<Memory[]> {
  const now = opts.now ?? GENERATOR_NOW;
  const rng = createRng(seed ^ 0x51ed270b);
  const vocabulary = opts.vocabulary ?? Math.max(1000, Math.floor(n / 10));
  const entityRank = zipf(vocabulary, ENTITY_S);
  const sessionLength = zipf(MAX_SESSION, SESSION_S);
  const fan = new Uint32Array(vocabulary);
  const stats = { sessions: 0, turns: 0, longestSession: 0 };
  let out: Memory[] = [];
  let made = 0;
  while (made < n) {
    const session = `ls${seed}-${stats.sessions++}`;
    const length = Math.min(sessionLength(rng) + 1, n - made);
    stats.longestSession = Math.max(stats.longestSession, length);
    const topics = Array.from({ length: TOPICS_PER_SESSION }, () => entityRank(rng));
    const projectIdx = rng.int(PROJECTS.length + 1);
    const projectId = projectIdx === PROJECTS.length ? undefined : PROJECTS[projectIdx];
    let at = now.getTime() - rng.next() * 365 * DAY_MS;
    let written = 0;
    for (let turn = 1; written < length; turn++) {
      stats.turns++;
      at += (1 + rng.int(5)) * 60_000;
      const facts = Math.min(rng.next() < 0.2 ? 2 + rng.int(2) : 1, length - written);
      for (let f = 0; f < facts; f++) {
        const ranks = new Set<number>();
        const want = 1 + rng.int(3);
        while (ranks.size < want) {
          ranks.add(rng.next() < TOPIC_SHARE ? (rng.pick(topics) as number) : entityRank(rng));
        }
        for (const r of ranks) fan[r] = (fan[r] ?? 0) + 1;
        out.push(
          linkedMemory(rng, `l${seed}-${made}`, [...ranks].map(entityName), {
            at: new Date(at + f),
            now,
            session,
            turnRef: `t${turn}`,
            projectId,
          }),
        );
        made++;
        written++;
        if (out.length === batch) {
          yield out;
          out = [];
        }
      }
    }
  }
  if (out.length > 0) yield out;
  if (opts.onStats !== undefined) {
    const used = [...fan].filter((c) => c > 0).sort((a, b) => a - b);
    const ranked = [...fan.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    opts.onStats({
      memories: made,
      ...stats,
      entities: used.length,
      topEntities: ranked.map(([r, c]) => [entityName(r), c]),
      hubs: used.filter((c) => c >= 50).length,
      medianFan: used[Math.floor(used.length / 2)] ?? 0,
    });
  }
}

function linkedMemory(
  rng: Rng,
  id: string,
  entities: string[],
  ctx: { at: Date; now: Date; session: string; turnRef: string; projectId: string | undefined },
): Memory {
  const [a, b] = [entities[0] as string, entities[1] ?? 'the shared config'];
  let text = `${a} ${rng.pick(VERBS)} ${b}.`;
  if (entities.length > 2) text += ` See also ${entities.slice(2).join(', ')}.`;
  const target = rng.range(60, 400);
  for (let tries = 0; tries < 12 && text.length < target; tries++) text += ` ${rng.pick(FACTS)}`;
  text = text.slice(0, 500);
  const iso = ctx.at.toISOString();
  const span = Math.max(ctx.now.getTime() - ctx.at.getTime(), 0);
  const count = Math.floor(rng.next() ** 2 * 6);
  const recent = Array.from({ length: count }, () =>
    new Date(ctx.now.getTime() - rng.next() * span).toISOString(),
  ).sort();
  return {
    id,
    scope: localScope(ctx.projectId),
    type: pickType(rng),
    text,
    stub: text.length <= 80 ? text : `${text.slice(0, 77).trimEnd()}...`,
    entities,
    salience: Math.round((0.1 + rng.next() * 0.9) * 1000) / 1000,
    pinned: rng.next() < 0.02,
    tier: 'warm',
    accessLog: { count, recent, compactedSum: 0, compactedAt: null },
    validFrom: iso,
    validTo: null,
    expiredAt: null,
    endReason: null,
    lastConfirmedAt: null,
    supersedes: null,
    supersededBy: null,
    source: { harness: 'synthetic', sessionId: ctx.session, turnRef: ctx.turnRef, decisions: [] },
    embedding: fakeEmbedding(text, EMBEDDING_DIMENSION),
    createdAt: iso,
    updatedAt: iso,
  };
}

/**
 * A search-style query for a memory: its entities and one or two other distinctive words, the
 * way an agent asks about a named thing. The entities are what the gather step expands from.
 */
export function linkedQuery(m: Memory, rng: Rng): string {
  const words = [...new Set(tokenizeLexical(m.text))].filter(
    (t) => t.length >= 5 && !m.entities.includes(t),
  );
  const extra = rng.shuffle(words).slice(0, 1 + rng.int(2));
  return [...m.entities.slice(0, 2), ...extra].join(' ');
}

/**
 * Up to `size` memories drawn uniformly from the stream (reservoir sampling), to make queries
 * from without holding the stream.
 */
export function reservoir(
  size: number,
  seed: number,
): {
  offer(ms: Memory[]): void;
  sample(): Memory[];
} {
  const rng = createRng(seed ^ 0x2545f491);
  const kept: Memory[] = [];
  let seen = 0;
  return {
    offer(ms) {
      for (const m of ms) {
        seen++;
        if (kept.length < size) kept.push(m);
        else {
          const j = rng.int(seen);
          if (j < size) kept[j] = m;
        }
      }
    },
    sample: () => kept,
  };
}
