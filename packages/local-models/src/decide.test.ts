import * as fs from 'node:fs';
import type { Memory, Observation } from '@oortmem/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { answerProbabilities, answerTokenIds, localDecider } from './decide.js';
import { RECONCILE_TREE, treeProbabilities } from './decide-prompt.js';
import { LocalModelError } from './errors.js';
import { pullModel } from './files.js';
import type { KvCache, LoadedDecoder, Runtime } from './runtime.js';
import { fixtureFetch, tinyDecideSpec, tmpHome, writeReady } from '../test/support.js';

const AT = '2026-11-05T10:00:00Z';
const obs = (userText: string, assistantText = ''): Observation => ({
  userText,
  assistantText,
  toolSummaries: [],
  at: AT,
});
const memory = (id: string, text: string): Memory =>
  ({ id, text, validFrom: '2026-09-01T10:00:00Z', type: 'semantic' }) as unknown as Memory;

/**
 * A decoder that never touches ONNX: words are tokens, the cache remembers the text so far, and
 * `answer` gives the logits of answer words for the whole prompt. Records every forward pass.
 */
function fakeDecoder(answer: (prompt: string) => Record<string, number>) {
  const vocab = new Map<string, number>();
  const words: string[] = [];
  const idOf = (w: string): number => {
    let i = vocab.get(w);
    if (i === undefined) {
      i = words.length;
      vocab.set(w, i);
      words.push(w);
    }
    return i;
  };
  const passes: string[] = [];
  let loads = 0;
  const decoder: LoadedDecoder = {
    tokenizer: { encode: (text) => text.split(/\s+/).filter(Boolean).map(idOf) },
    async forward(ids, past) {
      const text = ids.map((i) => words[i]).join(' ');
      passes.push(text);
      const prompt = `${(past as (KvCache & { text: string }) | undefined)?.text ?? ''} ${text}`;
      const logits = new Float32Array(4096).fill(-20);
      for (const [w, x] of Object.entries(answer(prompt))) logits[idOf(w)] = x;
      return {
        logits,
        cache: { length: (past?.length ?? 0) + ids.length, text: prompt } as KvCache,
      };
    },
  };
  const runtime: Runtime = {
    async load() {
      throw new Error('not an encoder');
    },
    async loadDecoder() {
      loads++;
      return decoder;
    },
  };
  return { runtime, passes, loads: () => loads };
}

/** The question a suffix asks, by its first words. */
const asks = (prompt: string, question: string): boolean =>
  prompt.includes(question.split(' ').slice(0, 8).join(' '));

