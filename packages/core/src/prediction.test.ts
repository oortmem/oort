import { describe, expect, it } from 'vitest';
import type { JudgeChoice, JudgeRequest, MemoryStore } from './adapters.js';
import { forgetMemory } from './forget.js';
import { localGrant } from './grant.js';
import {
  confirmJudgment,
  evaluateJudgments,
  isActiveJudgment,
  isUnconfirmedAgentJudgment,
  judge,
  PredictionPurgeError,
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
import { livePredictionFixtures as liveFixtures, makePrediction } from './store-conformance.js';

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

/** `store`, with `putPrediction` running `before` ahead of its `n`th call (1-based). */
function beforePut(
  store: MemoryStore,
  n: number,
  before: (p: Prediction) => Promise<void>,
): MemoryStore {
  let calls = 0;
  return {
    ...store,
    async putPrediction(grant, p, expect) {
      calls++;
      if (calls === n) await before(p);
      return store.putPrediction!(grant, p, expect);
    },
  };
}

const activeJudgments = async (store: MemoryStore) =>
  (await store.list(GRANT, { validOnly: false, embeddings: false })).filter(
    (m) => m.type === 'judgment' && isActiveJudgment(m, NOW),
  );

describe('predictions: judging keeps what it proposed', () => {
  it('prediction.all-authors-together-are-capped-at-the-node', async () => {
    const { store, deps, item } = await setup();
    // The store counts inside the write: a node-wide cap of one, for the test.
    const real = store.putPrediction!.bind(store);
    store.putPrediction = (g, p, e, c) =>
      real(g, p, e, c === undefined ? c : { ...c, addressPendingCap: 1 });
    const by = (agentId: string) => ({ ...deps, keep: { scope: { ...SCOPE, agentId } } });
    expect(await judge(item, by('claude-code'))).toMatchObject({ kept: true });
    const second = await judge(item, by('cursor'));
    expect(second).toMatchObject({ kept: false, notKept: 'pending-cap' });
    expect(second.predictionId).toBeUndefined();
    expect(await listPredictions(store, GRANT)).toHaveLength(1);
  });

  it('prediction.a-kept-prediction-is-bound-to-the-callers-project', async () => {
    const { store, deps, item } = await setup();
    const inA = { ...SCOPE, projectId: 'proj-a' };
    const a = localGrant({ ...SCOPE, projectIds: ['proj-a', null] });
    const b = localGrant({ ...SCOPE, projectIds: ['proj-b', null] });
    const r = await judge(
      { ...item, details: 'Acme launch copy', ref: 'acme/post-7' },
      { ...deps, grant: a, keep: { scope: inA } },
    );
    expect(r.predictionId).toBeDefined();
    const p = await getPrediction(store, a, r.predictionId!);
    expect(p.scope.projectId).toBe('proj-a');
    expect((await listPredictions(store, a)).map((x) => x.id)).toEqual([r.predictionId]);
    expect(await listPredictions(store, b)).toEqual([]);
    await expect(getPrediction(store, b, r.predictionId!)).rejects.toBeInstanceOf(PredictionError);
  });

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

  it('prediction.judging-answers-without-keeping-above-the-pending-cap-or-on-a-failed-write', async () => {
    const { store, deps, item } = await setup();
    // The store refuses inside the write when a cap is full.
    const full: MemoryStore = { ...store, putPrediction: async () => 'pending-cap' as const };
    const capped = await judge(item, { ...deps, store: full });
    expect(capped).toMatchObject({ status: 'suggested', kept: false, notKept: 'pending-cap' });
    expect(capped.predictionId).toBeUndefined();
    const broken: MemoryStore = {
      ...store,
      putPrediction: async () => {
        throw new Error('disk full');
      },
    };
    const failed = await judge(item, { ...deps, store: broken });
    expect(failed).toMatchObject({ status: 'suggested', kept: false, notKept: 'write-failed' });
    expect(failed.predictionId).toBeUndefined();
    expect(await store.listPredictions!(GRANT)).toEqual([]);
    expect((await judge(item, deps)).kept).toBe(true);
  });

  it('prediction.a-multi-line-item-is-kept-on-one-line-and-resolves-with-a-reason', async () => {
    const { store, deps } = await setup();
    const r = await judge(
      {
        summary: 'Post says a vitamin\ncures the flu\u200b fast',
        ref: 'https://example.test/p\r\n1',
        details: 'Line one.\nLine two.\u202e',
        domain: 'content',
      },
      deps,
    );
    const p = await getPrediction(store, GRANT, r.predictionId!);
    expect(p.item).toMatchObject({
      summary: 'Post says a vitamin cures the flu fast',
      ref: 'https://example.test/p 1',
      details: 'Line one.\nLine two.',
    });
    const done = await resolvePrediction(
      p.id,
      { verdict: 'approved', reason: 'Satire.\nLabelled as parody.', by: 'ada' },
      resolveDeps(store),
    );
    expect(done.judgment?.memory.judgment?.subject.summary).toBe(p.item.summary);
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
    // The loser recorded its judgment, lost the guarded write, and took the judgment back.
    expect((failed.reason as PredictionError).kind).toBe('conflict');
    const judgments = (await store.list(GRANT)).filter((m) => m.type === 'judgment');
    expect(judgments).toHaveLength(4);
    const won = (await getPrediction(store, GRANT, id)).resolution!;
    const reasons = judgments.map((m) => m.judgment!.reason);
    expect(reasons).toContain(won.reason);
    expect(reasons).not.toContain(won.reason === 'One.' ? 'Two.' : 'One.');
    expect(won.judgmentId).toBe(judgments.find((m) => m.judgment!.reason === won.reason)!.id);
  });

  it('prediction.a-failure-between-steps-leaves-no-half-state', async () => {
    const { store, deps, item } = await setup();
    const id = (await judge(item, deps)).predictionId!;
    const before = await snapshot(store);
    // The judgment write fails: nothing was claimed, so the same call works again.
    const noUpsert: MemoryStore = {
      ...store,
      upsert: async () => {
        throw new Error('disk full');
      },
    };
    const input = { verdict: 'approved', by: 'ada', reason: 'Satire.' };
    await expect(
      resolvePrediction(id, input, { ...resolveDeps(store), store: noUpsert }),
    ).rejects.toThrow('disk full');
    expect(await snapshot(store)).toBe(before);
    // The resolve write fails after the judgment was recorded: the judgment is taken back.
    const noResolve = beforePut(store, 1, async () => {
      throw new Error('disk full');
    });
    await expect(
      resolvePrediction(id, input, { ...resolveDeps(store), store: noResolve }),
    ).rejects.toThrow('disk full');
    expect((await getPrediction(store, GRANT, id)).resolution).toBeUndefined();
    expect((await activeJudgments(store)).map((m) => m.judgment!.reason)).not.toContain('Satire.');
    const r = await resolvePrediction(id, input, resolveDeps(store));
    expect(r.prediction.resolution?.judgmentId).toBe(r.judgment!.memory.id);
    expect((await getPrediction(store, GRANT, id)).resolution?.judgmentId).toBe(
      r.judgment!.memory.id,
    );
  });

  it('prediction.a-confirm-racing-a-resolve-gives-conflict-and-no-orphan-judgment', async () => {
    const { store, deps, item } = await setup();
    const id = (await judge(item, deps)).predictionId!;
    await resolvePrediction(
      id,
      { verdict: 'approved', by: 'ada', reason: 'Agent says satire.' },
      resolveDeps(store, 'mcp'),
    );
    // A person's resolve replaces the agent's; a confirm of the agent's lands first.
    const racing = beforePut(store, 1, async () => {
      expect(await confirmResolution(store, GRANT, id, 'grace', NOW)).toBe(true);
    });
    await expect(
      resolvePrediction(
        id,
        { verdict: 'rejected', by: 'ada', reason: 'No, a real claim.' },
        { ...resolveDeps(store), store: racing },
      ),
    ).rejects.toMatchObject({ kind: 'conflict' });
    const reasons = (await activeJudgments(store)).map((m) => m.judgment!.reason);
    expect(reasons).not.toContain('No, a real claim.');
    expect(reasons).toContain('Agent says satire.');

    // Another writer lands between the judgment and the resolve: conflict, judgment taken back.
    const id2 = (await judge({ ...item, summary: 'Post says a vitamin cures colds' }, deps))
      .predictionId!;
    const bump = beforePut(store, 1, async () => {
      const p = await getPrediction(store, GRANT, id2);
      await store.putPrediction!(
        GRANT,
        { ...p, revision: p.revision + 1 },
        { revision: p.revision },
      );
    });
    await expect(
      resolvePrediction(
        id2,
        { verdict: 'approved', by: 'ada', reason: 'Lost the race.' },
        { ...resolveDeps(store), store: bump },
      ),
    ).rejects.toMatchObject({ kind: 'conflict' });
    expect((await activeJudgments(store)).map((m) => m.judgment!.reason)).not.toContain(
      'Lost the race.',
    );
    expect((await getPrediction(store, GRANT, id2)).resolution).toBeUndefined();
  });

  it('prediction.a-person-replaces-an-agents-unconfirmed-resolve', async () => {
    const { store, deps, item } = await setup();
    const id = (await judge(item, deps)).predictionId!;
    const agent = await resolvePrediction(
      id,
      { verdict: 'approved', by: 'ada', reason: 'Agent says satire.' },
      resolveDeps(store, 'mcp'),
    );
    // Another agent resolve does not replace it.
    await expect(
      resolvePrediction(id, { verdict: 'rejected', by: 'ada' }, resolveDeps(store, 'mcp')),
    ).rejects.toMatchObject({ kind: 'already-resolved' });
    const person = await resolvePrediction(
      id,
      { verdict: 'rejected', by: 'ada', reason: 'A real health claim.' },
      resolveDeps(store),
    );
    expect(person.prediction.resolution).toMatchObject({ via: 'cli', verdict: 'rejected' });
    expect(person.prediction.superseded).toEqual([
      expect.objectContaining({ via: 'mcp', verdict: 'approved', by: 'ada' }),
    ]);
    expect(JSON.stringify(person.prediction.superseded)).not.toContain('satire');
    const agentJudgment = (await store.get(GRANT, agent.judgment!.memory.id))!;
    expect(agentJudgment.judgment?.withdrawn).toBeDefined();
    // A confirmed agent resolve stays: a person decides again only through a new prediction.
    const id2 = (await judge({ ...item, summary: 'Post says a vitamin cures colds' }, deps))
      .predictionId!;
    await resolvePrediction(id2, { verdict: 'approved', by: 'ada' }, resolveDeps(store, 'mcp'));
    await confirmResolution(store, GRANT, id2, 'grace', NOW);
    await expect(
      resolvePrediction(id2, { verdict: 'rejected', by: 'ada' }, resolveDeps(store)),
    ).rejects.toMatchObject({ kind: 'already-resolved' });
  });

  it('prediction.a-lost-race-puts-back-the-judgment-a-resolve-corrected', async () => {
    const { store, deps, item } = await setup();
    const ref = 'https://example.test/posts/9';
    const earlier = (
      await recordJudgment(ada({ subject: item.summary, ref }), {
        store,
        grant: GRANT,
        scope: SCOPE,
        now: NOW,
        via: 'cli',
      })
    ).memory;
    const before = await store.get(GRANT, earlier.id);
    const id = (await judge({ ...item, ref }, deps)).predictionId!;
    const bump = beforePut(store, 1, async () => {
      const p = await getPrediction(store, GRANT, id);
      await store.putPrediction!(
        GRANT,
        { ...p, revision: p.revision + 1 },
        { revision: p.revision },
      );
    });
    await expect(
      resolvePrediction(
        id,
        { verdict: 'approved', by: 'ada', reason: 'Satire, labelled.' },
        { ...resolveDeps(store), store: bump },
      ),
    ).rejects.toMatchObject({ kind: 'conflict' });
    // The earlier judgment is current again, exactly as it was; the correction is gone.
    expect(await store.get(GRANT, earlier.id)).toEqual(before);
    expect(isActiveJudgment((await store.get(GRANT, earlier.id))!, NOW)).toBe(true);
    expect((await activeJudgments(store)).map((m) => m.judgment!.reason)).not.toContain(
      'Satire, labelled.',
    );
    // The same resolve, without the race, corrects it.
    const r = await resolvePrediction(
      id,
      { verdict: 'approved', by: 'ada', reason: 'Satire, labelled.' },
      resolveDeps(store),
    );
    expect(r.judgment).toMatchObject({ outcome: 'corrected', supersedes: earlier.id });
  });

  it('prediction.a-lost-race-never-brings-back-what-the-winner-corrected', async () => {
    const { store, deps, item } = await setup();
    const ref = 'https://example.test/posts/10';
    const earlier = (
      await recordJudgment(ada({ subject: item.summary, ref, reason: 'Earlier call.' }), {
        store,
        grant: GRANT,
        scope: SCOPE,
        now: NOW,
        via: 'cli',
      })
    ).memory;
    const id = (await judge({ ...item, ref }, deps)).predictionId!;
    // Both resolves plan against the earlier judgment. The other one lands first, then this one
    // writes its correction and loses the guarded write.
    let calls = 0;
    const racing: MemoryStore = {
      ...store,
      async upsertMany(grant, ms) {
        if (++calls === 1) {
          await resolvePrediction(
            id,
            { verdict: 'approved', by: 'ada', reason: 'Winner says satire.' },
            resolveDeps(store),
          );
        }
        return store.upsertMany(grant, ms);
      },
    };
    await expect(
      resolvePrediction(
        id,
        { verdict: 'approved', by: 'ada', reason: 'Loser says satire.' },
        { ...resolveDeps(store), store: racing },
      ),
    ).rejects.toMatchObject({ kind: 'conflict' });
    expect(isActiveJudgment((await store.get(GRANT, earlier.id))!, NOW)).toBe(false);
    const reasons = (await activeJudgments(store)).map((m) => m.judgment!.reason);
    expect(reasons).toContain('Winner says satire.');
    expect(reasons).not.toContain('Loser says satire.');
    expect(reasons).not.toContain('Earlier call.');
  });

  it('prediction.a-lost-race-never-brings-back-a-judgment-forgotten-meanwhile', async () => {
    const { store, deps, item } = await setup();
    const ref = 'https://example.test/posts/11';
    const earlier = (
      await recordJudgment(ada({ subject: item.summary, ref, reason: 'Private earlier call.' }), {
        store,
        grant: GRANT,
        scope: SCOPE,
        now: NOW,
        via: 'cli',
      })
    ).memory;
    const id = (await judge({ ...item, ref }, deps)).predictionId!;
    const forget = beforePut(store, 1, async () => {
      await forgetMemory({ store, now: NOW }, GRANT, earlier.id);
      const p = await getPrediction(store, GRANT, id).catch(() => null);
      if (p !== null && p.purged === undefined) {
        await store.putPrediction!(
          GRANT,
          { ...p, revision: p.revision + 1 },
          { revision: p.revision },
        );
      }
    });
    await expect(
      resolvePrediction(
        id,
        { verdict: 'approved', by: 'ada', reason: 'Satire, labelled.' },
        { ...resolveDeps(store), store: forget },
      ),
    ).rejects.toBeInstanceOf(PredictionError);
    expect(await store.get(GRANT, earlier.id)).toBeNull();
    const all = await store.list(GRANT, { validOnly: false, embeddings: false });
    expect(JSON.stringify(all)).not.toContain('Private earlier call.');
  });

  it('prediction.a-person-replaces-an-agent-resolve-whose-judgment-they-cannot-withdraw', async () => {
    const { store, deps, item } = await setup();
    const id = (await judge(item, deps)).predictionId!;
    // The agent's judgment lives where the person's grant cannot write (its own Star, say).
    const star: Scope = { orgId: 'local', customerId: 'elsewhere', agentId: 'cursor' };
    const starGrant = localGrant({ ...star, projectIds: [null] });
    const theirs = (
      await recordJudgment(ada({ reason: 'Agent says satire.', verdict: 'approved' }), {
        store,
        grant: starGrant,
        scope: star,
        now: NOW,
        via: 'mcp',
      })
    ).memory;
    const p = await getPrediction(store, GRANT, id);
    await store.putPrediction!(
      GRANT,
      {
        ...p,
        resolution: {
          verdict: 'approved',
          criteria: [],
          by: 'ada',
          at: NOW.toISOString(),
          via: 'mcp',
          agrees: false,
          judgmentId: theirs.id,
        },
        revision: p.revision + 1,
      },
      { revision: p.revision },
    );
    const r = await resolvePrediction(
      id,
      { verdict: 'approved', by: 'ada', reason: 'Satire, and labelled.' },
      resolveDeps(store),
    );
    expect(r).toMatchObject({
      agentJudgmentKept: theirs.id,
      agentJudgmentKeptReason: 'not-writable',
    });
    expect(r.prediction.resolution).toMatchObject({ via: 'cli', reason: 'Satire, and labelled.' });
    const left = (await store.get(starGrant, theirs.id))!;
    expect(left.judgment?.withdrawn).toBeUndefined();
    expect(isUnconfirmedAgentJudgment(left.judgment!)).toBe(true);
  });

  it('prediction.a-person-replaces-an-agent-resolve-but-keeps-a-confirmed-judgment', async () => {
    const { store, deps, item } = await setup();
    const id = (await judge(item, deps)).predictionId!;
    const r = await resolvePrediction(
      id,
      { verdict: 'approved', by: 'ada', reason: 'Agent says satire.' },
      resolveDeps(store, 'mcp'),
    );
    // A person confirmed the judgment itself, but not the resolve.
    const recorded = (await store.get(GRANT, r.judgment!.memory.id))!;
    await confirmJudgment(store, GRANT, recorded, 'grace', NOW);
    const replaced = await resolvePrediction(
      id,
      { verdict: 'approved', by: 'ada', reason: 'Satire, and labelled.' },
      resolveDeps(store),
    );
    expect(replaced).toMatchObject({
      agentJudgmentKept: recorded.id,
      agentJudgmentKeptReason: 'confirmed',
    });
    const left = (await store.get(GRANT, recorded.id))!;
    expect(left.judgment?.withdrawn).toBeUndefined();
    expect(left.judgment?.confirmed?.by).toBe('grace');
  });

  it('prediction.the-verdict-cap-keeps-the-predicted-verdict', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const record = (input: JudgmentInput) =>
      recordJudgment(input, { store, grant: GRANT, scope: SCOPE, now: NOW, via: 'cli' });
    const many = Array.from({ length: 12 }, (_, i) => `label-${String(i).padStart(2, '0')}`);
    // The first precedent alone fills the cap; the predicted verdict comes from the next one.
    const subject = 'Post says a vitamin cures the flu fast';
    await record(
      ada({ subject, verdict: many[0]!, verdicts: many, decidedAt: '2026-10-05T00:00:00.000Z' }),
    );
    await record(ada({ subject, verdicts: ['approved', 'rejected'] }));
    await record(ada({ subject, verdicts: ['approved', 'rejected'], reason: 'Same again.' }));
    const r = await judge(
      { summary: 'Post says a vitamin cures the flu fast', domain: 'content' },
      { store, grant: GRANT, decide: decider('rejected', 0.9), now: NOW, keep: { scope: SCOPE } },
    );
    const p = await getPrediction(store, GRANT, r.predictionId!);
    expect(p.verdict).toBe('rejected');
    expect(p.verdicts).toHaveLength(12);
    expect(p.verdicts[0]).toBe('rejected');
    const done = await resolvePrediction(
      p.id,
      { verdict: 'rejected', by: 'ada' },
      resolveDeps(store),
    );
    expect(done.agrees).toBe(true);
  });

  it('prediction.by-is-scrubbed-on-the-item-and-on-confirm', async () => {
    const { store, deps, item } = await setup();
    const secret = `sk-ant-${'a1B2c3D4e5'.repeat(3)}`;
    const id = (await judge({ ...item, by: `ada ${secret}` }, deps)).predictionId!;
    const p = await getPrediction(store, GRANT, id);
    expect(p.item.by).toBeDefined();
    expect(p.item.by).not.toContain(secret);
    await resolvePrediction(
      id,
      { verdict: 'approved', by: 'ada', reason: 'Labelled satire.' },
      resolveDeps(store, 'mcp'),
    );
    expect(await confirmResolution(store, GRANT, id, `grace ${secret}`, NOW)).toBe(true);
    const confirmed = (await getPrediction(store, GRANT, id)).resolution!.confirmed!;
    expect(confirmed.by).toMatch(/^grace /);
    expect(confirmed.by).not.toContain(secret);
    expect(await snapshot(store)).not.toContain(secret);
  });

  it('prediction.confirm-finishes-a-half-confirmed-state', async () => {
    const { store, deps, item } = await setup();
    const id = (await judge(item, deps)).predictionId!;
    const r = await resolvePrediction(
      id,
      { verdict: 'approved', by: 'ada', reason: 'Labelled satire.' },
      resolveDeps(store, 'mcp'),
    );
    // The judgment is confirmed, then the resolve write fails.
    const broken = beforePut(store, 1, async () => {
      throw new Error('disk full');
    });
    await expect(confirmResolution(broken, GRANT, id, 'grace', NOW)).rejects.toThrow('disk full');
    expect(
      isUnconfirmedAgentJudgment((await store.get(GRANT, r.judgment!.memory.id))!.judgment!),
    ).toBe(false);
    expect((await getPrediction(store, GRANT, id)).resolution?.confirmed).toBeUndefined();
    // The next call finishes it.
    expect(await confirmResolution(store, GRANT, id, 'grace', NOW)).toBe(true);
    expect((await getPrediction(store, GRANT, id)).resolution?.confirmed?.by).toBe('grace');
    await expect(confirmResolution(store, GRANT, id, 'grace\nmallory', NOW)).rejects.toThrow(
      /by holds control characters/,
    );
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

  it('prediction.a-prediction-another-principal-wrote-is-purged-too', async () => {
    const { store, precedents } = await setup();
    const other: Scope = { orgId: 'local', customerId: 'other', agentId: 'cursor' };
    const otherGrant = localGrant({ ...other, projectIds: [null] });
    await store.putPrediction!(
      otherGrant,
      makePrediction({
        id: 'theirs',
        scope: other,
        item: { summary: 'their zanzibar item' },
        precedentIds: [precedents[0]!.id],
      }),
    );
    await withdrawJudgment(store, GRANT, precedents[0]!, 'grace', NOW);
    const p = (await store.getPrediction!(otherGrant, 'theirs'))!;
    expect(p.purged).toBeDefined();
    expect(JSON.stringify(p)).not.toContain('zanzibar');
  });

  it('prediction.a-purge-that-leaves-text-fails-and-changes-no-judgment', async () => {
    const { store, precedents } = await setup();
    const stuck: MemoryStore = {
      ...store,
      purgePredictionsCiting: async () => ({ purged: [], leftover: ['p-left'] }),
    };
    await expect(withdrawJudgment(stuck, GRANT, precedents[0]!, 'grace', NOW)).rejects.toEqual(
      new PredictionPurgeError(['p-left']),
    );
    await expect(
      forgetMemory({ store: stuck, now: NOW }, GRANT, precedents[1]!.id),
    ).rejects.toBeInstanceOf(PredictionPurgeError);
    const [a, b] = await Promise.all([
      store.get(GRANT, precedents[0]!.id),
      store.get(GRANT, precedents[1]!.id),
    ]);
    expect(a?.judgment?.withdrawn).toBeUndefined();
    expect(b).not.toBeNull();
  });

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
