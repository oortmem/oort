import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readableNodes } from '@oortmem/core';
import { tmpdir } from '../test/helpers.js';
import { principalFor, resolveAgent, wire, wireEngine } from './wire.js';

/** Assembled at runtime so no key literal sits in a source file. */
const oortKey = (tag: string): string =>
  ['oort', 'sk', `${tag}${Date.now()}`.padEnd(43, 'A')].join('_');

function env(over: Record<string, string> = {}): Record<string, string> {
  const root = tmpdir();
  return { HOME: root, OORT_HOME: path.join(root, 'home'), OORT_NO_KEYCHAIN: '1', ...over };
}

describe('wireEngine (CON-108: a principal-free engine)', () => {
  it('cloud mode opens, creates and writes nothing under OORT_HOME', async () => {
    const e = env({ OORT_API_KEY: oortKey('env') });
    const engine = await wireEngine({ cwd: tmpdir(), env: e, mode: 'cloud' });
    expect(engine.mode).toBe('cloud');
    expect(engine.store).toBeUndefined();
    expect(engine.cloud).toBeDefined();
    expect(engine.embed).toBeUndefined();
    await engine.close();
    expect(fs.existsSync(e['OORT_HOME']!)).toBe(false);
  });

  it('the CLI wrapper still opens the store in cloud mode (the hooks keep their queue there)', async () => {
    const e = env({ OORT_API_KEY: oortKey('env') });
    fs.mkdirSync(e['OORT_HOME']!, { recursive: true });
    fs.writeFileSync(path.join(e['OORT_HOME']!, 'cloud.json'), JSON.stringify({ store: 'cloud' }));
    const w = await wire(tmpdir(), { env: e });
    expect(w.mode).toBe('cloud');
    expect(w.store).toBeDefined();
    await w.close();
    expect(fs.existsSync(path.join(e['OORT_HOME']!, 'oort.sqlite'))).toBe(true);
  });

  it('explicit keys come first; keySources drops env and keychain', async () => {
    const e = env({ OORT_API_KEY: oortKey('env') });
    const only = await wireEngine({
      cwd: tmpdir(),
      env: e,
      mode: 'cloud',
      keySources: ['explicit'],
    });
    expect(only.cloud).toBeUndefined();
    expect(only.cloudProblem).toMatch(/oort login/);
    const seen: (string | null)[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Request(input, init).headers.get('authorization'));
      return Response.json({ account: 'a1', plan: 'pro', via: 'key' });
    }) as typeof globalThis.fetch;
    const given = oortKey('given');
    const both = await wireEngine({
      cwd: tmpdir(),
      env: e,
      mode: 'cloud',
      explicitKeys: { oort: given },
      fetch,
    });
    await both.cloud!.whoami();
    expect(seen).toEqual([`Bearer ${given}`]);
  });

  it('lays a config overlay over the files, validated by the strict schema', async () => {
    const e = env();
    const engine = await wireEngine({
      cwd: tmpdir(),
      env: e,
      mode: 'cloud',
      configOverlay: { recall: { budgetChars: 1234 }, judge: { experts: ['ada'] } },
    });
    expect(engine.config.recall.budgetChars).toBe(1234);
    expect(engine.config.recall.returnK).toBe(10);
    expect(engine.config.judge.experts).toEqual(['ada']);
    await expect(
      wireEngine({ cwd: tmpdir(), env: e, mode: 'cloud', configOverlay: { recall: { nope: 1 } } }),
    ).rejects.toThrow();
  });

  it('local mode opens the store; the adapters are the test hook’s or absent', async () => {
    const e = env();
    const engine = await wireEngine({ cwd: tmpdir(), env: e, mode: 'local', keySources: [] });
    expect(engine.mode).toBe('local');
    expect(engine.store).toBeDefined();
    expect(engine.unavailable.embed?.name).toBe('MissingCredentialError');
    await engine.close();
  });
});

describe('principalFor', () => {
  it("an agent's local grant reads the Planet and its own Star", async () => {
    const engine = await wireEngine({ cwd: tmpdir(), env: env(), mode: 'cloud' });
    const agent = resolveAgent(engine.config.home, {}, 'bot');
    const p = principalFor(engine, { agent, projectId: 'cfg:x' });
    expect(p.scope).toMatchObject({
      orgId: 'local',
      customerId: 'self',
      agentId: 'bot',
      projectId: 'cfg:x',
    });
    expect(readableNodes(p.grant).map((n) => n.level)).toEqual(['user', 'agent']);
  });

  it("an end user's grant is their Planet only, with the agent as principal", async () => {
    const engine = await wireEngine({ cwd: tmpdir(), env: env(), mode: 'cloud' });
    const agent = resolveAgent(engine.config.home, {}, 'bot');
    const p = principalFor(engine, { orgId: 'acme', customerId: 'u1', agent, planetOnly: true });
    expect(readableNodes(p.grant)).toEqual([{ level: 'user', orgId: 'acme', customerId: 'u1' }]);
    expect(p.grant.writeNodes.map((w) => w.node.level)).toEqual(['user']);
    expect(p.grant.principal).toEqual({ orgId: 'acme', customerId: 'u1', agentId: 'bot' });
  });
});
