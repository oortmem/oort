import * as path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../../test/helpers.js';
import { fakeAdapters } from '../../test/helpers/sdk-fakes.js';
import { createOortWith } from './create.js';
import type { Oort } from './types.js';

/** Predictions from code: judge.apply keeps one, judge.resolve closes it, evalLive reports. */

// In the past: the store lists memories valid at the real time.
const NOW = new Date('2026-11-01T12:00:00.000Z');

async function handles(): Promise<{ expert: Oort; agent: Oort; home: string }> {
  const root = tmpdir('oort-sdk-predictions-');
  const base = {
    mode: 'local' as const,
    home: path.join(root, 'home'),
    env: { HOME: root, OORT_NO_KEYCHAIN: '1' },
    config: { judge: { experts: ['ada'] } },
  };
  const deps = { adapters: fakeAdapters(), now: () => NOW };
  const expert = await createOortWith({ ...base, judge: { role: 'expert' } }, deps as never);
  const agent = await createOortWith(base, deps as never);
  return { expert, agent, home: base.home };
}

async function seed(oort: Oort): Promise<void> {
  for (const subject of [
    'Post says a vitamin cures the flu',
    'Post says a vitamin cures colds overnight',
    'Post says a miracle remedy cures the flu',
  ]) {
    await oort.judge.record({
      subject,
      verdict: 'rejected',
      reason: 'Health claim with no cited source.',
      criteria: ['no-source'],
      domain: 'content',
      by: 'ada',
    });
  }
}

/**
 * A copy of prediction `of`, resolved by an agent and unconfirmed, written straight into the
 * store file under an id that starts with `like`'s first eight characters. Returns its id.
 */
function agentResolvedCopy(home: string, of: string, like: string): string {
  const c = like.slice(9, 13) === 'ffff' ? '0000' : 'ffff';
  const pid = `${like.slice(0, 8)}-${c}-4000-8000-000000000000`;
  const db = new Database(path.join(home, 'oort.sqlite'));
  try {
    const row = db.prepare('SELECT record FROM predictions WHERE id = ?').get(of) as {
      record: string;
    };
    const record = {
      ...(JSON.parse(row.record) as object),
      id: pid,
      resolution: {
        verdict: 'approved',
        criteria: [],
        by: 'ada',
        at: NOW.toISOString(),
        via: 'mcp',
        agrees: false,
      },
    };
    db.prepare(
      `INSERT INTO predictions SELECT ?, level, org_id, customer_id, agent_id, hive_id, run_id,
         project_id, author_agent_id, created_at, expires_at, 1, ? FROM predictions WHERE id = ?`,
    ).run(pid, JSON.stringify(record), of);
  } finally {
    db.close();
  }
  return pid;
}

const item = { summary: 'Post says a vitamin cures the flu fast', domain: 'content' };

