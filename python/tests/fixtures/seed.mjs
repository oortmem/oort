// Test-only: writes memories straight into a throwaway store (no models, no keys), for the Python
// integration test. Usage: node seed.mjs <repo root> <OORT_HOME> <memories JSON>. Each memory is
// `{ id, text, user? }`: the person's Planet, or an end user's (org `acme`) when `user` is set.
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, home, raw] = process.argv.slice(2);
const load = (p) => import(pathToFileURL(path.join(root, p)).href);
const { nodeGrant } = await load('packages/core/dist/index.js');
const { openSqliteStore } = await load('packages/store-sqlite/dist/index.js');

const store = await openSqliteStore({
  path: path.join(home, 'oort.sqlite'),
  coldDir: path.join(home, 'cold'),
  dimension: 512,
  log: () => {},
});
const at = '2026-10-01T00:00:00.000Z';
try {
  for (const m of JSON.parse(raw)) {
    const org = m.user === undefined ? 'local' : 'acme';
    const customerId = m.user ?? 'self';
    const principal = { orgId: org, customerId, agentId: 'anonymous' };
    const grant = nodeGrant({
      principal,
      read: [{ node: { level: 'user', orgId: org, customerId }, projectIds: 'all' }],
    });
    await store.upsert(grant, {
      id: m.id,
      scope: principal,
      type: 'semantic',
      text: m.text,
      stub: m.text.slice(0, 40),
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
      source: { harness: 'seed', decisions: [] },
      createdAt: at,
      updatedAt: at,
    });
  }
} finally {
  await store.close();
}
