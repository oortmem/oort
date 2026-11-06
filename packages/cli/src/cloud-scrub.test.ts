import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localGrant, localScope, setAgentStar } from '@oortmem/core';
import { createKeychain } from './keychain.js';
import { cloudBackend } from './mcp.js';
import { cloudRemote } from './cloud-remote.js';
import { runCli } from './program.js';
import { createOortWith } from './sdk/create.js';
import { wire as realWire, type WireFn } from './wire.js';
import { writeCloudSettings } from './cloud.js';
import { AWS_KEY, data, fakeIo, memory, tmpdir } from '../test/helpers.js';
import { fakeCloud, type FakeCloud } from '../test/helpers/fake-cloud.js';

/**
 * Every write to Oort Cloud is scrubbed on this machine before it is sent (CON-107 review): a
 * secret never leaves it, and a turn that is mostly secret is skipped without any request. One
 * case per cloud write path: `oort remember`, `oort observe`, the SDK's `observe()` and
 * `remember()`, the MCP server's cloud `remember`, the hooks' drain, `oort share --text` (in
 * share.test.ts) and `oort cloud import`.
 */

const REDACTED = /\[REDACTED:aws-access-key\]/;
const WITH_KEY = `The deploy bot signs in with ${AWS_KEY} on staging.`;

