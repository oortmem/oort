import { localScope, tokenizeLexical, type Memory, type MemoryType } from '@oortmem/core';
import type { EvalRow } from './eval.js';
import { fakeEmbedding } from './fake-embed.js';
import { EMBEDDING_DIMENSION, GENERATOR_NOW, generateMemories } from './generate.js';
import { createRng } from './prng.js';

/**
 * The demo store: `generateMemories(FIXTURE_COUNT, FIXTURE_SEED)` plus the multi-hop memories
 * (`demoMemories()`).
 */
export const FIXTURE_SEED = 7;
export const FIXTURE_COUNT = 1500;

const DAY_MS = 86_400_000;

/**
 * Abstention queries made of ordinary words that the corpus uses ("service",
 * "the", "for", "team") but about things it never mentions. A lexical any-token
 * match returns something for each, so these measure the false-positive rate
 * honestly instead of using nonsense words.
 */
const ABSTAIN = [
  'auth service rollback plan for the billing team',
  'who approved the quarterly budget for the search gateway',
  'the incident escalation policy for the notify relay',
  'media proxy vendor contract renewal for the legal team',
];

const SYNONYMS: Record<string, string> = {
  listens: 'serves',
  installs: 'fetches',
  dependencies: 'packages',
  failed: 'broke',
  rolled: 'reverted',
  refactored: 'reworked',
  prefers: 'likes',
  deploy: 'release',
  tests: 'checks',
  configured: 'wired',
  development: 'dev',
  integration: 'end-to-end',
  decision: 'choice',
};

/** A query in other words: numeric/path-like tokens dropped, some synonyms swapped, word order reversed. */
function paraphrase(stub: string): string {
  return stub
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9._/-]/g, ''))
    .filter((w) => w.length >= 3 && !/[0-9./_-]/.test(w))
    .map((w) => SYNONYMS[w] ?? w)
    .reverse()
    .slice(0, 6)
    .join(' ');
}

/**
 * The question about a chain's current (or as-of) value. It names the subject as the memories
 * do (`auth-service-3`): several chains share a service name, so "the auth service" alone has
 * no single answer.
 */
