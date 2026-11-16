import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../../test/helpers.js';
import { fakeCloud, seedFakeJudgment, type FakeCloud } from '../../test/helpers/fake-cloud.js';
import { fakeAdapters } from '../../test/helpers/sdk-fakes.js';
import { OortCloudError, cloudErrorKind } from '../cloud.js';
import { cloudJudgmentView, DASHBOARD_JUDGMENTS_URL } from './cloud.js';
import { createOortWith } from './create.js';
import { OortRefusedError, toOortError } from './errors.js';
import type { OortOptions } from './types.js';

/**
 * Judgments in cloud mode: an Oort key acts in the agent role, so the SDK records for the
 * account's listed experts and reads and applies the account's judgments; a person's decisions
 * (confirm, withdraw, the experts list) are the dashboard's. Predictions stay local.
 */

const KEY = ['oort', 'sk', 'judgments'.padEnd(43, 'J')].join('_');
const NOW = '2026-11-05T12:00:00.000Z';

async function cloud(setup: (c: FakeCloud) => void = () => {}, over: OortOptions = {}) {
  const c = fakeCloud(KEY);
  c.judgments.now = () => new Date(NOW);
  setup(c);
  const root = tmpdir('oort-sdk-judge-');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const env = { HOME: root, OORT_HOME: path.join(root, 'home'), OORT_NO_KEYCHAIN: '1' };
  const oort = await createOortWith(
    {
      mode: 'cloud',
      cwd,
      env: { ...env, OORT_API_KEY: KEY },
      fetch: c.fetch,
      keySources: ['env'],
      project: null,
      ...over,
    },
    { now: () => new Date(NOW) },
  );
  return { oort, c };
}

const input = {
  subject: 'Post claims a cure',
  verdict: 'rejected',
  reason: 'No source.',
  domain: 'content',
  by: 'ada',
};

describe('judgments in cloud mode', () => {
  it('sdk.cloud-judge-records-as-an-agent-and-sends-no-role', async () => {
    const { oort, c } = await cloud((c) => (c.judgments.experts = ['ada']));
    const r = await oort.judge.record({ ...input, reviewer: 'grace@example.com' });
    expect(r).toMatchObject({ outcome: 'added', status: 'agent-recorded', redacted: [] });
    // An agent's reviewer is ignored, as locally, so it never leaves the machine.
    expect(c.judgments.records).toEqual([input]);
    expect(c.seen).toEqual(['POST /v1/judgments']);
    const { judgments } = await oort.judge.list();
    expect(judgments).toEqual([
      expect.objectContaining({ id: r.id, via: 'mcp', agentRecorded: true, origin: 'agent' }),
    ]);
    await oort.close();
  });

  it('sdk.cloud-judge-checks-fields-before-sending', async () => {
    const { oort, c } = await cloud((c) => (c.judgments.experts = ['ada']));
    await expect(oort.judge.record({ ...input, subject: 's'.repeat(501) })).rejects.toMatchObject({
      code: 'usage',
      reason: 'invalid-argument',
    });
    expect(c.seen).toEqual([]);
    await oort.close();
  });

  it('sdk.cloud-judge-expert-role-is-refused-before-any-request', async () => {
    const c = fakeCloud(KEY);
    const root = tmpdir('oort-sdk-judge-');
    const err = await createOortWith(
      {
        mode: 'cloud',
        cwd: root,
        env: { HOME: root, OORT_API_KEY: KEY, OORT_NO_KEYCHAIN: '1' },
        fetch: c.fetch,
        keySources: ['env'],
        judge: { role: 'expert', operator: 'grace' },
      },
      {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OortRefusedError);
    expect(err).toMatchObject({ code: 'refused', reason: 'expert-only' });
    expect((err as Error).message).toContain(DASHBOARD_JUDGMENTS_URL);
    expect(c.seen).toEqual([]);
    // The agent role is the cloud's default, and may be stated; an operator is local only.
    const agent = await cloud(() => {}, { judge: { role: 'agent' } });
    await agent.oort.close();
    await expect(
      cloud(() => {}, { judge: { role: 'agent', operator: 'x' } }),
    ).rejects.toMatchObject({ code: 'usage', reason: 'invalid-argument' });
  });

  it('sdk.cloud-judge-maps-the-wire-codes-to-local-reasons', async () => {
    for (const [code, status, reason, retryable] of [
      ['experts_not_listed', 403, 'experts-not-listed', false],
      ['not_an_expert', 403, 'not-an-expert', false],
      ['daily_limit', 403, 'daily-limit', false],
      ['expert_only', 403, 'expert-only', false],
      ['cap_unavailable', 503, 'cap-unavailable', true],
      ['not_current', 409, 'not-current', false],
    ] as const) {
      const e = toOortError(
        new OortCloudError(cloudErrorKind(status, code), status, 'refused', code),
      );
      expect(e, code).toMatchObject({ code: 'refused', reason, status, retryable });
    }
    // Through the transport too: a forced refusal on the record route.
    const { oort } = await cloud((c) => {
      c.judgments.experts = ['ada'];
      c.fail = { 'POST /v1/judgments': { status: 503, code: 'cap_unavailable' } };
    });
    await expect(oort.judge.record(input)).rejects.toMatchObject({
      reason: 'cap-unavailable',
      retryable: true,
    });
    await oort.close();
  });

  it('sdk.cloud-judge-person-decisions-are-refused-by-the-key-role', async () => {
    const { oort, c } = await cloud((c) => (c.judgments.experts = ['ada']));
    const { id } = await oort.judge.record(input);
    for (const call of [
      () => oort.judge.confirm(id),
      () => oort.judge.withdraw(id),
      () => oort.judge.experts.set(['ada', 'grace']),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'refused',
        reason: 'expert-only',
        status: 403,
      });
    }
    expect(c.seen.slice(1)).toEqual([
      `POST /v1/judgments/${id}/confirm`,
      `POST /v1/judgments/${id}/withdraw`,
      'PUT /v1/judgments/experts',
    ]);
    expect(await oort.judge.experts.get()).toEqual({ experts: ['ada'] });
    await oort.close();
  });

  it('sdk.cloud-judge-apply-uses-confirmed-precedents-and-keeps-no-prediction', async () => {
    const { oort, c } = await cloud();
    const at = new Date(Date.parse(NOW) - 86_400_000);
    for (const subject of ['Post claims a miracle cure', 'Post claims a herbal cure']) {
      await seedFakeJudgment(c, { ...input, subject }, at);
    }
    await seedFakeJudgment(c, { ...input, subject: 'Post claims a cure', via: 'mcp' }, at);
    const r = await oort.judge.apply(
      { summary: 'Post claims a secret cure', domain: 'content' },
      { limit: 3 },
    );
    expect(r.precedents.every((p) => !p.agentRecorded)).toBe(true);
    expect(r.agentRecordedExcluded).toBe(1);
    expect(r).not.toHaveProperty('predictionId');
    // Predictions stay local: nothing a cloud handle could resolve.
    await expect(oort.judge.listPredictions()).rejects.toMatchObject({ reason: 'local-only' });
    await oort.close();
  });

  it('sdk.cloud-judge-list-pages-to-its-limit', async () => {
    const { oort, c } = await cloud();
    const at = new Date(Date.parse(NOW) - 86_400_000);
    for (let i = 0; i < 130; i++) {
      await seedFakeJudgment(c, { ...input, subject: `Post number ${i}` }, at);
    }
    expect((await oort.judge.list({ limit: 120 })).judgments).toHaveLength(120);
    expect(c.seen.filter((s) => s === 'GET /v1/judgments')).toHaveLength(2);
    expect((await oort.judge.list()).judgments).toHaveLength(100);
    await oort.close();
  });

  it('sdk.cloud-judge-end-users-record-their-own-under-the-account-experts', async () => {
    const { oort, c } = await cloud(
      (c) => {
        c.endUsers.serverKey = true;
        c.judgments.experts = ['ada'];
      },
      { org: 'acme' },
    );
    const ada = oort.scoped({ user: 'user-1' });
    const r = await ada.judge.record(input);
    expect(r.status).toBe('agent-recorded');
    expect((await ada.judge.list()).judgments.map((j) => j.id)).toEqual([r.id]);
    expect(c.endUsers.users.get('user-1')?.judgments.records).toHaveLength(1);
    expect(c.judgments.records).toHaveLength(0);
    // The experts list is the account's: an end user's handle is refused before sending.
    await expect(ada.judge.experts.get()).rejects.toMatchObject({ reason: 'user-not-supported' });
    await oort.close();
  });

  it('sdk.cloud-judge-views-fill-the-origin-an-older-cloud-leaves-out', () => {
    const base = {
      id: 'j1',
      subject: { summary: 'Post' },
      verdict: 'rejected',
      verdicts: ['approved', 'rejected'],
      reason: 'r',
      criteria: [],
      domain: 'content',
      by: 'ada',
      decidedAt: NOW,
      status: 'current',
    };
    expect(
      cloudJudgmentView({ ...base, via: 'mcp', confirmed: false, agentRecorded: true }).origin,
    ).toBe('agent');
    expect(
      cloudJudgmentView({ ...base, via: 'mcp', confirmed: true, agentRecorded: false }).origin,
    ).toBe('integration');
    expect(
      cloudJudgmentView({ ...base, via: 'cli', confirmed: true, origin: 'dashboard' }),
    ).toMatchObject({ origin: 'dashboard' });
  });
});

