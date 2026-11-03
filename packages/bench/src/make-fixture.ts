import * as fs from 'node:fs';
import { buildFixtureRows, FIXTURE_COUNT, FIXTURE_SEED } from './fixture.js';
import { generateMemories } from './generate.js';

/** Regenerates `eval/fixture.jsonl` from the generator (`pnpm --filter @oortmem/bench run fixture`). */
const rows = buildFixtureRows(generateMemories(FIXTURE_COUNT, FIXTURE_SEED));
const file = new URL('../eval/fixture.jsonl', import.meta.url);
fs.writeFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
process.stdout.write(`wrote ${rows.length} rows to ${file.pathname}\n`);
