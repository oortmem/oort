// One drain's consolidation in its own process, for the lock contention test (CON-48).
// argv: <oort home> <ms to stall inside the first store listing>
import * as path from 'node:path';
import { resolveConfig } from '@oortmem/core';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { consolidateIfDue, createHookLogger } from '../dist/index.js';

const [home, stallArg] = process.argv.slice(2);
const stall = Number(stallArg);
const store = await openSqliteStore({
  path: path.join(home, 'oort.sqlite'),
  coldDir: path.join(home, 'cold'),
  dimension: 4,
  log: () => {},
});
let stalled = false;
const slow = {
  ...store,
  async list(grant, opts) {
    if (!stalled) {
      stalled = true;
      await new Promise((r) => setTimeout(r, stall));
    }
    return store.list(grant, opts);
  },
};
const config = resolveConfig(home, { OORT_HOME: home });
const r = await consolidateIfDue({ store: slow, config, log: createHookLogger(home) });
await store.close();
process.stdout.write(`${r.outcome}\n`);
