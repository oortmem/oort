import { describe, expect, it } from 'vitest';
import type { DecisionController, Embedder } from '@oortmem/core';
import { livePredictionFixtures, makePrediction } from '@oortmem/core/store-conformance';
import { data, fakeDecide, harness, type Harness } from '../test/helpers.js';
import { reserveAgentJudgment } from './judge-cap.js';
import { localBackend } from './mcp.js';
import { writeGrant } from './util.js';

/** `oort judge resolve`, `predictions`, `eval --live` and the MCP `resolve_prediction` tool. */

const topicEmbedder: Embedder = {
  dimension: 4,
  async embed(texts) {
    return texts.map((t) =>
      /\b(cure|cures|remedy|vitamin)\b/i.test(t)
        ? Int8Array.from([100, 0, 0, 0])
        : Int8Array.from([0, 0, 0, 100]),
    );
  },
};

function judging(): Harness {
  const h = harness();
  const decide: DecisionController = {
    ...fakeDecide,
    async judge(req) {
      const probabilities = Object.fromEntries(
        req.verdicts.map((v) => [v, v === 'rejected' ? 0.9 : 0.1 / (req.verdicts.length - 1)]),
      );
      return { verdict: 'rejected', probability: 0.9, probabilities, decisions: [] };
    },
  };
  const base = h.wire;
  h.wire = async (dir, o) => ({ ...(await base(dir, o)), decide, embed: topicEmbedder });
  return h;
}

async function seed(h: Harness): Promise<void> {
  for (const subject of [
    'Post says a vitamin cures the flu',
    'Ad says a miracle remedy cures back pain',
    'Post says a vitamin cures colds',
  ]) {
    const r = await h.run([
      'judge',
      'record',
      '--subject',
      subject,
      '--verdict',
      'rejected',
      '--reason',
      'Health claim with no cited source.',
      '--criteria',
      'no-source',
      '--domain',
      'content',
      '--by',
      'ada',
    ]);
    expect(r.code).toBe(0);
  }
}

async function apply(h: Harness, item: string): Promise<string> {
  const r = await h.run(['judge', 'apply', item, '--domain', 'content', '--json']);
  expect(r.code).toBe(0);
  const id = data<{ predictionId: string }>(r.io.stdout).predictionId;
  expect(id).toEqual(expect.any(String));
  return id;
}

