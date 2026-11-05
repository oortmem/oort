#!/usr/bin/env node
// Fails when the two copies of the Voyage HTTP helper drift apart. embed-voyage and rerank-voyage
// each publish to npm on their own and must not depend on each other, so each keeps its own
// src/http.ts. Only the first line (the NOTE naming the other copy) may differ.
// Runs in `pnpm verify`.
import { readFileSync } from 'node:fs';

const COPIES = ['packages/embed-voyage/src/http.ts', 'packages/rerank-voyage/src/http.ts'];

const body = (file) => {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (!lines[0].startsWith('// NOTE: duplicated in ')) {
    console.error(`check-voyage-http: ${file} must start with the "// NOTE: duplicated in" line.`);
    process.exit(1);
  }
  return lines.slice(1).join('\n');
};

const [first, ...rest] = COPIES;
const expected = body(first);
const drifted = rest.filter((file) => body(file) !== expected);

if (drifted.length > 0) {
  console.error(`check-voyage-http: these copies differ from ${first}:\n`);
  for (const file of drifted) console.error(`  ${file}`);
  console.error('\nApply the same change to every copy. Only the first line may differ.');
  process.exit(1);
}
