import { describe, expect, it } from 'vitest';
import type { JudgeChoice, JudgeRequest } from './adapters.js';
import { confirmFeedback, FeedbackError, recordFeedback } from './feedback.js';
import { localGrant } from './grant.js';
import {
  confirmJudgment,
  formatJudgmentPack,
  importJudgmentPack,
  JudgmentInputError,
  judge,
  labelOf,
  labelOrigin,
  parseJudgmentPack,
  recordJudgment,
  type Judgment,
  type JudgmentInput,
} from './judgment.js';
import { createMemoryStore } from './memory-store.js';
import type { Memory, Scope } from './model.js';
import { confirmResolution, resolvePrediction } from './prediction.js';
import { makeMemory, TG } from './store-conformance.js';

/** How a label arrived: recorded on judgments, resolves, confirms and feedback, never trusted from an agent. */

const NOW = new Date('2026-11-16T12:00:00.000Z');
const SCOPE: Scope = { orgId: 'local', customerId: 'self', agentId: 'claude-code' };
const GRANT = localGrant({ ...SCOPE, projectIds: [null] });

const ada = (over: Partial<JudgmentInput> = {}): JudgmentInput => ({
  subject: 'Post says a vitamin cures the flu',
  verdict: 'rejected',
  reason: 'Health claim with no cited source.',
  criteria: ['no-source'],
  domain: 'content',
  by: 'ada',
  decidedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const decider = {
  async judge(req: JudgeRequest): Promise<JudgeChoice> {
    const probabilities = Object.fromEntries(
      req.verdicts.map((v) => [v, v === 'rejected' ? 0.9 : 0.1]),
    );
    return { verdict: 'rejected', probability: 0.9, probabilities, decisions: [] };
  },
};

async function withPrediction() {
  const store = createMemoryStore({ now: () => NOW });
  for (const subject of [
    'Post says a vitamin cures the flu',
    'Post says a vitamin cures colds overnight',
    'Post says a miracle remedy cures the flu',
  ]) {
    await recordJudgment(ada({ subject }), {
      store,
      grant: GRANT,
      scope: SCOPE,
      now: NOW,
      via: 'cli',
    });
  }
  const r = await judge(
    { summary: 'Post says a vitamin cures the flu fast', domain: 'content' },
    { store, grant: GRANT, decide: decider, now: NOW, keep: { scope: SCOPE } },
  );
  return { store, id: r.predictionId! };
}

describe('label origin', () => {
  it('label.of-checks-the-source-and-never-trusts-an-agent', () => {
    expect(labelOf(undefined, false)).toEqual({ origin: 'integration' });
    expect(labelOf({ origin: 'interactive' }, false)).toEqual({ origin: 'interactive' });
    expect(labelOf({ origin: 'integration', reviewer: '  grace  ' }, false)).toEqual({
      origin: 'integration',
      reviewer: 'grace',
    });
    expect(
      labelOf({ origin: 'connector', upstream: { system: 'jira', actor: 'grace' } }, false),
    ).toEqual({ origin: 'connector', upstream: { system: 'jira', actor: 'grace' } });
    expect(labelOf({ origin: 'dashboard', reviewer: 'grace' }, false)).toMatchObject({
      origin: 'dashboard',
    });
    // An agent's label is `agent`, whatever it asked for; nothing it passed is even checked.
    expect(
      labelOf({ origin: 'interactive', reviewer: 'x'.repeat(500), upstream: null as never }, true),
    ).toEqual({ origin: 'agent' });
    // The reviewer is scrubbed, one line, at most 120 characters.
    expect(
      labelOf({ origin: 'integration', reviewer: 'key sk-ant-api03-' + 'a'.repeat(40) }, false)
        .reviewer,
    ).not.toContain('sk-ant');
    expect(() => labelOf({ origin: 'integration', reviewer: 'a\nb' }, false)).toThrow(
      JudgmentInputError,
    );
    expect(() => labelOf({ origin: 'integration', reviewer: 'x'.repeat(121) }, false)).toThrow(
      /120/,
    );
    expect(() => labelOf({ origin: 'integration', reviewer: '' }, false)).toThrow(/reviewer/);
    expect(() => labelOf({ origin: 'person' as never }, false)).toThrow(/origin must be one of/);
    expect(() =>
      labelOf({ origin: 'integration', upstream: { system: 'jira', actor: 'g' } }, false),
    ).toThrow(/only for the connector/);
    expect(() =>
      labelOf({ origin: 'connector', upstream: { system: 'jira' } as never }, false),
    ).toThrow(/upstream.actor/);
  });

  it('label.reads-integration-without-an-origin', () => {
    expect(labelOrigin({})).toBe('integration');
    expect(labelOrigin(undefined)).toBe('integration');
    expect(labelOrigin({ origin: 'agent' })).toBe('agent');
  });

  it('label.judgment-records-its-origin', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const deps = { store, grant: GRANT, scope: SCOPE, now: NOW };
    const typed = await recordJudgment(ada({ ref: 'a' }), {
      ...deps,
      via: 'cli',
      label: { origin: 'interactive' },
    });
    expect(typed.memory.judgment).toMatchObject({ via: 'cli', origin: 'interactive' });
    const sdk = await recordJudgment(ada({ ref: 'b' }), {
      ...deps,
      via: 'sdk',
      label: { origin: 'integration', reviewer: 'grace' },
    });
    expect(sdk.memory.judgment).toMatchObject({ origin: 'integration', reviewer: 'grace' });
    const plain = await recordJudgment(ada({ ref: 'c' }), { ...deps, via: 'cli' });
    expect(plain.memory.judgment?.origin).toBe('integration');
    const agent = await recordJudgment(ada({ ref: 'd' }), {
      ...deps,
      via: 'mcp',
      label: { origin: 'interactive', reviewer: 'grace' },
    });
    expect(agent.memory.judgment?.origin).toBe('agent');
    expect(agent.memory.judgment?.reviewer).toBeUndefined();
    // Stored as written.
    expect((await store.get(GRANT, agent.memory.id))?.judgment?.origin).toBe('agent');
  });

  it('label.judgment-confirm-keeps-the-proposed-origin', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const r = await recordJudgment(ada({ ref: 'x' }), {
      store,
      grant: GRANT,
      scope: SCOPE,
      now: NOW,
      via: 'mcp',
    });
    expect(
      await confirmJudgment(store, GRANT, r.memory, 'ada', NOW, { origin: 'interactive' }),
    ).toBe(true);
    const j = (await store.get(GRANT, r.memory.id))!.judgment!;
    expect(j).toMatchObject({ origin: 'interactive', proposedOrigin: 'agent', via: 'mcp' });
    expect(j.confirmed?.by).toBe('ada');
    // Authority is unchanged: a bad label is refused before anything is written.
    const other = await recordJudgment(ada({ ref: 'y' }), {
      store,
      grant: GRANT,
      scope: SCOPE,
      now: NOW,
      via: 'mcp',
    });
    await expect(
      confirmJudgment(store, GRANT, other.memory, 'ada', NOW, { origin: 'nope' as never }),
    ).rejects.toBeInstanceOf(JudgmentInputError);
    expect((await store.get(GRANT, other.memory.id))!.judgment!.confirmed).toBeUndefined();
  });

  it('label.confirm-of-an-old-agent-row-proposes-agent', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const r = await recordJudgment(ada({ ref: 'old' }), {
      store,
      grant: GRANT,
      scope: SCOPE,
      now: NOW,
      via: 'mcp',
    });
    // As an older build wrote it: no origin.
    const { origin: _o, ...j } = r.memory.judgment!;
    const old: Memory = { ...r.memory, judgment: j as Judgment };
    await store.upsert(GRANT, old);
    expect(labelOrigin((await store.get(GRANT, old.id))!.judgment)).toBe('integration');
    await confirmJudgment(store, GRANT, old, 'ada', NOW);
    expect((await store.get(GRANT, old.id))!.judgment).toMatchObject({
      origin: 'integration',
      proposedOrigin: 'agent',
    });
  });

  it('label.resolve-and-its-judgment-record-the-origin', async () => {
    const { store, id } = await withPrediction();
    const r = await resolvePrediction(
      id,
      { verdict: 'approved', reason: 'A satire account, labelled as such.', by: 'ada' },
      {
        store,
        grant: GRANT,
        scope: SCOPE,
        now: NOW,
        via: 'sdk',
        label: { origin: 'integration', reviewer: 'grace' },
      },
    );
    expect(r.prediction.resolution).toMatchObject({ origin: 'integration', reviewer: 'grace' });
    expect(r.judgment?.memory.judgment).toMatchObject({ origin: 'integration', reviewer: 'grace' });
  });

  it('label.agent-resolve-confirmed-at-a-terminal', async () => {
    const { store, id } = await withPrediction();
    const r = await resolvePrediction(
      id,
      { verdict: 'approved', reason: 'A satire account, labelled as such.', by: 'ada' },
      {
        store,
        grant: GRANT,
        scope: SCOPE,
        now: NOW,
        via: 'mcp',
        label: { origin: 'interactive', reviewer: 'grace' },
      },
    );
    expect(r.prediction.resolution?.origin).toBe('agent');
    expect(r.prediction.resolution?.reviewer).toBeUndefined();
    expect(r.judgment?.memory.judgment?.origin).toBe('agent');
    expect(await confirmResolution(store, GRANT, id, 'ada', NOW, { origin: 'interactive' })).toBe(
      true,
    );
    const p = await store.getPrediction!(GRANT, id);
    expect(p?.resolution).toMatchObject({ origin: 'interactive', proposedOrigin: 'agent' });
    expect((await store.get(GRANT, r.judgment!.memory.id))?.judgment).toMatchObject({
      origin: 'interactive',
      proposedOrigin: 'agent',
    });
  });

  it('label.feedback-records-and-confirm-keeps-the-proposed-origin', async () => {
    const store = createMemoryStore({ now: () => NOW });
    await store.upsert(TG, makeMemory({ id: 'm1' }));
    const deps = { store, grant: TG, scope: SCOPE, now: NOW };
    const person = await recordFeedback(
      { memoryId: 'm1', signal: 'irrelevant', query: 'q', by: 'ada' },
      { ...deps, via: 'cli', label: { origin: 'interactive' } },
    );
    expect(person.kept && person.feedback.origin).toBe('interactive');
    const agent = await recordFeedback(
      { memoryId: 'm1', signal: 'wrong', by: 'claude-code' },
      { ...deps, via: 'mcp', label: { origin: 'dashboard', reviewer: 'grace' } },
    );
    if (!agent.kept) throw new Error('not kept');
    expect(agent.feedback).toMatchObject({ origin: 'agent', status: 'pending' });
    expect(agent.feedback.reviewer).toBeUndefined();
    const done = await confirmFeedback(agent.feedback.id, {
      store,
      grant: TG,
      by: 'ada',
      now: NOW,
      label: { origin: 'integration', reviewer: 'grace' },
    });
    expect(done).toMatchObject({
      origin: 'integration',
      reviewer: 'grace',
      proposedOrigin: 'agent',
      status: 'open',
    });
    expect(await store.getFeedback!(TG, done.id)).toMatchObject({ proposedOrigin: 'agent' });
    // A bad label is an input problem, and nothing is written.
    await expect(
      recordFeedback(
        { memoryId: 'm1', signal: 'helped', by: 'ada' },
        { ...deps, via: 'sdk', label: { origin: 'integration', reviewer: 'a\nb' } },
      ),
    ).rejects.toMatchObject({ kind: 'invalid' });
    await expect(
      recordFeedback(
        { memoryId: 'm1', signal: 'helped', by: 'ada' },
        { ...deps, via: 'sdk', label: { origin: 'robot' as never } },
      ),
    ).rejects.toBeInstanceOf(FeedbackError);
  });

  it('label.packs-carry-no-origin-and-import-as-integration', async () => {
    const store = createMemoryStore({ now: () => NOW });
    await recordJudgment(ada(), {
      store,
      grant: GRANT,
      scope: SCOPE,
      now: NOW,
      via: 'sdk',
      label: { origin: 'integration', reviewer: 'grace' },
    });
    const text = formatJudgmentPack(await store.list(GRANT), {
      name: 'content',
      exportedBy: 'claude-code',
      exportedAt: NOW,
    });
    expect(text).not.toContain('origin');
    expect(text).not.toContain('grace');
    const into = createMemoryStore({ now: () => NOW });
    const r = await importJudgmentPack(parseJudgmentPack(text), {
      store: into,
      grant: GRANT,
      scope: SCOPE,
      now: NOW,
      label: { origin: 'interactive' },
    });
    expect((await into.get(GRANT, r.added[0]!))?.judgment?.origin).toBe('integration');
  });
});
