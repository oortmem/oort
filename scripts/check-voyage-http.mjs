#!/usr/bin/env node
// Fails when duplicated files drift apart. Packages that publish to npm on their own and must not
// depend on each other keep their own copy:
// - the Voyage HTTP helper (embed-voyage and rerank-voyage);
// - the decision questions (decide-jev, and local-models' local decider, which asks the same).
// Only the first line (the NOTE naming the other copy) may differ. Runs in `pnpm verify`.
import { readFileSync } from 'node:fs';

const GROUPS = [
  ['packages/embed-voyage/src/http.ts', 'packages/rerank-voyage/src/http.ts'],
  ['packages/decide-jev/src/questions.ts', 'packages/local-models/src/questions.ts'],
];

const body = (file) => {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (!lines[0].startsWith('// NOTE: duplicated in ')) {
    console.error(`check-copies: ${file} must start with the "// NOTE: duplicated in" line.`);
    process.exit(1);
  }
  return lines.slice(1).join('\n');
};

let failed = false;
for (const [first, ...rest] of GROUPS) {
  const expected = body(first);
  const drifted = rest.filter((file) => body(file) !== expected);
  if (drifted.length > 0) {
    failed = true;
    console.error(`check-copies: these copies differ from ${first}:\n`);
    for (const file of drifted) console.error(`  ${file}`);
    console.error('\nApply the same change to every copy. Only the first line may differ.');
  }
}
if (failed) process.exit(1);
