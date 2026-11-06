/**
 * The background update check (CON-114), started detached by `requestRefresh` when the cache in
 * `<OORT_HOME>/update-check.json` is a day old: one GET of npm's `latest` for `oortmem` (1.5 s
 * timeout, nothing about the user sent), then the cache is rewritten. Exits on its own.
 */
import { homedir } from 'node:os';
import { homeFrom } from './serve-protocol.js';
import { refreshUpdateCache, updateCheckOff } from './update-check.js';

const home = homeFrom(process.env, homedir);
if (updateCheckOff(process.env, home) === undefined) {
  await refreshUpdateCache(home, globalThis.fetch).catch(() => undefined);
}
process.exit(0);