function chainQuestion(tail: Memory, subject: string, when: string): string {
  if (tail.text.includes('listens on port')) return `which port does ${subject} listen on ${when}`;
  if (tail.text.includes('installs dependencies'))
    return `which package manager does ${subject} use ${when}`;
  return `which library does ${subject} use to validate requests ${when}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `2026-04-02T…` as "2 April 2026", the way a person writes a date. */
const spoken = (d: Date): string =>
  `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

/** A LongMemEval-style temporal question: the date is in the words, with no `asOf`. */
function datedQuestion(tail: Memory, subject: string, day: string): string {
  if (tail.text.includes('listens on port'))
    return `on ${day}, which port did ${subject} listen on`;
  if (tail.text.includes('installs dependencies'))
    return `which package manager did ${subject} install dependencies with on ${day}`;
  return `which library did ${subject} validate requests with on ${day}`;
}

/** How a chain's value changed: every version is expected. */
function historyQuestion(tail: Memory, subject: string): string {
  if (tail.text.includes('listens on port'))
    return `how has the port of ${subject} changed over time`;
  if (tail.text.includes('installs dependencies'))
    return `how has the package manager of ${subject} changed over time`;
  return `how has the request validation library of ${subject} changed over time`;
}

/**
 * The 23 demo rows over the synthetic store: 6 single-fact (exact, partial and
 * paraphrased), 4 knowledge-update, 6 temporal (3 with an explicit `asOf`, 2 with the
 * date in the question and 1 asking for the history), 3 multi-session and 4 abstention.
 * A smoke test of the eval pipeline, not a quality benchmark. Deterministic for a given
 * memory list.
 */
export function buildFixtureRows(memories: Memory[]): EvalRow[] {
  const rng = createRng(FIXTURE_SEED);
  const rows: EvalRow[] = [];
  const byId = new Map(memories.map((m) => [m.id, m]));
  const inChain = (m: Memory): boolean => m.supersedes !== null || m.supersededBy !== null;

  const df = new Map<string, number>();
  const tokensOf = (m: Memory): string[] => [...new Set(tokenizeLexical(m.text))];
  for (const m of memories) for (const t of tokensOf(m)) df.set(t, (df.get(t) ?? 0) + 1);

  const shuffled = <T>(xs: T[]): T[] => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [a[i], a[j]] = [a[j] as T, a[i] as T];
    }
    return a;
  };

  // single-fact: the four rarest words of a plain semantic memory.
  const rareTokens = (m: Memory): string[] =>
    tokensOf(m)
      .filter((t) => t.length >= 4)
      .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || (a < b ? -1 : 1));
  // Only memories with a near-unique word can be asked about unambiguously.
  const plain = shuffled(
    memories.filter(
      (m) => m.type === 'semantic' && !inChain(m) && (df.get(rareTokens(m)[0] ?? '') ?? 99) <= 2,
    ),
  );
  // single-fact: 2 exact (the four rarest words), 2 partial (the rarest word plus the 3rd and
  // 4th rarest, skipping the 2nd) and 2 reworded (a reversed, synonym-swapped stub that still
  // keeps plain words like library names). Every question has exactly one lexical answer, and
  // that memory is lexical rank 1: these rows are a lexical regression guard (fusion must never
  // demote a lexical top hit out of the top 5). They do not measure paraphrase or dense recall;
  // that needs real embeddings (CON-45, Phase 2).
  const loose = shuffled(
    memories.filter((m) => m.type === 'semantic' && !inChain(m) && !plain.includes(m)),
  );
  // A question is answerable when exactly one memory (the expected one) has every question token.
  const uniqueAnswer = (question: string, expected: Memory): boolean => {
    const qt = new Set(tokenizeLexical(question));
    if (qt.size === 0) return false;
    let hits = 0;
    for (const m of memories) {
      const have = new Set(tokenizeLexical(m.text));
      if ([...qt].every((t) => have.has(t))) {
        if (m.id !== expected.id) return false;
        hits++;
      }
    }
    return hits === 1;
  };
  const exactQ = (m: Memory): string => rareTokens(m).slice(0, 4).join(' ');
  // The rarest word, a different one left out (the 2nd rarest), then the 3rd and 4th.
  const partialQ = (m: Memory): string => {
    const r = rareTokens(m);
    return [r[0], r[2], r[3]].filter((t) => t !== undefined).join(' ');
  };
  const pick = (
    pool: Memory[],
    n: number,
    question: (m: Memory) => string,
    used: Set<string>,
  ): { m: Memory; q: string }[] => {
    const out: { m: Memory; q: string }[] = [];
    for (const m of pool) {
      if (out.length === n) break;
      if (used.has(m.id)) continue;
      const q = question(m);
      if (uniqueAnswer(q, m)) {
        out.push({ m, q });
        used.add(m.id);
      }
    }
    return out;
  };
  const used = new Set<string>();
  const need = (found: { m: Memory; q: string }[], n: number) => {
    if (found.length < n) throw new Error('fixture: not enough uniquely answerable memories');
    return found;
  };
  const exact = need(pick(plain, 2, exactQ, used), 2);
  const partial = need(pick(plain, 2, partialQ, used), 2);
  const reworded = pick(loose, 2, (m) => paraphrase(m.stub), used);
  if (reworded.length < 2)
    throw new Error(
      `fixture: only ${reworded.length} of 2 reworded questions have a unique answer`,
    );
  for (const { m, q } of [...exact, ...partial, ...reworded]) {
    rows.push({ question: q, expectedMemoryIds: [m.id], category: 'single-fact' });
  }

  // chains: heads (no `supersedes`) lead to the current tail.
  const heads = shuffled(memories.filter((m) => m.supersedes === null && m.supersededBy !== null));
  const chainOf = (head: Memory): Memory[] => {
    const out = [head];
    for (let m = head; m.supersededBy !== null;) {
      const next = byId.get(m.supersededBy);
      if (next === undefined) break;
      out.push(next);
      m = next;
    }
    return out;
  };

  // knowledge-update: the current version, never the superseded ones.
  for (const head of heads.slice(0, 4)) {
    const chain = chainOf(head);
    const tail = chain[chain.length - 1] as Memory;
    rows.push({
      question: chainQuestion(tail, head.entities[0] ?? '', 'now'),
      expectedMemoryIds: [tail.id],
      notExpectedMemoryIds: chain.slice(0, -1).map((m) => m.id),
      category: 'knowledge-update',
    });
  }

  // temporal: what was true a day after the middle version took effect.
  for (const head of heads.slice(4, 7)) {
    const chain = chainOf(head);
    const middle = chain[1] as Memory;
    rows.push({
      question: chainQuestion(
        chain[chain.length - 1] as Memory,
        head.entities[0] ?? '',
        'back then',
      ),
      expectedMemoryIds: [middle.id],
      notExpectedMemoryIds: chain.filter((m) => m.id !== middle.id).map((m) => m.id),
      asOf: new Date(Date.parse(middle.validFrom) + DAY_MS).toISOString(),
      category: 'temporal',
    });
  }

  // temporal, LongMemEval style: the day is in the question, so recall must read it (CON-34).
  // Not one random draw: the multi-session rows below must not move.
  let dated = 0;
  for (const head of heads.slice(7)) {
    if (dated === 2) break;
    const chain = chainOf(head);
    const middle = chain[1] as Memory;
    const tail = chain[chain.length - 1] as Memory;
    const day = new Date(Date.parse(middle.validFrom) + DAY_MS);
    const endOfDay = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
    if (chain.length < 3 || Date.parse(tail.validFrom) < endOfDay) continue;
    rows.push({
      question: datedQuestion(tail, head.entities[0] ?? '', spoken(day)),
      expectedMemoryIds: [middle.id],
      notExpectedMemoryIds: chain.filter((m) => m.id !== middle.id).map((m) => m.id),
      category: 'temporal',
    });
    dated++;
  }

  // temporal: the whole chain, oldest first.
  const historyHead = heads[heads.length - 1];
  if (historyHead !== undefined) {
    const chain = chainOf(historyHead);
    rows.push({
      question: historyQuestion(chain[chain.length - 1] as Memory, historyHead.entities[0] ?? ''),
      expectedMemoryIds: chain.map((m) => m.id),
      category: 'temporal',
    });
  }

  // multi-session: a rare word shared by exactly two current memories from different sessions.
  const sharedTokens = [...df.entries()]
    .filter(([t, n]) => n === 2 && t.length >= 5)
    .map(([t]) => t)
    .sort();
  for (const t of shuffled(sharedTokens)) {
    if (rows.filter((r) => r.category === 'multi-session').length === 3) break;
    const pair = memories.filter((m) => !inChain(m) && tokensOf(m).includes(t));
    if (pair.length !== 2) continue;
    if (pair[0]?.source.sessionId === pair[1]?.source.sessionId) continue;
    rows.push({
      question: t,
      expectedMemoryIds: pair.map((m) => m.id),
      category: 'multi-session',
    });
  }

  for (const q of ABSTAIN)
    rows.push({ question: q, expectedMemoryIds: [], category: 'abstention' });
  return rows;
}