describe('oort judge resolve', () => {
  it('cli.judge-resolve-records-a-disagreement-as-a-judgment', async () => {
    const h = judging();
    await seed(h);
    const shown = await h.run(['judge', 'apply', 'Blog says a vitamin cures the flu fast']);
    expect(shown.code).toBe(0);
    expect(shown.io.stdout).toMatch(/Kept as prediction [0-9a-f]{8}\. When the expert decides/);
    const id = await apply(h, 'Satire site says a vitamin cures the flu');

    const listed = await h.run(['judge', 'predictions']);
    expect(listed.io.stdout).toContain(id.slice(0, 8));
    expect(listed.io.stdout).toMatch(/predicted rejected at 0\.90/);

    const reason = 'Satire account, labelled as parody.';
    // `oort judgment` is the same command as `oort judge`.
    const r = await h.run([
      'judgment',
      'resolve',
      id.slice(0, 8),
      '--verdict',
      'approved',
      '--reason',
      reason,
      '--criteria',
      'satire',
      '--by',
      'ada',
    ]);
    expect(r.code).toBe(0);
    expect(r.io.stdout).toMatch(/Resolved [0-9a-f]{8} as approved: the prediction was rejected\./);
    expect(r.io.stdout).toMatch(/recorded as judgment [0-9a-f]{8}, word for word/);

    const judgments = await h.run(['judge', 'list', '--json']);
    const made = data<{ judgments: { reason: string; verdict: string; via: string }[] }>(
      judgments.io.stdout,
    ).judgments.find((j) => j.reason === reason);
    expect(made).toMatchObject({ verdict: 'approved', via: 'cli' });

    // The next judging call on a similar item cites it.
    const again = await h.run([
      'judge',
      'apply',
      'Satire site says a vitamin cures colds',
      '--domain',
      'content',
      '--json',
    ]);
    const precedents = data<{ precedents: { reason: string }[] }>(again.io.stdout).precedents;
    expect(precedents.map((p) => p.reason)).toContain(reason);

    const twice = await h.run(['judge', 'resolve', id, '--verdict', 'approved', '--by', 'ada']);
    expect(twice.code).toBe(2);
    expect(twice.io.stderr).toMatch(/already resolved/);
    const unknown = await h.run([
      'judge',
      'resolve',
      'ffffffff',
      '--verdict',
      'approved',
      '--by',
      'ada',
    ]);
    expect(unknown.code).toBe(2);
    expect(unknown.io.stderr).toMatch(/No prediction with that id/);

    const resolved = await h.run(['judge', 'predictions', '--resolved', '--json']);
    expect(
      data<{ predictions: { id: string }[] }>(resolved.io.stdout).predictions.map((p) => p.id),
    ).toEqual([id]);
    const gone = await h.run(['judge', 'forget-prediction', id, '--yes']);
    expect(gone.code).toBe(0);
    expect((await h.run(['judge', 'predictions', '--resolved', '--json'])).io.stdout).not.toContain(
      id,
    );
  });

  it('cli.judge-eval-live-prints-agreement-and-calibration', async () => {
    const h = judging();
    const w = await h.wire(h.cwd);
    for (const p of livePredictionFixtures(w.scope)) await h.store.putPrediction!(writeGrant(w), p);
    const r = await h.run(['judge', 'eval', '--live']);
    expect(r.code).toBe(0);
    const out = r.io.stdout;
    expect(out).toContain('Agreement: 0.556 (10/18 predictions the expert agreed with).');
    expect(out).toContain('Suggested: 0.667 (8/12); coverage 0.600.');
    // band, predicted, agreed, agreement, mean probability: as computed by hand.
    for (const row of [
      ['0.0-0.5', '2', '0', '0.000', '0.350'],
      ['0.5-0.6', '2', '1', '0.500', '0.525'],
      ['0.6-0.7', '2', '1', '0.500', '0.625'],
      ['0.7-0.8', '3', '1', '0.333', '0.747'],
      ['0.8-0.9', '4', '3', '0.750', '0.840'],
      ['0.9-1.0', '5', '4', '0.800', '0.950'],
    ]) {
      expect(out).toMatch(new RegExp(row.map((c) => c.replace('.', '\\.')).join('\\s+')));
    }
    expect(out).toContain('satire: 4 of 5 overruled (0.80)');
    expect(out).toContain('no-source: 2 of 9 overruled (0.22)');
    expect(out).toMatch(/1 agent-recorded decision\(s\) nobody confirmed were left out/);
    const j = await h.run(['judge', 'eval', '--live', '--json']);
    expect(data<{ overall: unknown }>(j.io.stdout).overall).toEqual({
      predicted: 18,
      agreed: 10,
      agreement: 0.556,
    });
    const both = await h.run(['judge', 'eval', 'held-out.csv', '--live']);
    expect(both.code).toBe(2);
    const neither = await h.run(['judge', 'eval']);
    expect(neither.code).toBe(2);
  });

  it('mcp.resolve-prediction-is-unconfirmed-until-a-person-confirms-it', async () => {
    const h = judging();
    await seed(h);
    const w = await h.wire(h.cwd);
    w.config = { ...w.config, judge: { ...w.config.judge, experts: ['ada'] } };
    const b = localBackend({ wired: w });
    const judged = await b.judge!({
      item: 'Satire site says a vitamin cures the flu',
      domain: 'content',
      limit: 5,
      include_imported: false,
      include_agent_recorded: false,
    });
    const id = judged['prediction_id'] as string;
    expect(id).toEqual(expect.any(String));
    await expect(
      b.resolvePrediction!({ prediction_id: id, verdict: 'approved', by: 'bo' }),
    ).rejects.toThrow(/not one of the experts/);
    const r = await b.resolvePrediction!({
      prediction_id: id,
      verdict: 'approved',
      by: 'ada',
      reason: 'Labelled satire.',
    });
    expect(r).toMatchObject({
      prediction_id: id,
      agrees: false,
      status: 'agent-recorded, unconfirmed',
    });
    const live = await h.run(['judge', 'eval', '--live', '--json']);
    expect(data<{ resolved: number; agentResolvedExcluded: number }>(live.io.stdout)).toMatchObject(
      {
        resolved: 0,
        agentResolvedExcluded: 1,
      },
    );
    const confirmed = await h.run(['judge', 'confirm', id.slice(0, 8), '--yes']);
    expect(confirmed.code).toBe(0);
    expect(confirmed.io.stdout).toMatch(/Confirmed the decision on [0-9a-f]{8}/);
    const after = await h.run(['judge', 'eval', '--live', '--json']);
    expect(data<{ resolved: number }>(after.io.stdout).resolved).toBe(1);
    const list = await h.run(['judge', 'list', '--json']);
    const made = data<{ judgments: { reason: string; confirmed?: unknown }[] }>(
      list.io.stdout,
    ).judgments.find((j) => j.reason === 'Labelled satire.');
    expect(made?.confirmed).toBeDefined();
  });
  it('cli.judge-confirm-refuses-a-prefix-of-both-a-judgment-and-a-prediction', async () => {
    const h = judging();
    await seed(h);
    const w = await h.wire(h.cwd);
    const listed = await h.run(['judge', 'list', '--json']);
    const jid = data<{ judgments: { id: string }[] }>(listed.io.stdout).judgments[0]!.id;
    // A prediction an agent resolved, whose id starts like the judgment's.
    const c = jid[6] === 'f' ? '0' : 'f';
    const pid = `${jid.slice(0, 6)}${c}${c}-0000-4000-8000-000000000000`;
    await h.store.putPrediction!(
      writeGrant(w),
      makePrediction({
        id: pid,
        scope: w.scope,
        createdAt: new Date().toISOString(),
        expiresAt: '2099-01-01T00:00:00.000Z',
        resolution: {
          verdict: 'approved',
          criteria: [],
          by: 'ada',
          at: new Date().toISOString(),
          via: 'mcp',
          agrees: false,
        },
      }),
    );
    const both = await h.run(['judge', 'confirm', jid.slice(0, 6), '--yes', '--json']);
    expect(both.code).toBe(2);
    const env = JSON.parse(both.io.stdout) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('ambiguous-id');
    expect(env.error.message).toMatch(/matches both a judgment and a prediction/);
    // Nothing was confirmed.
    expect(
      (await h.store.getPrediction!(writeGrant(w), pid))?.resolution?.confirmed,
    ).toBeUndefined();

    // A longer id names one of them.
    const p = await h.run(['judge', 'confirm', pid.slice(0, 8), '--yes']);
    expect(p.code).toBe(0);
    expect((await h.store.getPrediction!(writeGrant(w), pid))?.resolution?.confirmed).toBeDefined();
    const j = await h.run(['judge', 'confirm', jid, '--yes']);
    expect(j.code).toBe(0);
    expect(j.io.stdout).toMatch(/recorded by a person; there is nothing to confirm/);
  });
  it('mcp.resolve-prediction-needs-the-whole-id-a-slot-only-for-a-judgment-and-a-person-replaces-it', async () => {
    const h = judging();
    await seed(h);
    const w = await h.wire(h.cwd);
    w.config = { ...w.config, judge: { ...w.config.judge, experts: ['ada'] } };
    const b = localBackend({ wired: w });
    const judgeIt = async (item: string) =>
      (
        await b.judge!({
          item,
          domain: 'content',
          limit: 5,
          include_imported: false,
          include_agent_recorded: false,
        })
      )['prediction_id'] as string;
    const id = await judgeIt('Satire site says a vitamin cures the flu');
    // A prefix is for people: the agent gets "no such prediction".
    await expect(
      b.resolvePrediction!({ prediction_id: id.slice(0, 8), verdict: 'approved', by: 'ada' }),
    ).rejects.toThrow(/No prediction with that id/);

    // The day's agent slots are used up: agreeing (no judgment to record) still works.
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 50; i++) await reserveAgentJudgment(w.config.home, day);
    const other = await judgeIt('Satire site says a vitamin cures colds');
    expect(
      await b.resolvePrediction!({
        prediction_id: other,
        verdict: 'rejected',
        by: 'ada',
        reason: 'Agreed: no source.',
      }),
    ).toMatchObject({ agrees: true });
    await expect(
      b.resolvePrediction!({
        prediction_id: id,
        verdict: 'approved',
        by: 'ada',
        reason: 'Satire.',
      }),
    ).rejects.toThrow(/50/);
    // The next day, a different verdict with a reason records a judgment.
    const r = await localBackend({
      wired: w,
      now: () => new Date(Date.now() + 86_400_000),
    }).resolvePrediction!({
      prediction_id: id,
      verdict: 'approved',
      by: 'ada',
      reason: 'Agent says satire.',
    });
    const agentJudgment = r['judgment_id'] as string;
    expect(agentJudgment).toEqual(expect.any(String));

    // A person's resolve replaces the agent's unconfirmed one, and withdraws its judgment.
    const person = await h.run([
      'judge',
      'resolve',
      id.slice(0, 8),
      '--verdict',
      'approved',
      '--reason',
      'Satire, and labelled as such.',
      '--by',
      'ada',
    ]);
    expect(person.code, person.io.stderr).toBe(0);
    const all = data<{ judgments: { id: string; reason: string; withdrawn?: unknown }[] }>(
      (await h.run(['judge', 'list', '--all', '--json'])).io.stdout,
    ).judgments;
    expect(all.find((j) => j.id === agentJudgment)?.withdrawn).toBeDefined();
    expect(all.map((j) => j.reason)).toContain('Satire, and labelled as such.');
    const shown = data<{ resolution: { via: string; verdict: string } }>(
      (await h.run(['judge', 'predictions', '--resolved', '--json'])).io.stdout,
    );
    expect(JSON.stringify(shown)).toContain('"via":"cli"');
  });
});
