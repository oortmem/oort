import { tokenizeLexical, type Memory } from '@oortmem/core';
import type { EvalRow } from './eval.js';
import { createRng } from './prng.js';

/** The demo store: `generateMemories(FIXTURE_COUNT, FIXTURE_SEED)`. */
export const FIXTURE_SEED = 7;
export const FIXTURE_COUNT = 1500;

const DAY_MS = 86_400_000;

/** Words that appear in no generated memory, for the abstention rows. */
const ABSENT = [
  'zorblax quuxification',
  'flibbertigibbet wombat',
  'xylophone marmalade',
  'gryphon obelisk',
];

/**
 * The 20 demo rows over the synthetic store: 6 single-fact, 4 knowledge-update
 * (superseded versions must not come back), 3 temporal (as-of an earlier date),
 * 3 multi-session and 4 abstention. Deterministic for a given memory list.
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
  for (const m of plain.slice(0, 6)) {
    rows.push({
      question: rareTokens(m).slice(0, 4).join(' '),
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
      question: `${head.entities[0]} current configuration`,
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
      question: `${head.entities[0]} configuration`,
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

  for (const q of ABSENT) rows.push({ question: q, expectedMemoryIds: [], category: 'abstention' });
  return rows;
}
