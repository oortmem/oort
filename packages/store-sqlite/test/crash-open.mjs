// Child for the interrupted-build tests: opens an older store with a vector index to build
// (`binary` by default, or the fourth argument) and is killed (SIGKILL) inside the migration's
// transaction, as the index build starts. Imports the built package, so run `pnpm build` first
// (pnpm verify does).
import { writeSync } from 'node:fs';
import { openSqliteStore } from '../dist/index.js';

const [dbPath, coldDir, dimension, vectorIndex = 'binary'] = process.argv.slice(2);
const building =
  vectorIndex === 'rabitq'
    ? 'Building the RaBitQ vector index'
    : 'Building the binary vector index';
await openSqliteStore({
  path: dbPath,
  coldDir,
  dimension: Number(dimension),
  vectorIndex,
  log: (message) => {
    if (message.startsWith(building)) {
      writeSync(1, 'building\n');
      process.kill(process.pid, 'SIGKILL');
    }
  },
});
writeSync(1, 'opened without building\n');
