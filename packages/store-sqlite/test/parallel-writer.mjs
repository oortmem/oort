// Worker for store.parallel-writers-no-busy: one connection doing n upserts.
// Imports the built package, so run `pnpm build` first (pnpm verify does).
import { parentPort, workerData } from 'node:worker_threads';
import { localGrant } from '@oortmem/core';
import { openSqliteStore } from '../dist/index.js';

const { path, coldDir, dimension, tag, n } = workerData;
const at = '2026-01-01T00:00:00.000Z';
const store = await openSqliteStore({ path, coldDir, dimension, log: () => {} });
const grant = localGrant({
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null],
});
const errors = [];
for (let i = 0; i < n; i++) {
  try {
    await store.upsert(grant, {
      id: `${tag}-${i}`,
      scope: { orgId: 'local', customerId: 'self', agentId: 'claude-code' },
      type: 'semantic',
      text: `memory ${tag}-${i}`,
      stub: `stub ${tag}-${i}`,
      entities: [],
      salience: 0.5,
      pinned: false,
      tier: 'warm',
      accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
      validFrom: at,
      validTo: null,
      expiredAt: null,
      endReason: null,
      lastConfirmedAt: null,
      supersedes: null,
      supersededBy: null,
      source: { harness: 'test', decisions: [] },
      createdAt: at,
      updatedAt: at,
      embedding: Int8Array.from([1, i % 100, 2, 3]),
    });
  } catch (e) {
    errors.push(String(e?.code ?? e?.message ?? e));
  }
}
await store.close();
parentPort.postMessage(errors);
