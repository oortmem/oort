/**
 * Defence in depth: if the event-time reader ever returns a value a store would refuse, the
 * write path stores the memory without event time instead of failing the write.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { DecisionController, MemoryWriter } from './adapters.js';
import { resolveConfig } from './config.js';
import { createMemoryStore } from './memory-store.js';
import { observe, occurredFor } from './observe.js';
import { localScope } from './scope.js';
import { makeMemory, TG, vec } from './store-conformance.js';

const BAD = [
  {
    from: '-005012-06-12T00:00:00.000Z',
    to: '-005012-06-13T00:00:00.000Z',
    precision: 'day',
    source: 'explicit',
  },
];
vi.mock('./event-time.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./event-time.js')>();
  return { ...real, occurrencesOf: () => BAD };
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-event-time-invalid-'));
const config = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') });

it('invalid.occurred-for-gives-nothing-for-a-value-a-store-refuses', () => {
  expect(occurredFor('June 12, 5012 BC', new Date('2023-05-21T05:21:00.000Z'))).toBeUndefined();
});

it('invalid.observe-still-writes-the-memory', async () => {
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
      return { text: obs.userText, stub: 'creation', entities: [], type: 'semantic' };
    },
  };
  const res = await observe(
    {
      userText: 'Thinkers agreed on June 12, 5012 BC as the date of Creation.',
      assistantText: 'noted',
      toolSummaries: [],
      sessionId: 's',
      turnRef: 't',
      at: '2023-05-21T05:21:00.000Z',
    },
    localScope(),
    {
      store,
      decide,
      write,
      config,
      embed: { dimension: 4, embed: async (texts) => texts.map(() => vec(100, 0, 0, 0)) },
      now: new Date('2023-05-21T05:21:00.000Z'),
    },
  );
  expect(res.outcome).toBe('added');
  const m = await store.get(TG, res.memoryId ?? '');
  expect(m?.text).toContain('5012 BC');
  expect(m?.occurred).toBeUndefined();
});

it('invalid.a-caller-who-writes-it-is-refused-loudly', async () => {
  // The store's check is the API contract for an SDK caller or a version 2 import: strict.
  const store = createMemoryStore({ d: config.activation.d });
  await expect(store.upsert(TG, makeMemory({ id: 'x', occurred: BAD as never }))).rejects.toThrow(
    /occurred\[0\]\.from must be an ISO instant/,
  );
});
