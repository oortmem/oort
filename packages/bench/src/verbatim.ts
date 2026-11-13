import type { DecisionController, MemoryWriter, Observation, WrittenMemory } from '@oortmem/core';

/**
 * A decision controller and writer with no model: every turn is stored, as a new memory, in its
 * own words. The public-set adapters (CON-147) feed dialogue through `observe` with these, so
 * each turn becomes exactly one memory whose `turnRef` names the turn, and evidence recall can be
 * scored without a judge. What it measures is retrieval over raw turns; the writer that rewrites
 * a turn into standalone facts (and the reconcile step that supersedes) are not in the loop.
 */
export function verbatimDecider(): DecisionController {
  return {
    async gate() {
      return {
        shouldStore: 1,
        salience: 0.5,
        types: { episodic: 1 },
        decisions: [{ stage: 'gate', question: 'verbatim', answer: 'store', probability: 1 }],
      };
    },
    async reconcile() {
      return [{ candidateId: null, action: 'ADD', probability: 1, decisions: [] }];
    },
  };
}

/** The turn's text: the user side, then the assistant side, each only when present. */
export const turnText = (obs: Observation): string =>
  [obs.userText, obs.assistantText].filter((t) => t.trim() !== '').join('\n');

export function verbatimWriter(): MemoryWriter {
  return {
    async write(obs): Promise<WrittenMemory> {
      const text = turnText(obs);
      const head = text.split('\n')[0] ?? '';
      return {
        text,
        stub: head.length <= 80 ? head : `${head.slice(0, 77).trimEnd()}...`,
        entities: [],
        type: 'episodic',
      };
    },
  };
}
