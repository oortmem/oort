import { describe, expect, it } from 'vitest';
import type { JudgeChoice, JudgeRequest, MemoryStore } from './adapters.js';
import { forgetMemory } from './forget.js';
import { localGrant } from './grant.js';
import {
  evaluateJudgments,
  isActiveJudgment,
  isUnconfirmedAgentJudgment,
  judge,
  purgeJudgment,
  recordJudgment,
  withdrawJudgment,
  type JudgmentInput,
} from './judgment.js';
import { createMemoryStore } from './memory-store.js';
import type { Scope } from './model.js';
import {
  confirmResolution,
  evaluateLive,
  evaluatePredictions,
  forgetPrediction,
  getPrediction,
  listPredictions,
  PredictionError,
  resolvePrediction,
  type Prediction,
} from './prediction.js';
import { livePredictionFixtures as liveFixtures } from './store-conformance.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const SCOPE: Scope = { orgId: 'local', customerId: 'self', agentId: 'claude-code' };
const GRANT = localGrant({ ...SCOPE, projectIds: [null] });

function decider(verdict: string, p: number) {
  return {
    async judge(req: JudgeRequest): Promise<JudgeChoice> {
      const probabilities = Object.fromEntries(
        req.verdicts.map((v) => [v, v === verdict ? p : (1 - p) / (req.verdicts.length - 1)]),
      );
      return { verdict, probability: p, probabilities, decisions: [] };
    },
  };
}