/**
 * One multi-hop set (CON-146, design section 11): a bridge memory the question's words reach, and
 * a target memory they do not, linked to the bridge by a shared specific entity (`about`) or by
 * being the next turn of the same session (`episode`). The target is the expected answer.
 */
interface MultiHopSet {
  link: 'about' | 'episode';
  bridge: { text: string; entities: string[] };
  target: { text: string; entities: string[] };
  /** The eval question: the bridge's words, none of the target's. */
  question: string;
  /** The same need as a prompt-hook message: short and conversational. */
  hook: string;
  /**
   * A warm-up question with words of both (half each), so one recall returns them together and a
   * learned `recalledWith` pair can form.
   */
  warmUp: string;
}

const MULTI_HOP: MultiHopSet[] = [
  {
    link: 'about',
    bridge: {
      text: 'Project Kestrel moved its staging cluster to the Frankfurt region.',
      entities: ['kestrel'],
    },
    target: {
      text: 'Kestrel keeps invoices inside CockroachDB, cluster ledger-east.',
      entities: ['kestrel'],
    },
    question: 'which database does the project that moved staging to Frankfurt use',
    hook: 'remind me what db the frankfurt staging project uses',
    warmUp: 'kestrel frankfurt staging invoices cockroachdb',
  },
  {
    link: 'about',
    bridge: {
      text: 'The Heron mobile app was rewritten in Kotlin over the summer.',
      entities: ['heron'],
    },
    target: { text: 'Heron crash reports: Sentry, project mobile-7.', entities: ['heron'] },
    question: 'which error tracker does the app that was rewritten in Kotlin send to',
    hook: 'where does the kotlin rewrite app send its errors',
    warmUp: 'heron kotlin rewritten crash sentry',
  },
  {
    link: 'about',
    bridge: {
      text: 'Osprey analytics export runs nightly from the reporting replica.',
      entities: ['osprey'],
    },
    target: { text: 'Osprey owner: Dana Whitfield, data platform group.', entities: ['osprey'] },
    question: 'who owns the nightly analytics export',
    hook: 'who owns that nightly analytics export again',
    warmUp: 'osprey analytics nightly owner whitfield',
  },
  {
    link: 'episode',
    bridge: {
      text: 'Switched the Grafana alert for queue depth to page after five minutes.',
      entities: ['grafana'],
    },
    target: { text: 'Runbook link added: wiki/ops/qd-paging.', entities: ['wiki/ops/qd-paging'] },
    question: 'what else changed alongside the queue depth alert',
    hook: 'what else did we change with the queue depth alert',
    warmUp: 'queue depth alert runbook paging wiki',
  },
  {
    link: 'episode',
    bridge: {
      text: 'Upgraded the Postgres driver to version 3 for the reporting service.',
      entities: ['postgres'],
    },
    target: { text: 'Afterwards, nightly vacuum moved to 02:30 UTC.', entities: [] },
    question: 'what followed the postgres driver upgrade',
    hook: 'what happened after we bumped the postgres driver',
    warmUp: 'postgres driver vacuum utc',
  },
  {
    link: 'episode',
    bridge: {
      text: 'Paired with Priya on the flaky checkout test in the payments repo.',
      entities: ['priya', 'payments'],
    },
    target: {
      text: 'Root cause: shared Redis keys between parallel workers; fixed via per-worker prefixes.',
      entities: ['redis'],
    },
    question: 'why was the checkout test flaky when pairing with priya',
    hook: 'why was that checkout test flaky with priya',
    warmUp: 'checkout flaky redis prefixes',
  },
];