function setup(mode: 'local' | 'cloud' = 'cloud') {
  const root = tmpdir('oort-cloud-scrub-');
  const home = path.join(root, 'oort-home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const key = ['oort', 'sk', 'scrub'.padEnd(43, 'S')].join('_');
  const cloud: FakeCloud = fakeCloud(key);
  if (mode === 'cloud') writeCloudSettings(home, { store: 'cloud' });
  const env = { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: key };
  const wire: WireFn = (dir, o = {}) =>
    realWire(dir, { ...o, keychain: async () => undefined, fetch: cloud.fetch });
  const run = async (args: string[], stdin?: string) => {
    const io = fakeIo({ cwd, env, ...(stdin !== undefined && { stdin }) });
    const code = await runCli(args, io, wire, createKeychain({ platform: 'none' }), {
      fetch: cloud.fetch,
    });
    return { code, io };
  };
  return { root, home, cwd, key, cloud, env, run };
}

/** Everything the fake cloud was sent to save, as one string. */
const sent = (c: FakeCloud): string =>
  JSON.stringify([c.observed, [...c.memories.values()].map((m) => m.text)]);

function expectScrubbed(c: FakeCloud): void {
  expect(c.observed.length).toBeGreaterThan(0);
  expect(sent(c)).not.toContain(AWS_KEY);
  expect(sent(c)).toMatch(REDACTED);
}

describe('cloud writes are scrubbed before they leave the machine', () => {
  it('oort remember: the key is redacted in the request; a mostly-secret fact is never sent', async () => {
    const e = setup();
    const r = await e.run(['remember', WITH_KEY, '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    expectScrubbed(e.cloud);
    const before = e.cloud.observed.length;
    const secret = await e.run(['remember', AWS_KEY, '--json']);
    expect(secret.code, secret.io.stderr).toBe(0);
    expect(e.cloud.observed).toHaveLength(before);
    expect(data(secret.io.stdout, 'remember').results).toEqual([
      { fact: 0, outcome: 'skipped', reason: 'secret' },
    ]);
  });

  it('oort observe: the turn is redacted; a mostly-secret turn is skipped without a request', async () => {
    const e = setup();
    const r = await e.run(['observe', '--user', WITH_KEY, '--assistant', 'Noted.', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    expectScrubbed(e.cloud);
    const tools = await e.run(
      ['observe', '--json'],
      JSON.stringify({ userText: 'deploy', assistantText: 'ok', toolSummaries: [WITH_KEY] }),
    );
    expect(tools.code, tools.io.stderr).toBe(0);
    expect(sent(e.cloud)).not.toContain(AWS_KEY);
    const before = e.cloud.observed.length;
    const secret = await e.run(['observe', '--user', AWS_KEY, '--assistant', AWS_KEY, '--json']);
    expect(secret.code, secret.io.stderr).toBe(0);
    expect(e.cloud.observed).toHaveLength(before);
    expect(data(secret.io.stdout, 'observe')).toMatchObject({
      outcome: 'skipped',
      reason: 'secret',
    });
  });

  it("the SDK's cloud observe() and remember()", async () => {
    const e = setup('local');
    const oort = await createOortWith(
      { mode: 'cloud', cwd: e.cwd, env: e.env, fetch: e.cloud.fetch, keySources: ['env'] },
      {},
    );
    await oort.observe({ user: WITH_KEY, assistant: 'Noted.', tools: [WITH_KEY] });
    await oort.remember(WITH_KEY);
    expectScrubbed(e.cloud);
    expect(e.cloud.observed).toHaveLength(2);
    const o = await oort.observe({ user: AWS_KEY, assistant: AWS_KEY });
    expect(o).toMatchObject({
      outcome: 'skipped',
      memories: [{ outcome: 'skipped', reason: 'secret' }],
    });
    const m = await oort.remember(AWS_KEY);
    expect(m.results).toEqual([{ fact: 0, outcome: 'skipped', reason: 'secret' }]);
    expect(e.cloud.observed).toHaveLength(2);
    await oort.close();
  });

  it("the MCP server's cloud remember", async () => {
    const e = setup();
    const w = await realWire(e.cwd, {
      env: e.env,
      keychain: async () => undefined,
      fetch: e.cloud.fetch,
    });
    const backend = cloudBackend({ wired: w, client: w.cloud! });
    await backend.remember({ facts: [WITH_KEY], visibility: 'private' });
    expectScrubbed(e.cloud);
    const r = await backend.remember({ facts: [AWS_KEY], visibility: 'private' });
    expect(r.results).toEqual([{ fact: 0, outcome: 'skipped', reason: 'secret' }]);
    expect(e.cloud.observed).toHaveLength(1);
    await w.close();
  });

  it("the hooks' drain", async () => {
    const e = setup();
    const w = await realWire(e.cwd, {
      env: e.env,
      keychain: async () => undefined,
      fetch: e.cloud.fetch,
    });
    const remote = cloudRemote(w.cloud, undefined, { projectId: undefined });
    const turn = { assistantText: 'Noted.', toolSummaries: [], at: '2026-11-06T00:00:00Z' };
    await remote.observe({ ...turn, userText: WITH_KEY } as never, undefined, 's1:1');
    expectScrubbed(e.cloud);
    await remote.observe(
      { ...turn, userText: AWS_KEY, assistantText: AWS_KEY } as never,
      undefined,
      's1:2',
    );
    expect(e.cloud.observed).toHaveLength(1);
    await w.close();
  });

  it('oort cloud import: every uploaded line is scrubbed again', async () => {
    const e = setup('local');
    const w = await realWire(e.cwd, { env: e.env, keychain: async () => undefined });
    // Written past the write path, as an older store might hold it.
    await w.store.upsert(
      localGrant({ ...localScope(undefined), projectIds: [null] }),
      memory({ text: WITH_KEY, stub: WITH_KEY, embedding: undefined }),
    );
    await w.close();
    const r = await e.run(['cloud', 'import', '--yes', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    const texts = JSON.stringify([...e.cloud.memories.values()].map((m) => [m.text, m['stub']]));
    expect(e.cloud.memories.size).toBe(1);
    expect(texts).not.toContain(AWS_KEY);
    expect(texts).toMatch(REDACTED);
  });
});

describe('cloud remember: Star refusal, project payload, idempotent retries', () => {
  it('a Star agent is refused before anything is sent', async () => {
    const e = setup();
    setAgentStar(e.home, 'cursor', true);
    const r = await e.run(['--agent', 'cursor', 'remember', 'CI runs on arm.', '--json']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toMatch(/own Star/);
    expect(e.cloud.observed).toEqual([]);
  });

  it("sends this repository's project and its privacy statement", async () => {
    const e = setup();
    fs.writeFileSync(
      path.join(e.cwd, 'oort.config.json'),
      JSON.stringify({ project: { private: true } }),
    );
    fs.mkdirSync(path.join(e.cwd, '.git'));
    const r = await e.run(['remember', 'CI runs on arm.', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(e.cloud.observed[0]).toMatchObject({
      project: expect.any(String),
      projectPrivate: true,
    });
  });

  it('a retry after a lost response is a duplicate, not a second memory (CLI, SDK, MCP)', async () => {
    const e = setup();
    const ref = /^remember:[0-9a-f]{64}:\d{4}-\d{2}-\d{2}$/;
    e.cloud.dropAfterObserve = true;
    const lost = await e.run(['remember', 'CI runs on arm.', '--json']);
    expect(lost.code).not.toBe(0);
    const again = await e.run(['remember', 'CI runs on arm.', '--json']);
    expect(again.code, again.io.stderr).toBe(0);
    expect(e.cloud.memories.size).toBe(1);
    expect(e.cloud.observed[0]!['turnRef']).toMatch(ref);
    expect(e.cloud.observed[1]!['turnRef']).toBe(e.cloud.observed[0]!['turnRef']);
    // The SDK and the MCP server send the same turnRef for the same fact.
    const w = await realWire(e.cwd, {
      env: e.env,
      keychain: async () => undefined,
      fetch: e.cloud.fetch,
    });
    await cloudBackend({ wired: w, client: w.cloud! }).remember({
      facts: ['CI runs on arm.'],
      visibility: 'private',
    });
    await w.close();
    const oort = await createOortWith(
      { mode: 'cloud', cwd: e.cwd, env: e.env, fetch: e.cloud.fetch, keySources: ['env'] },
      {},
    );
    await oort.remember('CI runs on arm.');
    await oort.close();
    expect(new Set(e.cloud.observed.map((b) => b['turnRef'])).size).toBe(1);
    expect(e.cloud.memories.size).toBe(1);
  });

  it("prints Oort Cloud's outcome and id only when they are what Oort reports", async () => {
    const e = setup();
    const ESC = '\u001b';
    const base = e.cloud.fetch;
    e.cloud.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith('/v1/observe')) return base(input, init);
      return Response.json({
        outcome: `${ESC}]0;pwned${ESC}\\added`,
        memories: [{ id: `${ESC}[31mnot-a-uuid`, action: 'added' }],
        counts: {},
      });
    };
    const r = await e.run(['remember', 'CI runs on arm.']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).not.toContain(ESC);
    expect(r.io.stdout).toMatch(/^oort remember · unknown · /);
    const j = await e.run(['remember', 'CI runs on arm.', '--json']);
    expect(data(j.io.stdout, 'remember').results).toEqual([{ fact: 0, outcome: 'unknown' }]);
  });
});

describe('oort cloud import lines', () => {
  it('cloud-scrub.export-line-scrubs-text-stub-and-entities-and-keeps-the-rest', async () => {
    const { scrubExportLine } = await import('./cloud-scrub.js');
    const line = JSON.stringify({
      id: 'm1',
      text: `deploy key ${AWS_KEY}`,
      stub: `key ${AWS_KEY}`,
      entities: ['billing-service', AWS_KEY],
      tier: 'warm',
    });
    const out = JSON.parse(scrubExportLine(line)) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(AWS_KEY);
    expect(out['text']).toMatch(/\[REDACTED:/);
    expect(out['stub']).toMatch(/\[REDACTED:/);
    expect((out['entities'] as string[])[0]).toBe('billing-service');
    expect((out['entities'] as string[])[1]).toMatch(/\[REDACTED:/);
    expect(out['id']).toBe('m1');
    expect(out['tier']).toBe('warm');
    const clean = JSON.stringify({ id: 'm2', text: 'no secrets here', entities: ['a'] });
    expect(scrubExportLine(clean)).toBe(clean);
    expect(scrubExportLine('not json')).toBe('not json');
  });
});
