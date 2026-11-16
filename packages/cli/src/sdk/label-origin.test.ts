import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../../test/helpers.js';
import { fakeAdapters } from '../../test/helpers/sdk-fakes.js';
import { createOortWith } from './create.js';
import { OortUsageError } from './errors.js';
import type { Oort } from './types.js';

/**
 * How a label arrived, from code: an expert-role handle records `integration` with the reviewer
 * the integration asserts; an agent-role handle records `agent`, and a reviewer it passes is
 * ignored. A confirm records the confirmer's origin and keeps the agent's as `proposedOrigin`.
 */

const NOW = new Date('2026-11-01T12:00:00.000Z');

async function handles(): Promise<{ expert: Oort; agent: Oort }> {
  const root = tmpdir('oort-sdk-origin-');
  const base = {
    mode: 'local' as const,
    home: path.join(root, 'home'),
    env: { HOME: root, OORT_NO_KEYCHAIN: '1' },
    config: { judge: { experts: ['ada'] } },
  };
  const deps = { adapters: fakeAdapters(), now: () => NOW };
  const expert = await createOortWith(
    { ...base, judge: { role: 'expert', operator: 'ada' } },
    deps as never,
  );
  const agent = await createOortWith(base, deps as never);
  return { expert, agent };
}

const judgment = (subject: string, reviewer?: string) => ({
  subject,
  verdict: 'rejected',
  reason: 'Health claim with no cited source.',
  criteria: ['no-source'],
  domain: 'content',
  by: 'ada',
  ...(reviewer !== undefined && { reviewer }),
});

async function seed(oort: Oort): Promise<void> {
  for (const subject of [
    'Post says a vitamin cures the flu',
    'Post says a vitamin cures colds overnight',
    'Post says a miracle remedy cures the flu',
  ]) {
    await oort.judge.record(judgment(subject));
  }
}

const listed = async (oort: Oort, subject: string) =>
  (await oort.judge.list({ all: true })).judgments.find((j) => j.subject.summary === subject);

describe('oort.judge: label origin', () => {
  it('sdk.origin-expert-records-integration-with-its-reviewer', async () => {
    const { expert } = await handles();
    await expert.judge.record(judgment('Reviewed post', '  grace@example.test  '));
    await expert.judge.record(judgment('Unreviewed post'));
    expect(await listed(expert, 'Reviewed post')).toMatchObject({
      origin: 'integration',
      reviewer: 'grace@example.test',
    });
    const plain = await listed(expert, 'Unreviewed post');
    expect(plain?.origin).toBe('integration');
    expect(plain?.reviewer).toBeUndefined();
    // The reviewer is checked in expert role: one line, at most 120 characters.
    await expect(expert.judge.record(judgment('Bad', 'grace\nmallory'))).rejects.toBeInstanceOf(
      OortUsageError,
    );
    await expect(expert.judge.record(judgment('Long', 'g'.repeat(121)))).rejects.toBeInstanceOf(
      OortUsageError,
    );
  });

  it('sdk.origin-agent-records-agent-and-ignores-a-reviewer', async () => {
    const { expert, agent } = await handles();
    const r = await agent.judge.record(judgment('Agent post', 'grace'));
    expect(r.status).toBe('agent-recorded');
    // Not checked either: it is never stored.
    await agent.judge.record(judgment('Agent post two', 'grace\nmallory'));
    for (const subject of ['Agent post', 'Agent post two']) {
      const j = await listed(expert, subject);
      expect(j, subject).toMatchObject({ origin: 'agent', agentRecorded: true });
      expect(j?.reviewer, subject).toBeUndefined();
    }

    const done = await expert.judge.confirm(r.id, { reviewer: 'grace' });
    expect(done.changed).toBe(true);
    expect(await listed(expert, 'Agent post')).toMatchObject({
      origin: 'integration',
      reviewer: 'grace',
      proposedOrigin: 'agent',
      agentRecorded: false,
    });
    await expect(expert.judge.confirm(r.id, { by: 'x' } as never)).rejects.toBeInstanceOf(
      OortUsageError,
    );
  });

  it('sdk.origin-resolve-and-confirm', async () => {
    const { expert, agent } = await handles();
    await seed(expert);
    const a = await expert.judge.apply({
      summary: 'Satire says a vitamin cures the flu',
      domain: 'content',
    });
    const b = await expert.judge.apply({
      summary: 'Parody says a vitamin cures colds',
      domain: 'content',
    });
    const byExpert = await expert.judge.resolve(a.predictionId!, {
      verdict: 'approved',
      by: 'ada',
      reason: 'Labelled satire.',
      reviewer: 'grace',
    });
    expect(byExpert.prediction.resolution).toMatchObject({
      origin: 'integration',
      reviewer: 'grace',
    });
    expect(await listed(expert, 'Satire says a vitamin cures the flu')).toMatchObject({
      origin: 'integration',
      reviewer: 'grace',
    });

    const byAgent = await agent.judge.resolve(b.predictionId!, {
      verdict: 'approved',
      by: 'ada',
      reason: 'Labelled parody.',
      reviewer: 'grace',
    });
    expect(byAgent.prediction.resolution).toMatchObject({ origin: 'agent', agentRecorded: true });
    expect(byAgent.prediction.resolution?.reviewer).toBeUndefined();
    await expert.judge.confirm(b.predictionId!);
    const p = await expert.judge.getPrediction(b.predictionId!);
    expect(p.resolution).toMatchObject({ origin: 'integration', proposedOrigin: 'agent' });
    expect(await listed(expert, 'Parody says a vitamin cures colds')).toMatchObject({
      origin: 'integration',
      proposedOrigin: 'agent',
    });
  });
});

describe('oort.feedback: label origin', () => {
  it('sdk.origin-feedback-expert-agent-and-confirm', async () => {
    const { expert, agent } = await handles();
    const saved = await expert.remember(['The staging database is postgres 16.']);
    const memoryId = saved.results[0]!.id!;
    const mine = await expert.feedback({ memoryId, signal: 'helped', reviewer: 'grace' });
    expect(mine).toMatchObject({
      kept: true,
      feedback: { origin: 'integration', reviewer: 'grace' },
    });
    const theirs = await agent.feedback({ memoryId, signal: 'stale', reviewer: 'grace' });
    if (!theirs.kept) throw new Error('not kept');
    expect(theirs.feedback).toMatchObject({ origin: 'agent', status: 'pending' });
    expect(theirs.feedback.reviewer).toBeUndefined();
    const confirmed = await expert.feedback.confirm(theirs.feedback.id, { reviewer: 'grace' });
    expect(confirmed).toMatchObject({
      origin: 'integration',
      reviewer: 'grace',
      proposedOrigin: 'agent',
      status: 'open',
    });
    const rows = (await agent.feedback.list({})).feedback;
    expect(rows.find((f) => f.id === theirs.feedback.id)).toMatchObject({
      proposedOrigin: 'agent',
    });
    await expect(
      expert.feedback({ memoryId, signal: 'helped', reviewer: 'a\nb' }),
    ).rejects.toBeInstanceOf(OortUsageError);
  });
});
