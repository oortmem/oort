import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { addressed, localGrant, setAgentStar, type Memory } from '@oortmem/core';
import { nodesGrant } from '@oortmem/core/store-conformance';
import { describe, expect, it } from 'vitest';
import { harness, memory, type Harness, data } from '../test/helpers.js';
import { createOortServer } from './mcp.js';
import { wire as realWire } from './wire.js';

/**
 * CON-62 from the command line: every host acts as its own agent, shares the person's Planet, and
 * keeps a Star no other agent reads; `oort connect <host> --star` keeps a host's new memories there.
 */
const planet = { level: 'user', orgId: 'local', customerId: 'self' } as const;
const star = (agentId: string) => ({ level: 'agent', orgId: 'local', agentId }) as const;

async function household(h: Harness): Promise<Record<string, Memory>> {
  const g = nodesGrant(planet, star('cursor'), star('claude-code'));
  const ms = {
    planet: memory({ text: 'The auth service listens on port 5582.' }),
    cursorStar: memory({
      ...addressed(star('cursor'), { agentId: 'cursor' }),
      text: 'The auth service port notes live in cursor scratch.',
    }),
    ccStar: memory({
      ...addressed(star('claude-code'), { agentId: 'claude-code' }),
      text: 'The auth service port is double-checked by claude code.',
    }),
  };
  await h.store.upsertMany(g, Object.values(ms));
  return ms;
}

const ids = (stdout: string): string[] =>
  (data(stdout) as { memories: { id: string }[] }).memories.map((m) => m.id);

