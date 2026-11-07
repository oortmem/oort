// Worker for store.open-waits-for-the-wal-switch: opens the store and reports how it went.
// Imports the built package, so run `pnpm build` first (pnpm verify does).
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { openSqliteStore } from '../dist/index.js';

const { path, coldDir, dimension, busyTimeoutMs } = workerData;
parentPort.postMessage('opening'); // the test holds its lock from here
try {
  const store = await openSqliteStore({ path, coldDir, dimension, busyTimeoutMs, log: () => {} });
  await store.close();
  const db = new Database(path, { readonly: true });
  const mode = db.pragma('journal_mode', { simple: true });
  db.close();
  parentPort.postMessage({ ok: true, mode });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e?.code ?? e?.message ?? e) });
}
