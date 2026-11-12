// Child for migrate.interrupted-build-leaves-the-v5-store-as-it-was: opens a schema version 5
// store with the binary index and is killed (SIGKILL) inside the migration's transaction, as the
// index build starts. Imports the built package, so run `pnpm build` first (pnpm verify does).
import { writeSync } from 'node:fs';
import { openSqliteStore } from '../dist/index.js';

const [dbPath, coldDir, dimension] = process.argv.slice(2);
await openSqliteStore({
  path: dbPath,
  coldDir,
  dimension: Number(dimension),
  vectorIndex: 'binary',
  log: (message) => {
    if (message.startsWith('Building the binary vector index')) {
      writeSync(1, 'building\n');
      process.kill(process.pid, 'SIGKILL');
    }
  },
});
writeSync(1, 'opened without building\n');
