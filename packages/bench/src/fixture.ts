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

/** A query in other words: identifiers dropped, synonyms swapped, word order reversed. */
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

/** `auth-service-3` to "auth service": the subject in natural words. */
const naturalSubject = (id: string): string => id.replace(/-\d+$/, '').replaceAll('-', ' ');

function chainQuestion(tail: Memory, subject: string, when: string): string {
  const who = naturalSubject(subject);
  if (tail.text.includes('listens on port')) return `which port does the ${who} listen on ${when}`;
  if (tail.text.includes('installs dependencies'))
    return `which package manager does the ${who} use ${when}`;
  return `which library does the ${who} use to validate requests ${when}`;
}

/**
 * The 20 demo rows over the synthetic store: 6 single-fact (exact, partial and
 * paraphrased), 4 knowledge-update and 3 temporal (the subject in natural words,
 * not the chain id), 3 multi-session and 4 abstention. A smoke test of the
 * eval pipeline, not a quality benchmark. Deterministic for a given memory list.
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
  // single-fact: 2 exact (the four rarest words), 2 partial (the rarest, an identifier,
  // left out) and 2 paraphrased (synonyms, no identifiers, reversed word order).
  const loose = shuffled(
    memories.filter((m) => m.type === 'semantic' && !inChain(m) && !plain.includes(m)),
  );
  const exact = plain.slice(0, 2);
  const partial = plain.slice(2, 4);
  const reworded = loose.slice(0, 2);
  for (const m of exact) {
    rows.push({
      question: rareTokens(m).slice(0, 4).join(' '),
      expectedMemoryIds: [m.id],
      category: 'single-fact',
    });
  }
  for (const m of partial) {
    rows.push({
      question: rareTokens(m).slice(1, 4).join(' '),
      expectedMemoryIds: [m.id],
      category: 'single-fact',
    });
  }
  for (const m of reworded) {
    rows.push({
      question: paraphrase(m.stub),
      expectedMemoryIds: [m.id],
      category: 'single-fact',
    });
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