describe('sdk predictions', () => {
  it('sdk.predictions.apply-resolve-and-eval', async () => {
    const { expert, agent } = await handles();
    await seed(expert);
    const r = await expert.judge.apply(item);
    expect(r.predictionId).toEqual(expect.any(String));
    const pending = await expert.judge.listPredictions();
    expect(pending.predictions.map((p) => p.id)).toEqual([r.predictionId]);
    expect(pending.predictions[0]).toMatchObject({
      state: 'pending',
      item: { summary: item.summary, domain: 'content' },
      verdicts: ['approved', 'rejected'],
    });

    const reason = 'Satire account, labelled as parody.';
    const resolved = await expert.judge.resolve(r.predictionId!, {
      verdict: 'approved',
      reason,
      by: 'ada',
    });
    expect(resolved.agrees).toBe(r.prediction === undefined ? null : false);
    expect(resolved.judgment).toMatchObject({ outcome: 'added', status: 'recorded' });
    expect(resolved.prediction).toMatchObject({
      state: 'resolved',
      resolution: { verdict: 'approved', reason, by: 'ada', via: 'sdk', agentRecorded: false },
    });
    const listed = await expert.judge.list();
    expect(listed.judgments.find((j) => j.id === resolved.judgment!.id)).toMatchObject({ reason });

    await expect(
      expert.judge.resolve(r.predictionId!, { verdict: 'approved', by: 'ada' }),
    ).rejects.toMatchObject({ code: 'refused', reason: 'already-resolved' });
    await expect(
      expert.judge.resolve('00000000-dead', { verdict: 'approved', by: 'ada' }),
    ).rejects.toMatchObject({ code: 'not-found' });

    const report = await expert.judge.evalLive();
    expect(report.resolved).toBe(1);
    expect(report.pending).toBe(0);
    expect((await expert.judge.getPrediction(r.predictionId!)).state).toBe('resolved');
    expect(await expert.judge.forgetPrediction(r.predictionId!)).toEqual({
      id: r.predictionId,
      forgotten: true,
    });
    await expect(expert.judge.getPrediction(r.predictionId!)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expert.close();
    await agent.close();
  });

  it('sdk.predictions.an-agent-resolve-is-unconfirmed-until-an-expert-confirms', async () => {
    const { expert, agent } = await handles();
    await seed(expert);
    const r = await agent.judge.apply(item);
    await expect(
      agent.judge.resolve(r.predictionId!, { verdict: 'approved', by: 'bo', reason: 'No.' }),
    ).rejects.toMatchObject({ code: 'refused', reason: 'not-an-expert' });
    // The agent role names a prediction by its whole id.
    await expect(
      agent.judge.resolve(r.predictionId!.slice(0, 8), { verdict: 'approved', by: 'ada' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    // It may forget a pending prediction, never a resolved one.
    const spare = await agent.judge.apply({ ...item, summary: 'Post says a vitamin cures colds' });
    expect(await agent.judge.forgetPrediction(spare.predictionId!)).toEqual({
      id: spare.predictionId,
      forgotten: true,
    });
    const resolved = await agent.judge.resolve(r.predictionId!, {
      verdict: 'approved',
      by: 'ada',
      reason: 'Labelled satire.',
    });
    expect(resolved.prediction.resolution).toMatchObject({ via: 'mcp', agentRecorded: true });
    expect(resolved.judgment?.status).toBe('agent-recorded');
    expect((await expert.judge.evalLive()).agentResolvedExcluded).toBe(1);
    await expect(agent.judge.forgetPrediction(r.predictionId!)).rejects.toMatchObject({
      code: 'refused',
      reason: 'expert-only',
    });
    await expect(agent.judge.confirm(r.predictionId!)).rejects.toMatchObject({
      reason: 'expert-only',
    });
    expect(await expert.judge.confirm(r.predictionId!)).toEqual({
      id: r.predictionId,
      changed: true,
    });
    const after = await expert.judge.evalLive();
    expect(after.resolved).toBe(1);
    expect(after.agentResolvedExcluded).toBe(0);
    const j = (await expert.judge.list()).judgments.find((x) => x.id === resolved.judgment!.id);
    expect(j?.confirmed).toBe(true);
    await expert.close();
    await agent.close();
  });
  it('sdk.predictions.confirm-refuses-a-prefix-of-both-a-judgment-and-a-prediction', async () => {
    const { expert, agent, home } = await handles();
    await seed(expert);
    const jid = (await expert.judge.list()).judgments[0]!.id;
    const r = await expert.judge.apply(item);
    // A copy of that prediction, resolved by an agent, whose id starts like the judgment's.
    const pid = agentResolvedCopy(home, r.predictionId!, jid);
    await expect(expert.judge.confirm(jid.slice(0, 8))).rejects.toMatchObject({
      code: 'ambiguous-id',
      message: expect.stringMatching(/both a judgment and a prediction/),
    });
    expect((await expert.judge.getPrediction(pid)).resolution?.agentRecorded).toBe(true);
    expect((await expert.judge.evalLive()).agentResolvedExcluded).toBe(1);
    expect(await expert.judge.confirm(pid)).toEqual({ id: pid, changed: true });
    expect((await expert.judge.evalLive()).agentResolvedExcluded).toBe(0);
    await expert.close();
    await agent.close();
  });
  it('sdk.predictions.confirm-with-a-prefix-of-another-kind-of-memory-confirms-the-prediction', async () => {
    const { expert, agent, home } = await handles();
    await seed(expert);
    const fact = (await expert.remember(['The team ships on Fridays.'])).results[0]!.id!;
    expect(fact).toEqual(expect.any(String));
    const r = await expert.judge.apply(item);
    const pid = agentResolvedCopy(home, r.predictionId!, fact);
    // The prefix names a memory that is not a judgment, and a prediction: the prediction.
    expect(await expert.judge.confirm(fact.slice(0, 8))).toEqual({ id: pid, changed: true });
    expect((await expert.judge.getPrediction(pid)).resolution?.agentRecorded).toBe(false);
    await expert.close();
    await agent.close();
  });
});