describe('agents: one Planet, a Star each', () => {
  it('agents.recall-reads-the-planet-and-only-its-own-star', async () => {
    const h = harness();
    const ms = await household(h);
    const asCursor = await h.run(['--agent', 'cursor', 'recall', 'auth service port', '--json']);
    expect(asCursor.code).toBe(0);
    expect(ids(asCursor.io.stdout).sort()).toEqual([ms.planet!.id, ms.cursorStar!.id].sort());
    const asClaude = await h.run([
      '--agent',
      'claude-code',
      'recall',
      'auth service port',
      '--json',
    ]);
    expect(ids(asClaude.io.stdout).sort()).toEqual([ms.planet!.id, ms.ccStar!.id].sort());
    expect(asClaude.io.stdout).not.toContain(ms.cursorStar!.id);
    // The same through OORT_AGENT.
    const env = { HOME: h.root, OORT_HOME: h.home, OORT_AGENT: 'codex' };
    const asCodex = await h.run(['recall', 'auth service port', '--json'], { env });
    expect(ids(asCodex.io.stdout)).toEqual([ms.planet!.id]);
  });

  it('agents.labels-and-explain-name-the-level', async () => {
    const h = harness();
    await household(h);
    const r = await h.run(['--agent', 'cursor', 'recall', 'auth service port']);
    expect(r.io.stdout).toContain('as cursor');
    expect(r.io.stdout).toContain('[semantic, your Planet, ');
    expect(r.io.stdout).toContain('[semantic, Star cursor, ');
    const e = await h.run(['--agent', 'cursor', 'explain', 'auth service port']);
    expect(e.io.stdout).toContain('reads: your Planet, Star cursor');
    expect(e.io.stdout).toContain("this agent's Star");
    expect(e.io.stdout).toContain('your Planet');
    const j = await h.run(['--agent', 'cursor', 'explain', 'auth service port', '--json']);
    const out = data(j.io.stdout) as {
      agent: { id: string; home: string };
      read: string[];
      memories: { origin: { from: string; author: string } }[];
    };
    expect(out.agent).toEqual({ id: 'cursor', home: 'planet' });
    expect(out.read).toEqual(['your Planet', 'Star cursor']);
    expect(out.memories.map((m) => m.origin.from).sort()).toEqual([
      'from this agent’s Star'.replace('’', "'"),
      'from your Planet',
    ]);
  });

  it('agents.include-narrows-and-a-missing-level-is-scope-denied', async () => {
    const h = harness();
    const ms = await household(h);
    const onlyPlanet = await h.run([
      '--agent',
      'cursor',
      'recall',
      'auth service port',
      '--include',
      'planet',
      '--json',
    ]);
    expect(ids(onlyPlanet.io.stdout)).toEqual([ms.planet!.id]);
    const denied = await h.run(['recall', 'auth service port', '--include', 'constellation']);
    expect(denied.code).toBe(2);
    expect(denied.io.stderr).toContain('scope_denied');
    const unknown = await h.run(['recall', 'auth service port', '--include', 'moon']);
    expect(unknown.code).toBe(2);
    expect(unknown.io.stderr).toContain('unknown level');
    const bad = await h.run(['--agent', '../x', 'recall', 'auth service port']);
    expect(bad.code).toBe(2);
    expect(bad.io.stderr).toContain('not an agent id');
  });

  it('agents.a-star-agent-keeps-new-memories-in-its-star', async () => {
    // `oort connect cursor --star` records this (the bin test runs it end to end).
    const h = harness();
    setAgentStar(h.home, 'cursor', true);
    const env = { HOME: h.root, OORT_HOME: h.home };
    const wired = await h.wire(h.cwd, { env, agent: 'cursor' });
    expect(wired.agent).toEqual({ id: 'cursor', home: 'star', source: 'flag' });
    const saved = await h.run(
      ['--agent', 'cursor', 'observe', '--user', 'remember this', '--assistant', 'ci runs on arm'],
      { env },
    );
    expect(saved.code).toBe(0);
    const id = (JSON.parse(saved.io.stdout) as { memoryId: string }).memoryId;
    const asCursor = localGrant({ ...wired.scope, projectIds: [null] });
    expect((await h.store.get(asCursor, id))?.address).toEqual(star('cursor'));
    // Claude Code never sees it.
    const cc = localGrant({
      orgId: 'local',
      customerId: 'self',
      agentId: 'claude-code',
      projectIds: [null],
    });
    expect(await h.store.get(cc, id)).toBeNull();
  });

  it('agents.mcp-server-acts-as-its-host', async () => {
    const h = harness();
    const ms = await household(h);
    const w = await h.wire(h.cwd, { env: { HOME: h.root, OORT_HOME: h.home }, agent: 'cursor' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createOortServer({ wired: w }), { transport: serverSide });
    const client = new Client({ name: 'agents', version: '0.0.0' });
    await client.connect(clientSide);
    try {
      const text = async (name: string, args: Record<string, unknown>) =>
        JSON.parse(
          ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!
            .text,
        ) as Record<string, unknown>;
      const who = await text('whoami', {});
      expect(who).toMatchObject({
        agent: 'cursor',
        reads: ['your Planet', 'Star cursor'],
        writes_to: 'your Planet',
      });
      const r = (await text('recall', { query: 'auth service port' })) as {
        memories: { id: string; from: string }[];
      };
      expect(r.memories.map((m) => m.id)).not.toContain(ms.ccStar!.id);
      expect(Object.fromEntries(r.memories.map((m) => [m.id, m.from]))).toEqual({
        [ms.planet!.id]: 'from your Planet',
        [ms.cursorStar!.id]: "from this agent's Star",
      });
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it('agents.doctor-names-the-agent-and-its-star', async () => {
    const h = harness();
    h.wire = (cwd, o) => realWire(cwd, { keychain: async () => undefined, ...o });
    fs.mkdirSync(h.home, { recursive: true, mode: 0o700 });
    fs.chmodSync(h.home, 0o700);
    const env = { HOME: h.root, OORT_HOME: h.home, OORT_NO_KEYCHAIN: '1' };
    setAgentStar(h.home, 'cursor', true);
    const w = await h.wire(h.cwd, { env, agent: 'cursor' });
    await w.store.upsertMany(nodesGrant(planet, star('cursor')), [
      memory({ embedding: undefined }),
      memory({ ...addressed(star('cursor'), { agentId: 'cursor' }), embedding: undefined }),
    ]);
    await w.close();
    const d = await h.run(['--agent', 'cursor', 'doctor', '--json'], { env });
    const checks = (data(d.io.stdout) as { checks: { name: string; detail: string }[] }).checks;
    const detail = (n: string) => checks.find((c) => c.name === n)?.detail;
    expect(detail('spaces')).toBe('Planet: 1 memory (every project); Star cursor: 1 memory');
    expect(detail('agent')).toContain('acting as cursor (from --agent)');
    expect(detail('agent')).toContain('new memories go to Star cursor');
    expect(detail('agent')).toContain('agents keeping a Star: cursor');
    const cc = await h.run(['--agent', 'claude-code', 'doctor', '--json'], { env });
    expect(cc.io.stdout).toContain('Star claude-code: 0 memories');
    // No agent named: the Planet only, and doctor says so.
    const none = await h.run(['doctor', '--json'], { env });
    const noneChecks = (data(none.io.stdout) as { checks: { name: string; detail: string }[] })
      .checks;
    expect(noneChecks.find((c) => c.name === 'spaces')?.detail).toBe(
      'Planet: 1 memory (every project)',
    );
    expect(noneChecks.find((c) => c.name === 'agent')?.detail).toContain(
      'no agent named: reads and writes your Planet only, no Star',
    );
  });
});

describe('agents: review follow-ups', () => {
  it('agents.no-agent-named-is-anonymous-planet-only', async () => {
    // An MCP entry from before agents (no --agent) must not act as claude-code.
    const h = harness();
    const ms = await household(h);
    const w = await h.wire(h.cwd, { env: { HOME: h.root, OORT_HOME: h.home } });
    expect(w.agent).toEqual({ id: 'anonymous', home: 'planet', source: 'none' });
    const r = await h.run(['recall', 'auth service port', '--json']);
    expect(ids(r.io.stdout)).toEqual([ms.planet!.id]);
    const star = await h.run(['recall', 'auth service port', '--include', 'star']);
    expect(star.code).toBe(2);
    expect(star.io.stderr).toContain('scope_denied');
    const reserved = await h.run(['--agent', 'anonymous', 'recall', 'x']);
    expect(reserved.code).toBe(2);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createOortServer({ wired: w }), { transport: serverSide });
    const client = new Client({ name: 'anon', version: '0.0.0' });
    await client.connect(clientSide);
    try {
      const who = JSON.parse(
        (
          (await client.callTool({ name: 'whoami', arguments: {} })).content as { text: string }[]
        )[0]!.text,
      ) as Record<string, unknown>;
      expect(who).toMatchObject({ agent: null, reads: ['your Planet'], writes_to: 'your Planet' });
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it('agents.doctor-flags-an-mcp-entry-without-an-agent', async () => {
    const h = harness();
    const file = path.join(h.root, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bin = path.join(h.root, 'lib', 'node_modules', 'oortmem', 'dist', 'main.js');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          oort: { type: 'stdio', command: bin, args: ['mcp', '--project', '${workspaceFolder}'] },
        },
      }),
    );
    const d = await h.run(['doctor', '--json'], {}, undefined, {
      fetch: (async () => Response.json({ ok: true })) as typeof fetch,
    });
    const check = (data(d.io.stdout) as { checks: Record<string, string>[] }).checks.find(
      (c) => c['group'] === 'mcp' && c['name'] === 'cursor',
    );
    expect(check).toMatchObject({ status: 'warn', fix: 'oort connect cursor' });
    expect(check?.['detail']).toContain('names no agent');
    expect(check?.['detail']).toContain('anonymous agent that reads and writes your Planet only');
  });

  it('agents.a-star-agent-cannot-forget-or-pin-planet-memories', async () => {
    const h = harness();
    const ms = await household(h);
    setAgentStar(h.home, 'cursor', true);
    const env = { HOME: h.root, OORT_HOME: h.home };
    for (const args of [
      ['forget', ms.planet!.id, '--yes'],
      ['pin', ms.planet!.id],
    ]) {
      const r = await h.run(['--agent', 'cursor', ...args], { env });
      expect(r.code, args[0]).toBe(2);
      expect(r.io.stderr).toContain('reads your Planet but cannot change it');
    }
    const planetGrant = nodesGrant(planet);
    const kept = await h.store.get(planetGrant, ms.planet!.id);
    expect(kept?.pinned).toBe(false);
    // Its own Star it can change; a Planet agent can change the Planet.
    expect((await h.run(['--agent', 'cursor', 'pin', ms.cursorStar!.id], { env })).code).toBe(0);
    expect((await h.run(['--agent', 'codex', 'pin', ms.planet!.id], { env })).code).toBe(0);
    // Through MCP too.
    const w = await h.wire(h.cwd, { env, agent: 'cursor' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createOortServer({ wired: w }), { transport: serverSide });
    const client = new Client({ name: 'star', version: '0.0.0' });
    await client.connect(clientSide);
    try {
      const r = await client.callTool({ name: 'forget', arguments: { id: ms.planet!.id } });
      expect(r.isError).toBe(true);
      expect(await h.store.get(planetGrant, ms.planet!.id)).not.toBeNull();
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it('agents.a-contradiction-never-names-another-agents-star', async () => {
    const h = harness();
    const ms = await household(h);
    // Claude Code (Planet home) contradicted its own Star memory: the record names that id.
    const link = {
      stage: 'level',
      question: 'contradicts',
      answer: ms.ccStar!.id,
      probability: 0.9,
    };
    const noted = memory({
      text: 'The auth service port moved.',
      source: { harness: 'test', decisions: [link] },
    });
    await h.store.upsert(nodesGrant(planet), noted);
    const asCodex = await h.run(['--agent', 'codex', 'inspect', noted.id, '--json']);
    expect(asCodex.io.stdout).not.toContain(ms.ccStar!.id);
    const human = await h.run(['--agent', 'codex', 'inspect', noted.id]);
    expect(human.io.stdout).not.toContain(ms.ccStar!.id);
    const recallJson = await h.run(['--agent', 'codex', 'recall', 'auth service port', '--json']);
    expect(recallJson.io.stdout).not.toContain(ms.ccStar!.id);
    const asClaude = await h.run(['--agent', 'claude-code', 'inspect', noted.id, '--json']);
    expect(asClaude.io.stdout).toContain(ms.ccStar!.id);
    const w = await h.wire(h.cwd, { env: { HOME: h.root, OORT_HOME: h.home }, agent: 'codex' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createOortServer({ wired: w }), { transport: serverSide });
    const client = new Client({ name: 'codex', version: '0.0.0' });
    await client.connect(clientSide);
    try {
      const r = await client.callTool({ name: 'explain', arguments: { id: noted.id } });
      expect(JSON.stringify(r)).not.toContain(ms.ccStar!.id);
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it('agents.export-backs-up-the-planet-and-every-star', async () => {
    const h = harness();
    const ms = await household(h);
    const v2 = await h.run(['export']);
    expect(v2.code, v2.io.stderr).toBe(0);
    const lines = v2.io.stdout
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => JSON.parse(l) as { id: string; address: { level: string; agentId?: string } });
    const levels = Object.fromEntries(lines.map((l) => [l.id, l.address]));
    expect(levels[ms.planet!.id]?.level).toBe('user');
    expect(levels[ms.cursorStar!.id]).toMatchObject({ level: 'agent', agentId: 'cursor' });
    expect(levels[ms.ccStar!.id]).toMatchObject({ level: 'agent', agentId: 'claude-code' });
    // Format 1 holds Planet memories only: the Stars are left out.
    const v1 = await h.run(['export', '--format', '1']);
    expect(v1.code, v1.io.stderr).toBe(0);
    expect(v1.io.stdout).toContain(ms.planet!.id);
    expect(v1.io.stdout).not.toContain(ms.cursorStar!.id);
    expect(v1.io.stdout).not.toContain(ms.ccStar!.id);
  });
});
