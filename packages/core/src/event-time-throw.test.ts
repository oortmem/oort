/**
 * The event-time reader is code over free text: if it ever throws, a write still lands (with no
 * event time) and a recall still answers (with no time range).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionController, MemoryWriter, ScopeFilter } from './adapters.js';
import { resolveConfig } from './config.js';
import { createMemoryStore } from './memory-store.js';
import { observe } from './observe.js';
import { recall } from './recall.js';
import { localScope } from './scope.js';
import { makeMemory, TG, vec } from './store-conformance.js';

vi.mock('./event-time.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./event-time.js')>();
  const boom = (): never => {
    throw new Error('reader failed');
  };
  return { ...real, occurrencesOf: boom, queryRange: boom };
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-event-time-throw-'));
const config = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') });
const SCOPE: ScopeFilter = {
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
};

describe('a failing event-time reader', () => {
  it('throw.observe-still-writes-the-memory-without-event-time', async () => {
    const store = createMemoryStore({ d: config.activation.d });
    const decide: DecisionController = {
      async gate() {
        return { shouldStore: 0.9, salience: 0.5, types: { semantic: 0.9 }, decisions: [] };
      },
      async reconcile() {
        return [{ candidateId: null, action: 'ADD', probability: 0.9, decisions: [] }];
      },
    };
    const write: MemoryWriter = {
      async write(obs) {
        return { text: obs.userText, stub: 'hike', entities: [], type: 'semantic' };
      },
    };
    const res = await observe(
      {
        userText: 'I went hiking last weekend',
        assistantText: 'noted',
        toolSummaries: [],
        sessionId: 's',
        turnRef: 't',
        at: '2023-05-22T10:00:00.000Z',
      },
      localScope(),
      {
        store,
        decide,
        write,
        config,
        embed: { dimension: 4, embed: async (texts) => texts.map(() => vec(100, 0, 0, 0)) },
        now: new Date('2023-05-22T10:00:00.000Z'),
      },
    );
    expect(res.outcome).toBe('added');
    const m = await store.get(TG, res.memoryId ?? '');
    expect(m?.text).toBe('I went hiking last weekend');
    expect(m?.occurred).toBeUndefined();
  });

  it('throw.recall-still-answers-in-the-current-view', async () => {
    const store = createMemoryStore({ d: config.activation.d });
    await store.upsert(
      TG,
      makeMemory({
        id: 'hike',
        text: 'In March I went hiking at Mount Tam.',
        stub: 'hiking at Mount Tam',
      }),
    );
    const r = await recall(
      { text: 'where did I go hiking at Mount Tam in March?', scope: SCOPE },
      { store, config },
    );
    expect(r.temporal).toEqual({ mode: 'current', inferred: true });
    expect(r.memories.map((m) => m.id)).toEqual(['hike']);
  });
});
