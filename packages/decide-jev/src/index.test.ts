import { describe, expect, it, vi } from 'vitest';
import { MissingCredentialError, type Memory, type Observation } from '@oortmem/core';
import { DecideError, RELAY_MODEL, jevDecider, type SystemOneClient } from './index.js';

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
    volatile: noulA(0.7),
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
  REFINE: 0.05,
  SUPERSEDE: 0.05,
  CORRECT: 0.05,
  UPDATE: 0.05,
  ...o,
});

describe('jevDecider', () => {
  it('gate.maps-answers', async () => {
    const s = stub(() => gateAnswers());
    const g = await jevDecider({ client: s.client }).gate(obs);
    expect(g.shouldStore).toBe(0.9);
    expect(g.salience).toBeCloseTo(0.7);
    expect(g.types).toEqual({ semantic: 0.1, episodic: 0.2, procedural: 0.3, preference: 0.8 });
    expect(g.decisions).toHaveLength(7);
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
      'volatile',
    ]);
  });

  it('gate.records-volatile', async () => {
    const s = stub(() => gateAnswers({ volatile: noulA(0.8) }));
    const g = await jevDecider({ client: s.client }).gate(obs);
    expect(g.volatile).toBe(0.8);
    expect(g.decisions.at(-1)).toEqual({
      stage: 'gate',
      question: 'volatile',
      answer: 'yes',
      probability: 0.8,
    });
  });

  it('reconcile.asks-change-of-state-versus-correction-in-one-question', async () => {
    const s = stub(() => ({ c0: choiceA('CORRECT', probs({ CORRECT: 0.7 })) }));
    const out = await jevDecider({ client: s.client }).reconcile(obs, [mem('a', 'A')]);
    expect(out[0]).toMatchObject({ candidateId: 'a', action: 'CORRECT', probability: 0.7 });
    // Still one call with one choice per candidate: the split costs no extra question.
    expect(s.calls).toHaveLength(1);
    const q = s.calls[0]!.questions as Record<string, { criteria: Record<string, string> }>;
    expect(Object.keys(q)).toEqual(['c0']);
    expect(Object.keys(q['c0']!.criteria)).toEqual([
      'NOOP',
      'REINFORCE',
      'REFINE',
      'SUPERSEDE',
      'CORRECT',
      'ADD',
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
        /^Missing TYPESAFE_API_KEY\. Set it with: oort keys set typesafe \(or export TYPESAFE_API_KEY=\.\.\.\)$/,
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

  it('base-url-routes-the-sdk-through-the-relay', async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ error: 'Oort Pro is not active' }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const relayKey = ['oort', 'sk', 'test0123456789'].join('_');
    const d = jevDecider({
      apiKey: relayKey,
      baseURL: 'https://relay.example.test/v1/typesafe',
      fetch: fetchFn,
    });
    const err = (await d.gate(obs).catch((x: unknown) => x)) as DecideError;
    expect(err).toBeInstanceOf(DecideError);
    expect(err.status).toBe(402);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.url).toBe('https://relay.example.test/v1/typesafe/v1/systemone');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${relayKey}`);
  });

  describe('relay mode', () => {
    const cap = 'You have used the 25,000 saves included in Oort Pro this month.';
    const relayKey = ['oort', 'sk', 'test0123456789'].join('_');
    const reply = (body: unknown, status: number, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });
    const decider = (fn: typeof fetch) =>
      jevDecider({
        apiKey: relayKey,
        baseURL: 'https://relay.example.test/v1/typesafe',
        relay: true,
        fetch: fn,
      });

    it('cap-429-without-retry-after-is-not-retried-and-keeps-the-message', async () => {
      let n = 0;
      const f = (async () => (n++, reply({ error: cap }, 429))) as typeof fetch;
      const err = (await decider(f)
        .gate(obs)
        .catch((x: unknown) => x)) as DecideError;
      expect(err).toBeInstanceOf(DecideError);
      expect(err).toMatchObject({ kind: 'rate-limit', status: 429, relayMessage: cap });
      expect(err.message).toBe(cap);
      expect(n).toBe(1);
    });

    it('429-with-retry-after-is-retried-once', async () => {
      let n = 0;
      const f = (async () => (
        n++,
        reply({ error: 'slow down' }, 429, { 'retry-after': '0' })
      )) as typeof fetch;
      await expect(decider(f).gate(obs)).rejects.toMatchObject({
        kind: 'rate-limit',
        relayMessage: 'slow down',
      });
      expect(n).toBe(2);
    });

    it('direct-429-keeps-the-sdk-retries-and-never-echoes-a-vendor-body', async () => {
      let n = 0;
      const f = (async () => (
        n++,
        reply({ error: 'vendor secret' }, 429, { 'retry-after': '0' })
      )) as typeof fetch;
      const d = jevDecider({ apiKey: 'ts-direct', baseURL: 'https://x.test', fetch: f });
      const err = (await d.gate(obs).catch((x: unknown) => x)) as DecideError;
      expect(n).toBeGreaterThan(1);
      expect(err.message).not.toContain('vendor secret');
      expect(err.relayMessage).toBeUndefined();
    });

    it('sends-plain-json-with-the-pinned-model-the-relay-accepts', async () => {
      const sent: { headers: Headers; body: string }[] = [];
      const f = (async (_u: string | URL | Request, init?: RequestInit) => {
        const req = new Request('https://x.test', init);
        sent.push({ headers: req.headers, body: await req.text() });
        return reply({ error: 'stop' }, 402);
      }) as typeof fetch;
      const before = process.env['TYPESAFE_DEFAULT_MODEL'];
      process.env['TYPESAFE_DEFAULT_MODEL'] = 'jev-preview';
      try {
        // A big observation: the SDK would zstd-compress anything of 1 KB or more.
        await decider(f)
          .gate({ ...obs, assistantText: 'x'.repeat(4000) })
          .catch(() => undefined);
      } finally {
        if (before === undefined) delete process.env['TYPESAFE_DEFAULT_MODEL'];
        else process.env['TYPESAFE_DEFAULT_MODEL'] = before;
      }
      expect(sent).toHaveLength(1);
      expect(sent[0]!.headers.get('content-encoding')).toBeNull();
      expect(sent[0]!.headers.get('content-type')).toBe('application/json');
      const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
      expect(body['model']).toBe(RELAY_MODEL);
    });

    it('5xx-keeps-the-sdk-retries', async () => {
      let n = 0;
      const f = (async () => (
        n++,
        reply({ error: 'x' }, 503, { 'retry-after': '0' })
      )) as typeof fetch;
      await expect(decider(f).gate(obs)).rejects.toMatchObject({ kind: 'server' });
      expect(n).toBe(3);
    });
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

describe('request size caps', () => {
  const big = '日本語😀🙂 émoji '.repeat(12_000); // about 200 KB
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

  it('keeps a gate request under 56 KB for a 200 KB observation', async () => {
    const { client, calls } = stub(() => gateAnswers());
    await jevDecider({ client }).gate({
      ...obs,
      userText: big,
      assistantText: big,
      toolSummaries: Array.from({ length: 50 }, () => 'x'.repeat(4000)),
    });
    expect(bytes(calls[0])).toBeLessThan(56 * 1024);
    const state = calls[0]!.state as { user: string; assistant: string };
    expect(new TextEncoder().encode(state.user).length).toBeLessThanOrEqual(16 * 1024);
    expect(state.user).toMatch(/\[… \d+ bytes omitted …\]/);
    expect(state.user).not.toContain('\uFFFD');
  });

  it('keeps a reconcile request under 56 KB with five 20 KB candidates', async () => {
    const { client, calls } = stub((req) =>
      Object.fromEntries(Object.keys(req.questions).map((k) => [k, choiceA('NOOP', { NOOP: 1 })])),
    );
    const cands = Array.from({ length: 5 }, (_, i) => mem(`m${i}`, big.slice(0, 20_000)));
    await jevDecider({ client }).reconcile({ ...obs, userText: big, assistantText: big }, cands);
    expect(bytes(calls[0])).toBeLessThan(56 * 1024);
    const state = calls[0]!.state as { candidates: { text: string }[] };
    for (const c of state.candidates) {
      expect(new TextEncoder().encode(c.text).length).toBeLessThanOrEqual(1024);
    }
  });
});

describe('reconcileMany (CON-56)', () => {
  const fact = (text: string) => ({ ...obs, userText: text, assistantText: '', toolSummaries: [] });

  it('reconcileMany.one-call-for-every-fact', async () => {
    const s = stub(() => ({
      f0_c0: choiceA('SUPERSEDE', probs({ SUPERSEDE: 0.8 })),
      f0_c1: choiceA('NOOP', probs({ NOOP: 0.8 })),
      f1_novel: choiceA('ADD', { ADD: 0.9, NOOP: 0.1 }),
    }));
    const out = await jevDecider({ client: s.client }).reconcileMany!([
      {
        obs: fact('CI on main is green.'),
        candidates: [mem('ci', 'CI on main is red.'), mem('x', 'X')],
      },
      { obs: fact('release 1.2 shipped.'), candidates: [] },
    ]);
    expect(s.calls).toHaveLength(1);
    expect(out.map((rs) => rs.map((r) => [r.candidateId, r.action]))).toEqual([
      [
        ['ci', 'SUPERSEDE'],
        ['x', 'NOOP'],
      ],
      [[null, 'ADD']],
    ]);
    const q = s.calls[0]!.questions as Record<string, { instructions: string }>;
    expect(q['f0_c1']!.instructions).toContain('`facts[0].candidates[1]`');
    expect(q['f0_c1']!.instructions).toContain('`facts[0].observation`');
    expect(q['f1_novel']!.instructions).toContain('`facts[1].observation`');
    const state = s.calls[0]!.state as { facts: { observation: { user: string } }[] };
    expect(state.facts.map((f) => f.observation.user)).toEqual([
      'CI on main is green.',
      'release 1.2 shipped.',
    ]);
  });

  it('reconcileMany.empty-is-no-call', async () => {
    const s = stub(() => ({}));
    expect(await jevDecider({ client: s.client }).reconcileMany!([])).toEqual([]);
    expect(s.calls).toHaveLength(0);
  });

  it('reconcileMany.splits-a-request-that-would-pass-the-size-cap', async () => {
    const big = 'x'.repeat(20 * 1024);
    const five = Array.from({ length: 5 }, (_, i) => mem(`m${i}`, big));
    const s = stub((req) =>
      Object.fromEntries(
        Object.keys(req.questions).map((k) => [k, choiceA('NOOP', probs({ NOOP: 0.8 }))]),
      ),
    );
    const out = await jevDecider({ client: s.client }).reconcileMany!(
      // Each fact's state is capped at 16 KB a side, so five large facts need several calls.
      Array.from({ length: 5 }, (_, j) => ({ obs: fact(`fact ${j} ${big}`), candidates: five })),
    );
    expect(out).toHaveLength(5);
    expect(s.calls.length).toBeGreaterThan(1);
    for (const c of s.calls) {
      expect(new TextEncoder().encode(JSON.stringify(c)).byteLength).toBeLessThan(56 * 1024);
    }
  });
});