const ada = (over: Partial<JudgmentInput>): JudgmentInput => ({
  subject: 'Post says a vitamin cures the flu',
  verdict: 'rejected',
  reason: 'Health claim with no cited source.',
  criteria: ['no-source'],
  domain: 'content',
  by: 'ada',
  decidedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

async function setup() {
  const store = createMemoryStore({ now: () => NOW });
  const precedents = [];
  for (const input of [
    ada({}),
    ada({ subject: 'Post says a vitamin cures colds overnight' }),
    ada({ subject: 'Post says a miracle remedy cures the flu' }),
  ]) {
    precedents.push(
      (await recordJudgment(input, { store, grant: GRANT, scope: SCOPE, now: NOW, via: 'cli' }))
        .memory,
    );
  }
  const deps = {
    store,
    grant: GRANT,
    decide: decider('rejected', 0.9),
    now: NOW,
    keep: { scope: SCOPE },
  };
  const item = { summary: 'Post says a vitamin cures the flu fast', domain: 'content' };
  return { store, deps, precedents, item };
}

const resolveDeps = (store: MemoryStore, via: 'cli' | 'mcp' = 'cli', now = NOW) => ({
  store,
  grant: GRANT,
  scope: SCOPE,
  now,
  via,
});

/** Everything the store holds, to show a failed call wrote nothing. */
async function snapshot(store: MemoryStore) {
  return JSON.stringify({
    memories: await store.list(GRANT, { validOnly: false, embeddings: false }),
    predictions: await store.listPredictions!(GRANT),
  });
}

describe('predictions: judging keeps what it proposed', () => {
  it('prediction.judge-keeps-the-prediction', async () => {
    const { store, deps, precedents, item } = await setup();
    const r = await judge(item, deps);
    expect(r.status).toBe('suggested');
    expect(r.predictionId).toBeDefined();
    const p = await getPrediction(store, GRANT, r.predictionId!);
    expect(p).toMatchObject({
      item: { summary: item.summary, domain: 'content' },
      domain: 'content',
      outcome: 'suggested',
      verdict: 'rejected',
      probability: 0.9,
      verdicts: ['approved', 'rejected'],
      criteria: ['no-source'],
      revision: 0,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-12-16T12:00:00.000Z',
    });
    expect([...p.precedentIds].sort()).toEqual(precedents.map((m) => m.id).sort());
    // A prediction is never a memory.
    expect(await store.get(GRANT, p.id)).toBeNull();
  });

  it('prediction.without-keep-or-in-evaluation-nothing-is-kept', async () => {
    const { store, deps, item } = await setup();
    const { keep: _k, ...pure } = deps;
    expect((await judge(item, pure)).predictionId).toBeUndefined();
    await evaluateJudgments([ada({ subject: item.summary })], deps);
    expect(await store.listPredictions!(GRANT)).toEqual([]);
  });

  it('prediction.kept-without-a-verdict-when-judging-needs-the-expert', async () => {
    const { store, deps } = await setup();
    const r = await judge({ summary: 'A refactor of the parser', domain: 'content' }, deps);
    expect(r.status).toBe('needs-expert');
    const p = await getPrediction(store, GRANT, r.predictionId!);
    expect(p.verdict).toBeNull();
    expect(p.probability).toBeNull();
    expect(p.outcome).toBe('needs-expert');
  });
});

describe('predictions: resolving', () => {
  it('prediction.resolve-agreeing-and-disagreeing', async () => {
    const { store, deps, item } = await setup();
    const agreeing = await judge(item, deps);
    const a = await resolvePrediction(
      agreeing.predictionId!,
      { verdict: 'rejected', by: 'ada', reason: 'Same as before.' },
      resolveDeps(store),
    );
    expect(a.agrees).toBe(true);
    expect(a.judgment).toBeUndefined();
    expect(a.prediction.resolution).toMatchObject({
      verdict: 'rejected',
      agrees: true,
      via: 'cli',
    });

    const next = { summary: 'Satire post says a vitamin cures the flu', domain: 'content' };
    const disagreeing = await judge(next, deps);
    expect(disagreeing.prediction?.verdict).toBe('rejected');
    const reason = 'Satire account, clearly labelled as parody.\n  Not a health claim.';
    const d = await resolvePrediction(
      disagreeing.predictionId!,
      { verdict: 'Approved', by: 'ada', reason, criteria: ['satire'] },
      resolveDeps(store),
    );
    expect(d.agrees).toBe(false);
    expect(d.judgment?.outcome).toBe('added');
    const m = (await store.get(GRANT, d.judgment!.memory.id))!;
    expect(isActiveJudgment(m, NOW)).toBe(true);
    // The reason is kept verbatim, never paraphrased.
    expect(m.judgment).toMatchObject({
      subject: { summary: next.summary },
      verdict: 'approved',
      reason,
      criteria: ['satire'],
      domain: 'content',
      by: 'ada',
      via: 'cli',
    });
    expect(d.prediction.resolution?.judgmentId).toBe(m.id);
    expect((await getPrediction(store, GRANT, disagreeing.predictionId!)).resolution).toEqual(
      d.prediction.resolution,
    );

    // The next judging call on a similar item cites the new judgment.
    const again = await judge(
      { summary: 'Satire post says a vitamin cures colds', domain: 'content' },
      deps,
    );
    const cited = again.precedents.find((p) => p.id === m.id);
    expect(cited).toMatchObject({ near: true, verdict: 'approved', reason });
  });

  it('prediction.resolve-refuses-unknown-expired-and-resolved-ids-and-writes-nothing', async () => {
    const { store, deps, item } = await setup();
    const r = await judge(item, deps);
    const id = r.predictionId!;
    const input = { verdict: 'approved', by: 'ada', reason: 'Fine.' };
    const kind = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        expect(e).toBeInstanceOf(PredictionError);
        return (e as PredictionError).kind;
      }
      return 'resolved';
    };

    let before = await snapshot(store);
    expect(await kind(resolvePrediction('nope', input, resolveDeps(store)))).toBe('not-found');
    expect(await snapshot(store)).toBe(before);

    const later = new Date('2026-12-17T00:00:00.000Z');
    expect(await kind(resolvePrediction(id, input, resolveDeps(store, 'cli', later)))).toBe(
      'expired',
    );
    expect(await snapshot(store)).toBe(before);

    // A verdict outside the set is an input error, before anything is written.
    await expect(
      resolvePrediction(id, { verdict: 'maybe', by: 'ada' }, resolveDeps(store)),
    ).rejects.toThrow(/verdict must be one of: approved, rejected/);
    expect(await snapshot(store)).toBe(before);

    await resolvePrediction(id, input, resolveDeps(store));
    before = await snapshot(store);
    expect(await kind(resolvePrediction(id, input, resolveDeps(store)))).toBe('already-resolved');
    expect(await snapshot(store)).toBe(before);
  });

  it('prediction.two-resolves-at-once-only-one-lands', async () => {
    const { store, deps, item } = await setup();
    const id = (await judge(item, deps)).predictionId!;
    const results = await Promise.allSettled([
      resolvePrediction(id, { verdict: 'approved', by: 'ada', reason: 'One.' }, resolveDeps(store)),
      resolvePrediction(id, { verdict: 'approved', by: 'bo', reason: 'Two.' }, resolveDeps(store)),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect((failed.reason as PredictionError).kind).toBe('already-resolved');
    const judgments = (await store.list(GRANT)).filter((m) => m.type === 'judgment');
    expect(judgments).toHaveLength(4);
  });

  it('prediction.agent-resolve-is-unconfirmed-until-a-person-confirms-it', async () => {
    const { store, deps, item } = await setup();
    const id = (await judge(item, deps)).predictionId!;
    const r = await resolvePrediction(
      id,
      { verdict: 'approved', by: 'ada', reason: 'Labelled satire.' },
      resolveDeps(store, 'mcp'),
    );
    expect(r.prediction.resolution?.via).toBe('mcp');
    const m = (await store.get(GRANT, r.judgment!.memory.id))!;
    expect(isUnconfirmedAgentJudgment(m.judgment!)).toBe(true);
    // Judging leaves the unconfirmed judgment out, and the evaluation the unconfirmed resolve.
    const again = await judge(item, deps);
    expect(again.precedents.some((p) => p.id === m.id)).toBe(false);
    let report = await evaluateLive(store, GRANT, { now: NOW });
    expect(report.resolved).toBe(0);
    expect(report.agentResolvedExcluded).toBe(1);

    expect(await confirmResolution(store, GRANT, id, 'operator', NOW)).toBe(true);
    expect(await confirmResolution(store, GRANT, id, 'operator', NOW)).toBe(false);
    const confirmed = (await store.get(GRANT, m.id))!;
    expect(isUnconfirmedAgentJudgment(confirmed.judgment!)).toBe(false);
    report = await evaluateLive(store, GRANT, { now: NOW });
    expect(report.resolved).toBe(1);
    expect(report.overall).toEqual({ predicted: 1, agreed: 0, agreement: 0 });
  });

  it('prediction.list-pending-leaves-out-resolved-and-expired', async () => {
    const { store, deps, item } = await setup();
    const a = (await judge(item, deps)).predictionId!;
    const b = (await judge({ ...item, summary: 'Post says a vitamin cures colds' }, deps))
      .predictionId!;
    await resolvePrediction(a, { verdict: 'rejected', by: 'ada' }, resolveDeps(store));
    const pending = await listPredictions(store, GRANT, { status: 'pending' }, NOW);
    expect(pending.map((p) => p.id)).toEqual([b]);
    const resolved = await listPredictions(store, GRANT, { status: 'resolved' }, NOW);
    expect(resolved.map((p) => p.id)).toEqual([a]);
    const later = new Date('2027-01-01T00:00:00.000Z');
    expect(await listPredictions(store, GRANT, { status: 'pending' }, later)).toEqual([]);
    // A later judging call deletes the expired, unresolved one.
    await judge(item, { ...deps, now: later });
    expect(await store.getPrediction!(GRANT, b)).toBeNull();
    expect(await store.getPrediction!(GRANT, a)).not.toBeNull();
  });
});

describe('predictions: forget wins', () => {
  const words = (p: Prediction | null) => JSON.stringify(p);

  it('prediction.withdrawing-a-precedent-purges-the-text', async () => {
    const { store, deps, precedents, item } = await setup();
    const id = (await judge({ ...item, details: 'Seen on a wellness blog.' }, deps)).predictionId!;
    expect(await withdrawJudgment(store, GRANT, precedents[0]!, 'operator', NOW)).toBe(true);
    const p = await getPrediction(store, GRANT, id);
    expect(p.purged).toEqual({ at: NOW.toISOString(), by: 'operator' });
    expect(words(p)).not.toMatch(/vitamin|wellness|no-source/);
    expect(p.item).toEqual({ summary: '[purged]', domain: 'content' });
    // The numbers stay, and it can no longer be resolved.
    expect(p.verdict).toBe('rejected');
    await expect(
      resolvePrediction(id, { verdict: 'approved', by: 'ada' }, resolveDeps(store)),
    ).rejects.toMatchObject({ kind: 'purged' });
  });

  it('prediction.withdrawing-the-judgment-a-resolve-recorded-purges-its-reason', async () => {
    const { store, deps, item } = await setup();
    const id = (await judge(item, deps)).predictionId!;
    const r = await resolvePrediction(
      id,
      { verdict: 'approved', by: 'ada', reason: 'Parody, clearly labelled.' },
      resolveDeps(store),
    );
    await purgeJudgment(store, GRANT, r.judgment!.memory, 'operator', NOW);
    const p = await getPrediction(store, GRANT, id);
    expect(words(p)).not.toMatch(/Parody|vitamin/);
    expect(p.resolution).toMatchObject({ verdict: 'approved', agrees: false, criteria: [] });
    expect(p.resolution?.reason).toBeUndefined();
  });

  it('prediction.forgetting-a-precedent-or-the-item-leaves-no-text', async () => {
    const { store, deps, precedents, item } = await setup();
    const first = (await judge(item, deps)).predictionId!;
    await forgetMemory({ store, now: NOW }, GRANT, precedents[1]!.id);
    expect(words(await getPrediction(store, GRANT, first))).not.toMatch(/vitamin/);

    const second = (
      await judge({ ...item, summary: 'Post says a miracle remedy cures colds' }, deps)
    ).predictionId!;
    expect(await forgetPrediction(store, GRANT, second)).toBe(true);
    expect(await store.getPrediction!(GRANT, second)).toBeNull();
    await expect(getPrediction(store, GRANT, second)).rejects.toMatchObject({ kind: 'not-found' });
  });
});

describe('predictions: live evaluation', () => {
  it('prediction.live-eval-matches-a-hand-computation', async () => {
    const store = createMemoryStore({ now: () => NOW });
    for (const p of liveFixtures()) await store.putPrediction!(GRANT, p);
    const r = await evaluateLive(store, GRANT, { now: NOW });
    expect(r.resolved).toBe(20);
    expect(r.overall).toEqual({ predicted: 18, agreed: 10, agreement: 0.556 });
    expect(r.suggested).toEqual({ predicted: 12, agreed: 8, agreement: 0.667 });
    expect(r.coverage).toBe(0.6);
    expect(r.bands).toEqual([
      { from: 0, to: 0.5, predicted: 2, agreed: 0, agreement: 0, meanProbability: 0.35 },
      { from: 0.5, to: 0.6, predicted: 2, agreed: 1, agreement: 0.5, meanProbability: 0.525 },
      { from: 0.6, to: 0.7, predicted: 2, agreed: 1, agreement: 0.5, meanProbability: 0.625 },
      { from: 0.7, to: 0.8, predicted: 3, agreed: 1, agreement: 0.333, meanProbability: 0.747 },
      { from: 0.8, to: 0.9, predicted: 4, agreed: 3, agreement: 0.75, meanProbability: 0.84 },
      { from: 0.9, to: 1, predicted: 5, agreed: 4, agreement: 0.8, meanProbability: 0.95 },
    ]);
    expect(r.criteria).toEqual([
      { criterion: 'satire', predicted: 5, disagreed: 4, disagreement: 0.8 },
      { criterion: 'no-source', predicted: 9, disagreed: 2, disagreement: 0.222 },
    ]);
    expect(r.pending).toBe(1);
    expect(r.agentResolvedExcluded).toBe(1);
    expect(r.domains).toEqual({
      content: { resolved: 20, predicted: 18, agreed: 10, agreement: 0.556 },
    });

    const withAgents = evaluatePredictions(liveFixtures(), {
      now: NOW,
      includeAgentResolved: true,
    });
    expect(withAgents.resolved).toBe(21);
    expect(withAgents.bands.at(-1)).toMatchObject({ predicted: 6, agreed: 4 });
  });
});
