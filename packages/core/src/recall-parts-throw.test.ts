/**
 * Reading the time out of a split question's parts is code over free text: if it throws, the
 * recall still answers with the parts as split, unstripped.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ScopeFilter } from './adapters.js';
import { resolveConfig } from './config.js';
import { createMemoryStore } from './memory-store.js';
import { recall } from './recall.js';
import { makeMemory, TG } from './store-conformance.js';

// The first read of the question (its view) works; any later read throws.
vi.mock('./event-time.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./event-time.js')>();
  let reads = 0;
  return {
    ...real,
    queryRange: (...args: Parameters<typeof real.queryRange>) => {
      reads++;
      if (reads > 1) throw new Error('reader failed');
      return real.queryRange(...args);
    },
  };
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-recall-parts-throw-'));
const config = resolveConfig(dir, { OORT_HOME: path.join(dir, 'home') });
const SCOPE: ScopeFilter = {
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
};

describe('a failing reader on a split question', () => {
  it('throw.the-parts-stay-as-split', async () => {
    const store = createMemoryStore({ d: config.activation.d });
    const at = '2023-04-05T09:00:00.000Z';
    await store.upsert(
      TG,
      makeMemory({
        id: 'desk',
        text: 'Got a standing desk.',
        createdAt: at,
        validFrom: at,
        updatedAt: at,
      }),
    );
    const r = await recall(
      {
        text: 'Which did I buy first two weeks ago, the standing desk or the office chair?',
        scope: SCOPE,
      },
      { store, config, now: new Date('2023-04-20T10:00:00.000Z') },
    );
    expect(r.temporal?.range).toBeDefined();
    expect(r.subQueries).toEqual([
      'buy standing desk two weeks ago',
      'buy office chair two weeks ago',
    ]);
  });
});
