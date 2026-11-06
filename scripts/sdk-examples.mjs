#!/usr/bin/env node
// Copies each example file into docs/sdk.md: the ```ts block after a
// `<!-- example: examples/src/<file>.ts -->` marker becomes that file, byte for byte.
// examples/test/docs.test.ts fails when they differ, so run `pnpm docs:examples` after editing
// an example.
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOC = path.join(ROOT, 'docs/sdk.md');

/** `<!-- example: <path> -->`, a blank line, then a ```ts block. */
export const MARKED = /<!-- example: ([^\s]+) -->\n\n```ts\n([\s\S]*?)```\n/g;

export function syncExamples(doc) {
  return doc.replace(MARKED, (_all, file) => {
    const code = readFileSync(path.join(ROOT, file), 'utf8');
    return `<!-- example: ${file} -->\n\n\`\`\`ts\n${code}\`\`\`\n`;
  });
}

if (import.meta.main) {
  const before = readFileSync(DOC, 'utf8');
  const after = syncExamples(before);
  writeFileSync(DOC, after);
  console.log(
    before === after ? 'docs/sdk.md: examples already in sync' : 'docs/sdk.md: examples updated',
  );
}