describe('judgments in local mode: withdraw and experts', () => {
  async function local(over: OortOptions = {}) {
    const root = tmpdir('oort-sdk-judge-local-');
    return createOortWith(
      {
        mode: 'local',
        home: path.join(root, 'home'),
        cwd: root,
        env: { HOME: root, OORT_NO_KEYCHAIN: '1' },
        ...over,
      },
      { adapters: fakeAdapters(), now: () => new Date(NOW) },
    );
  }

  it('sdk.judge-withdraw-is-a-persons', async () => {
    const oort = await local({
      judge: { role: 'expert', operator: 'grace' },
      config: { judge: { experts: ['ada'] } },
    });
    const { id } = await oort.judge.record(input);
    await expect(oort.scoped({ judgeRole: 'agent' }).judge.withdraw(id)).rejects.toMatchObject({
      reason: 'expert-only',
    });
    expect(await oort.judge.withdraw(id)).toEqual({
      id,
      withdrawn: true,
      changed: true,
      by: 'grace',
    });
    expect(await oort.judge.withdraw(id.slice(0, 8))).toEqual({
      id,
      withdrawn: true,
      changed: false,
      by: null,
    });
    const { judgments } = await oort.judge.list({ all: true });
    expect(judgments[0]).toMatchObject({ id, status: 'withdrawn', withdrawn: { by: 'grace' } });
    expect((await oort.judge.list()).judgments).toEqual([]);
    await oort.close();
  });

  it('sdk.judge-experts-come-from-the-home-config-locally', async () => {
    const oort = await local({ config: { judge: { experts: ['ada'] } } });
    expect(await oort.judge.experts.get()).toEqual({ experts: ['ada'] });
    await expect(oort.judge.experts.set(['grace'])).rejects.toMatchObject({
      code: 'refused',
      reason: 'experts-in-config',
    });
    await expect(oort.judge.experts.set(['x'.repeat(129)])).rejects.toMatchObject({
      code: 'usage',
    });
    await oort.close();
  });
});
