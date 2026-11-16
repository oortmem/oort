import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeCloud, seedFakeJudgment, type FakeCloud } from '../test/helpers/fake-cloud.js';
import { data, fakeIo, tmpdir } from '../test/helpers.js';
import { writeCloudSettings } from './cloud.js';
import { createKeychain } from './keychain.js';
import { cloudBackend } from './mcp.js';
import { runCli } from './program.js';
import { DASHBOARD_JUDGMENTS_URL } from './sdk/cloud.js';
import { wire as realWire, type WireFn } from './wire.js';

/**
 * Judgments from the CLI and MCP in cloud mode. The Oort key on this machine acts as an agent: it
 * lists and applies the account's judgments and records unconfirmed ones for its listed experts,
 * while a person's decisions (record from the CLI, confirm, withdraw) are the dashboard's.
 */

const oortKey = (): string => ['oort', 'sk', `judge${Date.now()}`.padEnd(43, 'J')].join('_');
const DAY = 86_400_000;

/**
 * A run against the fake Oort Cloud. `tamper` rewrites the body of each 200 answer from the
 * judgment routes, as a compromised or misbehaving server might.
 */
function setup(tamper?: (route: string, body: any) => unknown) {
  const root = tmpdir();
  const home = path.join(root, 'oort-home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const key = oortKey();
  const cloud = fakeCloud(key);
  writeCloudSettings(home, { store: 'cloud' });
  const env = { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: key };
  const fetch: typeof globalThis.fetch =
    tamper === undefined
      ? cloud.fetch
      : async (input, init) => {
          const req = new Request(input, init);
          const res = await cloud.fetch(input, init);
          const { pathname } = new URL(req.url);
          if (!pathname.startsWith('/v1/judgments') || res.status !== 200) return res;
          return Response.json(tamper(`${req.method} ${pathname}`, await res.json()));
        };
  const wire: WireFn = (dir, o = {}) =>
    realWire(dir, { ...o, keychain: async () => undefined, fetch });
  return {
    cloud,
    async run(args: string[]) {
      const io = fakeIo({ cwd, env });
      const code = await runCli(args, io, wire, createKeychain({ platform: 'none' }), { fetch });
      return { code, io };
    },
    wired: () =>
      realWire(cwd, { env, keychain: async () => undefined, fetch: cloud.fetch, agent: 'cursor' }),
  };
}

const judgment = {
  subject: 'Post says a vitamin cures the flu',
  verdict: 'rejected',
  reason: 'Health claim with no cited source.',
  domain: 'content',
  by: 'ada',
};

/** A person's judgment and an agent's unconfirmed one, recorded yesterday. */
async function seed(cloud: FakeCloud): Promise<void> {
  const at = new Date(Date.now() - DAY);
  await seedFakeJudgment(cloud, judgment, at);
  await seedFakeJudgment(
    cloud,
    { ...judgment, subject: 'Ad says a tea cures colds', via: 'mcp' },
    at,
  );
}

describe('judgments from the CLI in cloud mode', () => {
  it('cli.cloud-judge-list-and-apply-work-as-an-agent', async () => {
    const e = setup();
    await seed(e.cloud);
    const list = await e.run(['judge', 'list', '--json']);
    expect(list.code, list.io.stderr).toBe(0);
    const out = data<{
      judgments: { subject: { summary: string }; origin: string; current: boolean }[];
    }>(list.io.stdout, 'judge list');
    expect(out.judgments.map((j) => [j.subject.summary, j.origin, j.current])).toEqual(
      expect.arrayContaining([
        [judgment.subject, 'integration', true],
        ['Ad says a tea cures colds', 'agent', true],
      ]),
    );
    const human = await e.run(['judge', 'list']);
    expect(human.io.stdout).toContain('[agent-recorded, unconfirmed]');

    const apply = await e.run(['judge', 'apply', 'Post says a vitamin cures colds', '--json']);
    expect(apply.code, apply.io.stderr).toBe(0);
    const r = data<{
      precedents: { subject: { summary: string } }[];
      agentRecordedExcluded: number;
      predictionId?: string;
    }>(apply.io.stdout, 'judge apply');
    expect(r.precedents.map((p) => p.subject.summary)).toEqual([judgment.subject]);
    expect(r.agentRecordedExcluded).toBe(1);
    expect(r.predictionId).toBeUndefined();
    const shown = await e.run(['judge', 'apply', 'Post says a vitamin cures colds']);
    expect(shown.io.stdout + shown.io.stderr).toContain(DASHBOARD_JUDGMENTS_URL);
    expect(e.cloud.seen).toContain('POST /v1/judgments/apply');
  });

  it('cli.cloud-judge-person-decisions-point-to-the-dashboard', async () => {
    const e = setup();
    const record = await e.run([
      'judge',
      'record',
      ...Object.entries(judgment).flatMap(([k, v]) => [`--${k}`, v]),
      '--yes',
    ]);
    const confirm = await e.run(['judge', 'confirm', 'abcd1234', '--yes']);
    const withdraw = await e.run(['judge', 'withdraw', 'abcd1234', '--yes']);
    for (const r of [record, confirm, withdraw]) {
      expect(r.code).toBe(2);
      expect(r.io.stderr).toContain(DASHBOARD_JUDGMENTS_URL);
      expect(r.io.stderr).toContain('acts as an agent');
    }
    const json = await e.run(['judge', 'withdraw', 'abcd1234', '--yes', '--json']);
    expect(JSON.parse(json.io.stdout)).toMatchObject({
      ok: false,
      error: { code: 'refused', reason: 'expert-only' },
    });
    expect(e.cloud.seen.filter((s) => s.includes('/v1/judgments'))).toEqual([]);
    expect(e.cloud.judgments.records).toEqual([]);
  });
});

describe('judgment text from Oort Cloud in human output', () => {
  const ESC = '\u001b';
  const raw = (r: { io: { stdout: string; stderr: string } }) => r.io.stdout + r.io.stderr;

  it('cli.cloud-judge-list-prints-no-control-characters-from-the-cloud', async () => {
    const e = setup((route, b) => {
      if (route === 'GET /v1/judgments') {
        for (const x of b.judgments) x.decidedAt = `${ESC}]0;pwn\u0007xx`;
      }
      return b;
    });
    await seed(e.cloud);
    const r = await e.run(['judge', 'list']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain(judgment.subject);
    expect(raw(r)).not.toContain(ESC);
    expect(raw(r)).not.toContain('\u0007');

    const id = setup((route, b) => {
      if (route === 'GET /v1/judgments') for (const x of b.judgments) x.id = `${ESC}[8m${x.id}`;
      return b;
    });
    await seed(id.cloud);
    const refused = await id.run(['judge', 'list']);
    expect(refused.code).not.toBe(0);
    expect(raw(refused)).not.toContain(ESC);
  });

  it('cli.cloud-judge-apply-prints-no-control-characters-from-the-cloud', async () => {
    const tampered = (change: (b: any) => void) =>
      setup((route, b) => {
        if (route === 'POST /v1/judgments/apply') change(b);
        return b;
      });
    const cases = [
      tampered((b) => {
        b.status = `${ESC}[2J${ESC}[Hsuggested`;
      }),
      tampered((b) => {
        for (const p of b.precedents) p.id = `${ESC}[8m`;
      }),
      tampered((b) => {
        for (const p of b.precedents) p.decidedAt = `${ESC}[31mRED${ESC}[0m`;
      }),
      tampered((b) => {
        b.why = `${ESC}[8m`;
      }),
    ];
    for (const e of cases) {
      await seedFakeJudgment(e.cloud, judgment, new Date(Date.now() - DAY));
      await seedFakeJudgment(
        e.cloud,
        { ...judgment, subject: 'Post says a vitamin cures colds' },
        new Date(Date.now() - DAY),
      );
      const r = await e.run(['judge', 'apply', 'Post says a vitamin cures colds']);
      expect(raw(r)).not.toContain(ESC);
    }
  });
});

describe('judgments from MCP in cloud mode', () => {
  it('mcp.cloud-records-unconfirmed-and-applies-as-an-agent', async () => {
    const e = setup();
    e.cloud.judgments.experts = ['ada'];
    const w = await e.wired();
    const backend = cloudBackend({ wired: w, client: w.cloud! });
    const r = await backend.recordJudgment!({ ...judgment, criteria: ['no-source'] });
    expect(r).toMatchObject({ outcome: 'added', status: 'agent-recorded, unconfirmed' });
    expect(r.note).toContain(DASHBOARD_JUDGMENTS_URL);
    expect(e.cloud.judgments.records).toEqual([{ ...judgment, criteria: ['no-source'] }]);

    // Unconfirmed, so applying leaves it out and says so.
    const j = await backend.judge!({
      item: 'Post says a vitamin cures colds',
      limit: 5,
      include_imported: false,
      include_agent_recorded: false,
    });
    expect(j).toMatchObject({ precedents: [], unconfirmed_agent_recorded_not_used: 1 });

    // A name the account does not list is the cloud's refusal, passed on.
    await expect(backend.recordJudgment!({ ...judgment, by: 'grace' })).rejects.toThrow();
    // Fields are checked here first: nothing is sent for a bad record.
    const before = e.cloud.seen.length;
    await expect(
      backend.recordJudgment!({ ...judgment, subject: 's'.repeat(501) }),
    ).rejects.toThrow();
    expect(e.cloud.seen).toHaveLength(before);
    await w.close();
  });
});
