import { describe, expect, it, vi } from 'vitest';
import { MissingCredentialError, type Memory, type Observation } from '@oortmem/core';
import { DecideError, jevDecider, type SystemOneClient } from './index.js';

type Req = Parameters<SystemOneClient['systemOne']>[0];
type Answers = Record<string, unknown>;

function stub(respond: (req: Req) => Answers | Promise<Answers>) {
  const calls: Req[] = [];
  const client: SystemOneClient = {
    async systemOne(req) {
      calls.push(req);
      return { answers: (await respond(req)) as Record<string, never> };
    },
  };
  return { client, calls };
}

const obs: Observation = {
  userText: 'we use pnpm, never npm',
  assistantText: 'Noted, using pnpm.',
  toolSummaries: ['ran pnpm install: exit 0'],
  at: '2026-11-03T10:00:00.000Z',
};

const noulA = (p: number) => ({ type: 'noul', noul: p });
const scoreA = (s: number, probs: number[] = [0.1, 0.2, 0.3, 0.4]) => ({
  type: 'score',
  score: s,
  confidence: 0.9,
  probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])),
});
const choiceA = (c: string, probs: Record<string, number>) => ({
  type: 'choice',
  choice: c,
  confidence: 0.9,
  probabilities: probs,
});

function gateAnswers(over: Answers = {}): Answers {
  return {
    should_store: noulA(0.9),
    salience: scoreA(2),
    type_semantic: noulA(0.1),
    type_episodic: noulA(0.2),
    type_procedural: noulA(0.3),
    type_preference: noulA(0.8),
    ...over,
  };
}

function mem(id: string, text: string): Memory {
  return {
    id,
    type: 'semantic',
    text,
    validFrom: '2026-01-01T00:00:00.000Z',
  } as unknown as Memory;
}

const probs = (o: Partial<Record<string, number>> = {}) => ({
  NOOP: 0.05,
  REINFORCE: 0.05,
  ADD: 0.05,
  UPDATE: 0.05,
  SUPERSEDE: 0.05,
  ...o,
});