/** Multi-hop memory ids start with this, so the base fixture rows can leave them out. */
export const MULTI_HOP_PREFIX = 'mh-';

const DAY = 86_400_000;

function fixtureMemory(
  id: string,
  text: string,
  entities: string[],
  at: Date,
  source: { sessionId: string; turnRef: string },
  type: MemoryType,
): Memory {
  const iso = at.toISOString();
  return {
    id,
    scope: localScope(undefined),
    type,
    text,
    stub: text.length <= 80 ? text : `${text.slice(0, 77).trimEnd()}...`,
    entities,
    salience: 0.5,
    pinned: false,
    tier: 'warm',
    accessLog: { count: 1, recent: [iso], compactedSum: 0, compactedAt: null },
    validFrom: iso,
    validTo: null,
    expiredAt: null,
    endReason: null,
    lastConfirmedAt: null,
    supersedes: null,
    supersededBy: null,
    source: { harness: 'synthetic', ...source, decisions: [] },
    embedding: fakeEmbedding(text, EMBEDDING_DIMENSION),
    createdAt: iso,
    updatedAt: iso,
  };
}

/**
 * The multi-hop sets as memories: `mh-<n>-bridge` and `mh-<n>-target`. An `about` pair shares an
 * entity and sits in two sessions weeks apart; an `episode` pair shares no entity and is turns 1
 * and 2 of one session, two minutes apart.
 */
export function multiHopMemories(now = GENERATOR_NOW): Memory[] {
  return MULTI_HOP.flatMap((set, i) => {
    const start = new Date(now.getTime() - (30 + i * 11) * DAY);
    const id = `${MULTI_HOP_PREFIX}${i + 1}`;
    const bridge = fixtureMemory(
      `${id}-bridge`,
      set.bridge.text,
      set.bridge.entities,
      start,
      { sessionId: `session-${id}-a`, turnRef: 't1' },
      'episodic',
    );
    const target =
      set.link === 'episode'
        ? fixtureMemory(
            `${id}-target`,
            set.target.text,
            set.target.entities,
            new Date(start.getTime() + 120_000),
            { sessionId: `session-${id}-a`, turnRef: 't2' },
            'episodic',
          )
        : fixtureMemory(
            `${id}-target`,
            set.target.text,
            set.target.entities,
            new Date(start.getTime() + 20 * DAY),
            { sessionId: `session-${id}-b`, turnRef: 't1' },
            'semantic',
          );
    return [bridge, target];
  });
}

/** Every memory the demo store holds: the generated 1,500 and the multi-hop sets. */
export function demoMemories(): Memory[] {
  return [...generateMemories(FIXTURE_COUNT, FIXTURE_SEED), ...multiHopMemories()];
}

