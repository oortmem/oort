/**
 * The adaptive stop (CON-17) through the shared recall: a full recall asks the engine's decision
 * model; `fast` and `lexical` recalls make no model call for it and use the rule.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createMemoryStore,
  resolveConfig,
  type DecisionController,
  type SufficiencyRequest,
} from '@oortmem/core';
import { makeMemory, seedCold, TG, vec } from '@oortmem/core/store-conformance';
import { runRecall, type RecallTarget } from './engine/recall.js';
import { wire } from './wire.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-cli-stop-'));
const base = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') }, { projectConfig: false });
const config = { ...base, recall: { ...base.recall, adaptiveStop: 'decide' as const } };

async function target(decide?: DecisionController): Promise<RecallTarget> {
  const store = createMemoryStore({ d: config.activation.d });
  const m = (id: string, text: string) =>
    makeMemory({ id, text, stub: text, embedding: vec(1, 0, 0, 0) });
  await store.upsert(TG, m('w', 'auth-service listens on port 8080 in staging'));
  await seedCold(store, m('c', 'auth-service on-call runbook'));
  return {
    mode: 'local',
    config,
    store,
    scope: { orgId: 'local', customerId: 'self', agentId: 'claude-code' },
    agent: { id: 'claude-code', home: 'planet', source: 'flag' },
    grant: TG,
    ...(decide !== undefined && { decide }),
  };
}

function decider(): DecisionController & { asked: SufficiencyRequest[] } {
  const asked: SufficiencyRequest[] = [];
  const no = () => Promise.reject(new Error('not used'));
  return {
    asked,
    gate: no,
    reconcile: no,
    async sufficient(req) {
      asked.push(req);
      return { probability: 0.1, decisions: [] };
    },
  };
}

describe('recall wiring: adaptive stop', () => {
  // After the memories are written: their validity starts when they are made.
  const now = new Date(Date.now() + 60_000);
  it('stop.full-recall-asks-the-engine-decision-model', async () => {
    const decide = decider();
    const r = await runRecall(
      await target(decide),
      'auth-service port 8080',
      { mode: 'current' },
      now,
    );
    expect(decide.asked).toHaveLength(1);
    expect(r.adaptiveStop).toEqual({ stopped: false, by: 'decide', cold: 1, probability: 0.1 });
  });

  it('stop.fast-and-lexical-recalls-use-the-rule', async () => {
    for (const speed of ['fast', 'lexical'] as const) {
      const decide = decider();
      const r = await runRecall(
        await target(decide),
        'auth-service port 8080',
        { mode: 'current' },
        now,
        undefined,
        false,
        { speed },
      );
      expect(decide.asked, speed).toEqual([]);
      expect(r.adaptiveStop, speed).toEqual({ stopped: true, by: 'rule', cold: 1 });
    }
  });
});

describe('a repository cannot change the adaptive stop or the store (CON-17)', () => {
  it('stop.project-config-is-ignored-with-a-warning', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-cli-stop-cfg-'));
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'repo');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(cwd);
    fs.writeFileSync(
      path.join(cwd, 'oort.config.json'),
      JSON.stringify({
        recall: { adaptiveStop: 'decide', sufficientAt: 0, budgetChars: 100 },
        store: { vectorIndex: 'binary' },
      }),
    );
    const env = { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1' };
    const w = await wire(cwd, { env, keychain: async () => undefined });
    try {
      expect(w.config.recall).toMatchObject({ adaptiveStop: 'rule', sufficientAt: 0.7 });
      expect(w.config.recall.budgetChars).toBe(100);
      expect(w.config.store.vectorIndex).toBe('auto');
      const codes = w.warnings.map((x) => x.code);
      expect(codes).toContain('recall-stop-ignored');
      expect(codes).toContain('store-ignored');
    } finally {
      await w.close();
    }
  });
});