describe('jevDecider', () => {
  it('gate.maps-answers', async () => {
    const s = stub(() => gateAnswers());
    const g = await jevDecider({ client: s.client }).gate(obs);
    expect(g.shouldStore).toBe(0.9);
    expect(g.salience).toBeCloseTo(0.7);
    expect(g.types).toEqual({ semantic: 0.1, episodic: 0.2, procedural: 0.3, preference: 0.8 });
    expect(g.decisions).toHaveLength(6);
    expect(g.decisions[0]).toEqual({
      stage: 'gate',
      question: 'should_store',
      answer: 'yes',
      probability: 0.9,
    });
    expect(g.decisions.find((d) => d.question === 'salience')).toEqual({
      stage: 'gate',
      question: 'salience',
      answer: 'important',
      probability: 0.3,
    });
    expect(g.decisions.find((d) => d.question === 'type_semantic')?.answer).toBe('no');
    expect(s.calls[0]!.state).toEqual({
      user: obs.userText,
      assistant: obs.assistantText,
      tools: obs.toolSummaries,
      at: obs.at,
    });
  });

  it('gate.one-call-per-observation', async () => {
    const s = stub(() => gateAnswers());
    await jevDecider({ client: s.client }).gate(obs);
    expect(s.calls).toHaveLength(1);
  });

  it('gate.salience-interpolates', async () => {
    const run = async (score: number) => {
      const s = stub(() => gateAnswers({ salience: scoreA(score) }));
      return (await jevDecider({ client: s.client }).gate(obs)).salience;
    };
    expect(await run(0)).toBeCloseTo(0.1);
    expect(await run(1.5)).toBeCloseTo(0.55);
    expect(await run(3)).toBeCloseTo(1.0);
    expect(await run(9)).toBeCloseTo(1.0);
  });

  it('gate.types-from-nouls', async () => {
    const s = stub(() =>
      gateAnswers({
        type_semantic: noulA(0.7),
        type_episodic: noulA(0.01),
        type_procedural: noulA(0.5),
        type_preference: noulA(0.49),
      }),
    );
    const g = await jevDecider({ client: s.client }).gate(obs);
    expect(g.types).toEqual({ semantic: 0.7, episodic: 0.01, procedural: 0.5, preference: 0.49 });
    expect(Object.keys(s.calls[0]!.questions).sort()).toEqual([
      'salience',
      'should_store',
      'type_episodic',
      'type_preference',
      'type_procedural',
      'type_semantic',
    ]);
  });

  it('reconcile.one-call-for-all-candidates', async () => {
    const s = stub(() => ({
      c0: choiceA('REINFORCE', probs({ REINFORCE: 0.8 })),
      c1: choiceA('NOOP', probs({ NOOP: 0.8 })),
      c2: choiceA('SUPERSEDE', probs({ SUPERSEDE: 0.8 })),
    }));
    const out = await jevDecider({ client: s.client }).reconcile(obs, [
      mem('a', 'A'),
      mem('b', 'B'),
      mem('c', 'C'),
    ]);
    expect(s.calls).toHaveLength(1);
    expect(out.map((d) => d.action)).toEqual(['REINFORCE', 'NOOP', 'SUPERSEDE']);
  });

  it('reconcile.maps-per-candidate-ids', async () => {
    const s = stub(() => ({
      c0: choiceA('UPDATE', probs({ UPDATE: 0.6 })),
      c1: choiceA('ADD', probs({ ADD: 0.7 })),
    }));
    const out = await jevDecider({ client: s.client }).reconcile(obs, [
      mem('mem-a', 'A'),
      mem('mem-b', 'B'),
    ]);
    expect(out).toEqual([
      {
        candidateId: 'mem-a',
        action: 'UPDATE',
        probability: 0.6,
        decisions: [{ stage: 'reconcile', question: 'c0', answer: 'UPDATE', probability: 0.6 }],
      },
      {
        candidateId: 'mem-b',
        action: 'ADD',
        probability: 0.7,
        decisions: [{ stage: 'reconcile', question: 'c1', answer: 'ADD', probability: 0.7 }],
      },
    ]);
    expect(s.calls[0]!.state).toEqual({
      observation: {
        user: obs.userText,
        assistant: obs.assistantText,
        tools: obs.toolSummaries,
        at: obs.at,
      },
      candidates: [
        { id: 'mem-a', text: 'A', type: 'semantic', validFrom: '2026-01-01T00:00:00.000Z' },
        { id: 'mem-b', text: 'B', type: 'semantic', validFrom: '2026-01-01T00:00:00.000Z' },
      ],
    });
  });

  it('reconcile.state-references-candidates-by-index', async () => {
    const s = stub(() => ({
      c0: choiceA('NOOP', probs({ NOOP: 0.8 })),
      c1: choiceA('NOOP', probs({ NOOP: 0.8 })),
    }));
    await jevDecider({ client: s.client }).reconcile(obs, [mem('a', 'A'), mem('b', 'B')]);
    const q = s.calls[0]!.questions as Record<string, { instructions: string }>;
    expect(q['c1']!.instructions).toContain('`candidates[1]`');
    expect(q['c0']!.instructions).toContain('`candidates[0]`');
  });

  it('reconcile.no-candidates-asks-novel', async () => {
    const s = stub(() => ({ novel: choiceA('ADD', { ADD: 0.85, NOOP: 0.15 }) }));
    const out = await jevDecider({ client: s.client }).reconcile(obs, []);
    expect(s.calls).toHaveLength(1);
    expect(Object.keys(s.calls[0]!.questions)).toEqual(['novel']);
    expect(out).toEqual([
      {
        candidateId: null,
        action: 'ADD',
        probability: 0.85,
        decisions: [{ stage: 'reconcile', question: 'novel', answer: 'ADD', probability: 0.85 }],
      },
    ]);
  });

  it('passes the model override through', async () => {
    const s = stub(() => gateAnswers());
    await jevDecider({ client: s.client, model: 'jev-test' }).gate(obs);
    expect(s.calls[0]!.model).toBe('jev-test');
  });

  it('missing-key-names-fix', () => {
    const prev = process.env['TYPESAFE_API_KEY'];
    delete process.env['TYPESAFE_API_KEY'];
    try {
      expect(() => jevDecider()).toThrow(MissingCredentialError);
      expect(() => jevDecider()).toThrow(/TYPESAFE_API_KEY/);
      expect(() => jevDecider()).toThrow(
        /^Missing TYPESAFE_API_KEY\. Set it with: export TYPESAFE_API_KEY=\.\.\.$/,
      );
    } finally {
      if (prev !== undefined) process.env['TYPESAFE_API_KEY'] = prev;
    }
  });

  it('errors.bad-response-on-missing-answer', async () => {
    const missing = stub(() => {
      const a = gateAnswers();
      delete a['salience'];
      return a;
    });
    await expect(jevDecider({ client: missing.client }).gate(obs)).rejects.toMatchObject({
      name: 'DecideError',
      kind: 'bad-response',
    });
    const wrong = stub(() => gateAnswers({ should_store: scoreA(1) }));
    await expect(jevDecider({ client: wrong.client }).gate(obs)).rejects.toMatchObject({
      kind: 'bad-response',
    });
    const noProb = stub(() => ({ c0: choiceA('ADD', { NOOP: 1 }) }));
    await expect(
      jevDecider({ client: noProb.client }).reconcile(obs, [mem('a', 'A')]),
    ).rejects.toMatchObject({
      kind: 'bad-response',
    });
  });

  it('errors.never-leak-text', async () => {
    const secret = 'TOPSECRET-observation-text-xyz';
    const key = 'ts_' + 'test_' + 'abcdef123456';
    const client: SystemOneClient = {
      systemOne() {
        return Promise.reject(
          Object.assign(new Error(`failed on ${secret} with ${key}`), { status: 500 }),
        );
      },
    };
    const err = await jevDecider({ client })
      .gate({ ...obs, userText: secret })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecideError);
    const e = err as DecideError;
    expect(e.kind).toBe('server');
    expect(e.status).toBe(500);
    for (const blob of [e.message, e.stack ?? '', JSON.stringify(e)]) {
      expect(blob).not.toContain(secret);
      expect(blob).not.toContain(key);
    }
    expect(e.cause).toBeUndefined();
  });

  it('errors.maps-sdk-classes', async () => {
    const sdk = await import('@typesafe-ai/sdk');
    const h = new Headers();
    const cases: [unknown, string][] = [
      [new sdk.AuthenticationError(401, {}, h), 'auth'],
      [new sdk.PermissionDeniedError(403, {}, h), 'auth'],
      [new sdk.RateLimitError(429, {}, h), 'rate-limit'],
      [new sdk.InternalServerError(503, {}, h), 'server'],
      [new sdk.APITimeoutError(1000), 'timeout'],
      [new sdk.APIConnectionError('x'), 'network'],
      [new sdk.BadRequestError(400, {}, h), 'bad-response'],
    ];
    for (const [thrown, kind] of cases) {
      const client: SystemOneClient = { systemOne: () => Promise.reject(thrown) };
      await expect(jevDecider({ client }).gate(obs)).rejects.toMatchObject({ kind });
    }
  });

  it('network.import-makes-no-call', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network call at import');
    });
    try {
      vi.resetModules();
      await import('./index.js');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