const homes: string[] = [];
function readyHome(): string {
  const h = tmpHome();
  homes.push(h);
  writeReady(h, tinyDecideSpec());
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

describe('answer scoring', () => {
  it('local.decide-answer-mass-sums-casing-variants', () => {
    const logits = new Float32Array([0, Math.log(3), Math.log(1), Math.log(4), -Infinity]);
    // yes = ids 1 and 2 (mass 4), no = id 3 (mass 4): even, whatever the casing split.
    const [yes, no] = answerProbabilities(logits, [[1, 2], [3]]);
    expect(yes).toBeCloseTo(0.5);
    expect(no).toBeCloseTo(0.5);
  });

  it('local.decide-answer-ids-cover-case-and-leading-space', () => {
    const seen: string[] = [];
    const ids = answerTokenIds(
      {
        encode: (t) => {
          seen.push(t);
          return [t.length * 10 + (t.trim()[0] === 'Y' ? 1 : 0)];
        },
      },
      'yes',
    );
    expect(seen).toEqual(['yes', 'Yes', ' yes', ' Yes']);
    expect(ids).toEqual([30, 31, 40, 41]);
  });

  it('local.decide-tree-probabilities-sum-to-one', () => {
    const ps = treeProbabilities({
      related: 0.9,
      conflict: 0.7,
      mistake: 0.2,
      newinfo: 0.6,
      samefact: 0.3,
    });
    expect(Object.values(ps).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(ps.SUPERSEDE).toBeCloseTo(0.9 * 0.7 * 0.8);
    expect(ps.NOOP).toBeCloseTo(0.1);
  });
});

describe('localDecider with a fake decoder', () => {
  it('local.decide-gate-asks-jevs-questions-on-one-shared-exchange', async () => {
    const f = fakeDecoder((p): Record<string, number> => {
      if (asks(p, 'Does this exchange between a developer')) return { yes: 3, no: 0 };
      if (p.includes('Answer with one word: trivial')) return { important: 2, useful: 0 };
      if (p.includes('Answer with one word: fact')) return { preference: 3 };
      return { yes: 0, no: 3 }; // volatile
    });
    const d = localDecider({
      home: readyHome(),
      model: 'tiny-decide',
      spec: tinyDecideSpec(),
      runtime: f.runtime,
    });
    const g = await d.gate(obs('Always use pnpm in this repo.', 'Got it.'));
    expect(g.shouldStore).toBeGreaterThan(0.9);
    expect(g.volatile).toBeLessThan(0.1);
    expect(Object.entries(g.types).sort((a, b) => b[1]! - a[1]!)[0]![0]).toBe('preference');
    expect(g.salience).toBeGreaterThan(0.6); // mostly "important" (level 2 of 0..3)
    expect(g.decisions.map((x) => x.question)).toEqual([
      'should_store',
      'salience',
      'type_semantic',
      'type_episodic',
      'type_procedural',
      'type_preference',
      'volatile',
    ]);
    // System prompt, the exchange once, then one short pass per question.
    expect(f.passes).toHaveLength(6);
    expect(f.passes.filter((p) => p.includes('Always use pnpm'))).toHaveLength(1);
  });

  it('local.decide-default-never-rewrites-and-asks-one-question', async () => {
    // Every tree question says yes: with rewrites on this would be CORRECT.
    const f = fakeDecoder(() => ({ yes: 4, no: 0 }));
    const d = localDecider({
      home: readyHome(),
      model: 'tiny-decide',
      spec: tinyDecideSpec(),
      runtime: f.runtime,
    });
    const [r] = await d.reconcile(obs('Correction: CI was never on Node 22.'), [
      memory('m1', 'CI runs on Node 22.'),
    ]);
    expect(r).toMatchObject({ candidateId: 'm1', action: 'ADD' });
    // The system prompt, the pair, and one question (related).
    expect(f.passes).toHaveLength(3);
    expect(f.passes[2]).toContain(RECONCILE_TREE.related.split(' ')[0]);
  });

  it('local.decide-calibration-shifts-the-yes-probability', async () => {
    // The model says yes to "worth storing" at about 0.95; a bias of -6 log-odds makes it a no.
    const f = fakeDecoder(() => ({ yes: 3, no: 0 }));
    const d = localDecider({
      home: readyHome(),
      model: 'tiny-decide',
      spec: tinyDecideSpec({ calibration: { should_store: -6 } }),
      runtime: f.runtime,
    });
    const g = await d.gate(obs('ok thanks', 'You are welcome.'));
    expect(g.shouldStore).toBeLessThan(0.1);
    expect(g.decisions[0]).toMatchObject({ question: 'should_store', answer: 'no' });
  });

  it('local.decide-reconcile-walks-the-tree-to-supersede', async () => {
    const f = fakeDecoder((p) => {
      const yes = asks(p, RECONCILE_TREE.related) || asks(p, RECONCILE_TREE.conflict);
      return yes ? { yes: 4, no: 0 } : { yes: 0, no: 4 };
    });
    const d = localDecider({
      allowRewrites: true,
      home: readyHome(),
      model: 'tiny-decide',
      spec: tinyDecideSpec(),
      runtime: f.runtime,
    });
    const [r] = await d.reconcile(obs('CI now runs on Node 24.'), [
      memory('m1', 'CI runs on Node 22.'),
    ]);
    expect(r).toMatchObject({ candidateId: 'm1', action: 'SUPERSEDE' });
    expect(r!.probability).toBeGreaterThan(0.9);
    expect(r!.decisions.map((x) => x.question)).toEqual(['c0']);
  });

  it('local.decide-unsure-rewrite-keeps-the-memory', async () => {
    // related yes, conflict a coin flip, mistake no: SUPERSEDE wins at about 0.49, under 0.5.
    const f = fakeDecoder((p) => {
      if (asks(p, RECONCILE_TREE.related)) return { yes: 5, no: 0 };
      if (asks(p, RECONCILE_TREE.conflict)) return { yes: 0.02, no: 0 };
      if (asks(p, RECONCILE_TREE.newinfo)) return { yes: 4, no: 0 };
      return { yes: 0, no: 4 }; // mistake, samefact: no
    });
    const d = localDecider({
      allowRewrites: true,
      home: readyHome(),
      model: 'tiny-decide',
      spec: tinyDecideSpec(),
      runtime: f.runtime,
    });
    const [r] = await d.reconcile(obs('CI might move to Node 24.'), [
      memory('m1', 'CI runs on Node 22.'),
    ]);
    expect(r!.action).toBe('ADD');
    expect(r!.decisions[0]).toMatchObject({ question: 'c0', answer: 'SUPERSEDE' });
    expect(r!.decisions[1]).toMatchObject({ question: 'c0_guard', answer: 'SUPERSEDE->ADD' });
  });

  it('local.decide-novel-and-batched-question-ids-match-jev', async () => {
    const f = fakeDecoder((p) => (p.includes('ok thanks') ? { yes: 0, no: 3 } : { yes: 3, no: 0 }));
    const d = localDecider({
      home: readyHome(),
      model: 'tiny-decide',
      spec: tinyDecideSpec(),
      runtime: f.runtime,
    });
    const out = await d.reconcileMany!([
      { obs: obs('Nightly backups run at 02:00 UTC.'), candidates: [] },
      { obs: obs('ok thanks'), candidates: [] },
      {
        obs: obs('Backups are at 2am UTC.'),
        candidates: [memory('m1', 'Backups run at 02:00 UTC.')],
      },
    ]);
    expect(out.map((rs) => rs.map((r) => r.action))).toEqual([
      ['ADD'],
      ['NOOP'],
      [expect.any(String)],
    ]);
    expect(out.map((rs) => rs[0]!.decisions[0]!.question)).toEqual([
      'f0_novel',
      'f1_novel',
      'f2_c0',
    ]);
    // Each system prompt is computed once per decider, however many questions follow.
    expect(f.passes.filter((p) => p.startsWith('<|im_start|>system')).length).toBe(2);
    expect(f.loads()).toBe(1);
  });

  it('local.decide-not-pulled-refuses-without-loading', () => {
    const f = fakeDecoder(() => ({}));
    const h = tmpHome();
    homes.push(h);
    expect(() =>
      localDecider({ home: h, model: 'tiny-decide', spec: tinyDecideSpec(), runtime: f.runtime }),
    ).toThrow(LocalModelError);
    expect(f.loads()).toBe(0);
  });
});

describe('localDecider with ONNX Runtime and the tiny fixture decoder', () => {
  let h: string;
  beforeAll(async () => {
    h = tmpHome();
    await pullModel(h, tinyDecideSpec(), { fetch: fixtureFetch() });
  });
  afterAll(() => fs.rmSync(h, { recursive: true, force: true }));

  it('local.decide-runs-the-real-runtime-end-to-end', async () => {
    const d = localDecider({ home: h, model: 'tiny-decide', spec: tinyDecideSpec(), threads: 1 });
    const g = await d.gate(obs('ok thanks hello', 'ok'));
    for (const x of g.decisions) expect(x.probability).toBeGreaterThanOrEqual(0);
    expect(g.shouldStore).toBeGreaterThanOrEqual(0);
    expect(g.shouldStore).toBeLessThanOrEqual(1);
    const [r] = await d.reconcile(obs('it moved now'), [memory('m1', 'it is on 8443')]);
    expect(['NOOP', 'REINFORCE', 'REFINE', 'SUPERSEDE', 'CORRECT', 'ADD']).toContain(r!.action);
    // Deterministic: the same question gets the same answer.
    const [again] = await d.reconcile(obs('it moved now'), [memory('m1', 'it is on 8443')]);
    expect(again).toEqual(r);
  });
});
