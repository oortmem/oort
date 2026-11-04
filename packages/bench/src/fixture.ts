import { tokenizeLexical, type Memory } from '@oortmem/core';
import type { EvalRow } from './eval.js';
import { createRng } from './prng.js';

/** The demo store: `generateMemories(FIXTURE_COUNT, FIXTURE_SEED)`. */
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
