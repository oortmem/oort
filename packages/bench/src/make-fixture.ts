import * as fs from 'node:fs';
import type { EvalRow } from './eval.js';
import { buildDemoRows, buildHookRows, buildWarmUpRows, demoMemories } from './fixture.js';

/**
 * Regenerates the demo's eval files from the generator (`pnpm --filter @oortmem/bench run
 * fixture`): `eval/fixture.jsonl`, the hook-shaped `eval/hook.jsonl` and the warm-up
 * `eval/warm-up.jsonl`.
 */
const memories = demoMemories();
const files: [string, EvalRow[]][] = [
  ['fixture.jsonl', buildDemoRows(memories)],
  ['hook.jsonl', buildHookRows(memories)],
  ['warm-up.jsonl', buildWarmUpRows()],
];
for (const [name, rows] of files) {
  const file = new URL(`../eval/${name}`, import.meta.url);
  fs.writeFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  process.stdout.write(`wrote ${rows.length} rows to ${file.pathname}\n`);
}