const isMultiHop = (m: Memory): boolean => m.id.startsWith(MULTI_HOP_PREFIX);

/** The multi-hop rows: the target expected, present in `memories` or the row is left out. */
function multiHopRows(memories: Memory[], question: (s: MultiHopSet) => string): EvalRow[] {
  const ids = new Set(memories.map((m) => m.id));
  return MULTI_HOP.flatMap((set, i) => {
    const target = `${MULTI_HOP_PREFIX}${i + 1}-target`;
    return ids.has(target)
      ? [{ question: question(set), expectedMemoryIds: [target], category: 'multi-hop' as const }]
      : [];
  });
}

/**
 * The bundled `eval/fixture.jsonl`: `buildFixtureRows` over the generated memories, then one
 * multi-hop row per set (29 rows over `demoMemories()`).
 */
export function buildDemoRows(memories: Memory[]): EvalRow[] {
  return [
    ...buildFixtureRows(memories.filter((m) => !isMultiHop(m))),
    ...multiHopRows(memories, (s) => s.question),
  ];
}

/**
 * Prompts a person types that carry no memory need. A hook-shaped set must not answer them; their
 * ordinary words ("tests", "deploy") match many memories, as real chit-chat does.
 */
const HOOK_CHATTER = [
  'thanks, that works',
  'ok run the tests again',
  'lgtm, push it',
  'can you make the deploy script quieter',
  'what does this error mean',
];

/** Casual wrappers for a single-fact need, the way a prompt asks in passing. */
const HOOK_WRAP = ['hey, what about', 'quick q:', 'remind me:', 'and the'];

/**
 * The hook-shaped query set (`eval/hook.jsonl`, design decision 3): short conversational prompts,
 * run without a reranker (`fast`), for the no-rerank bar. Four single-fact prompts (three rare
 * plain words of one memory, which no other memory holds all of, in a casual wrapper), the six
 * multi-hop needs as a person would type them, and five prompts with no memory need. Synthetic: the real hook queries from imported transcripts stay
 * outside the repo (`eval/format.md`).
 */
export function buildHookRows(memories: Memory[]): EvalRow[] {
  const base = memories.filter((m) => !isMultiHop(m));
  const df = new Map<string, number>();
  const tokens = base.map((m) => new Set(tokenizeLexical(m.text)));
  for (const ts of tokens) for (const t of ts) df.set(t, (df.get(t) ?? 0) + 1);
  // The three rarest plain words of the answer's first sentence (no numbers, dates or paths), as
  // a person would say them; kept only when no other memory holds all three.
  const words = (m: Memory): string[] =>
    [...new Set(tokenizeLexical(m.text.split('. ')[0] ?? ''))]
      .filter((t) => /^[a-z][a-z-]{3,}$/.test(t))
      .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || (a < b ? -1 : 1))
      .slice(0, 3);
  const unique = (ws: string[]): boolean =>
    ws.length === 3 && tokens.filter((ts) => ws.every((w) => ts.has(w))).length === 1;
  const rng = createRng(FIXTURE_SEED + 1);
  const pool = rng.shuffle(
    base.filter((m) => m.type === 'semantic' && m.supersedes === null && m.supersededBy === null),
  );
  const rows: EvalRow[] = [];
  for (const m of pool) {
    if (rows.length === HOOK_WRAP.length) break;
    const ws = words(m);
    if (!unique(ws)) continue;
    rows.push({
      question: `${HOOK_WRAP[rows.length]} ${ws.join(' ')}`,
      expectedMemoryIds: [m.id],
      category: 'single-fact',
    });
  }
  rows.push(...multiHopRows(memories, (s) => s.hook));
  for (const q of HOOK_CHATTER)
    rows.push({ question: q, expectedMemoryIds: [], category: 'abstention' });
  return rows;
}

/**
 * The demo warm-up set (`eval/warm-up.jsonl`, `--warm-up`): one question per multi-hop set that
 * names both memories, so a recall returns them together, as an earlier conversation would have.
 * Disjoint from `fixture.jsonl` and `hook.jsonl`. It has no expected ids: it is run, not scored.
 */
export function buildWarmUpRows(): EvalRow[] {
  return MULTI_HOP.map((s) => ({ question: s.warmUp, expectedMemoryIds: [] }));
}
