import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionController, Embedder, MemoryWriter, Observation } from './adapters.js';
import { resolveConfig } from './config.js';
import { localGrant, nodeGrant, planetNode } from './grant.js';
import { createMemoryStore } from './memory-store.js';
import type { Memory, Scope } from './model.js';
import { observe, type ObserveDeps } from './observe.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-observe-grant-'));
const config = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') });
const NOW = new Date('2026-01-01T00:00:00Z');

const embed: Embedder = {
  dimension: 4,
  async embed(texts) {
    return texts.map(() => Int8Array.from([10, 20, 30, 40]));
  },
};
const write: MemoryWriter = {
  async write(obs) {
    return { text: obs.userText, stub: obs.userText.slice(0, 20), entities: [], type: 'semantic' };
  },
};

function deps(seen: Memory[][]): ObserveDeps {
  const decide: DecisionController = {
    async gate() {
      return { shouldStore: 0.9, salience: 0.5, types: { semantic: 1 }, decisions: [] };
    },
    async reconcile(_o, candidates) {
      seen.push(candidates);
      return [{ candidateId: null, action: 'ADD', probability: 0.9, decisions: [] }];
    },
  };
  return {
    store: createMemoryStore({ d: config.activation.d }),
    embed,
    decide,
    write,
    config,
    now: NOW,
  };
}

const turn = (userText: string): Observation => ({
  userText,
  assistantText: 'noted',
  toolSummaries: [],
  at: NOW.toISOString(),
});

const u1: Scope = { orgId: 'acme', customerId: 'u1', agentId: 'bot' };
const u2: Scope = { orgId: 'acme', customerId: 'u2', agentId: 'bot' };
const planetOnly = (s: Scope) => {
  const principal = { orgId: s.orgId, customerId: s.customerId, agentId: s.agentId };
  return nodeGrant({ principal, read: [{ node: planetNode(principal), projectIds: [null] }] });
};

describe('observe with a grant (CON-108: end users get their Planet only)', () => {
  it('reads and writes only the grant: no Star shared between two users of one agent', async () => {
    const seen: Memory[][] = [];
    const d = deps(seen);
    // u2's agent keeps a Star: keyed by (org, agent) alone, so a local grant for u1 would read it.
    await observe(turn('u2 has a secret project called Bluebird'), u2, { ...d, home: 'star' });
    seen.length = 0;
    await observe(turn('u1 asks about the Bluebird project'), u1, { ...d, grant: planetOnly(u1) });
    expect(seen.flat().map((m) => m.text)).toEqual([]);
    // Without the grant, the same agent's Star would be a candidate: the leak the grant prevents.
    seen.length = 0;
    await observe(turn('u1 asks about the Bluebird project again'), u1, d);
    expect(seen.flat().some((m) => m.text.startsWith('u2 has'))).toBe(true);
  });

  it("lands on the user's Planet with the agent as author", async () => {
    const d = deps([]);
    const r = await observe(turn('u1 prefers dark mode'), u1, { ...d, grant: planetOnly(u1) });
    expect(r.outcome).toBe('added');
    const stored = await d.store.get(planetOnly(u1), r.memoryId!);
    expect(stored?.scope).toMatchObject({ orgId: 'acme', customerId: 'u1', agentId: 'bot' });
    expect(stored?.address).toBeUndefined();
    expect(await d.store.get(planetOnly(u2), r.memoryId!)).toBeNull();
  });

  it("refuses a grant for another principal than the scope's", async () => {
    const d = deps([]);
    await expect(observe(turn('x'), u1, { ...d, grant: planetOnly(u2) })).rejects.toThrow(
      /principal/,
    );
    await expect(
      observe(turn('x'), u1, {
        ...d,
        grant: localGrant({ ...u1, projectIds: [null] }),
      }),
    ).resolves.toBeDefined();
  });
});
