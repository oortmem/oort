#!/usr/bin/env node
// Copies each example file into docs/sdk.md and docs/python.md: the ```ts block after a
// `<!-- example: examples/src/<file>.ts -->` marker, or the ```python block after a
// `<!-- example: examples/python/<file>.py -->` marker, becomes that file, byte for byte.
// examples/test/docs.test.ts and packages/cli/src/sdk/python.test.ts fail when they differ, so
// run `pnpm docs:examples` after editing an example.
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOC = path.join(ROOT, 'docs/sdk.md');
/** Every doc whose example blocks are synced (Python examples live in both). */
export const DOCS = [DOC, path.join(ROOT, 'docs/python.md')];

/** `<!-- example: <path> -->`, a blank line, then a ```ts block. */
export const MARKED = /<!-- example: ([^\s]+) -->\n\n```ts\n([\s\S]*?)```\n/g;

/** `<!-- example: examples/python/<file>.py -->`, a blank line, then a ```python block. */
export const MARKED_PY =
  /<!-- example: (examples\/python\/[^\s]+\.py) -->\n\n```python\n([\s\S]*?)```\n/g;

export function syncExamples(doc) {
  return doc
    .replace(MARKED, (_all, file) => {
      const code = readFileSync(path.join(ROOT, file), 'utf8');
      return `<!-- example: ${file} -->\n\n\`\`\`ts\n${code}\`\`\`\n`;
    })
    .replace(MARKED_PY, (_all, file) => {
      const code = readFileSync(path.join(ROOT, file), 'utf8');
      return `<!-- example: ${file} -->\n\n\`\`\`python\n${code}\`\`\`\n`;
    });
}

if (import.meta.main) {
  for (const doc of DOCS) {
    const name = path.relative(ROOT, doc);
    const before = readFileSync(doc, 'utf8');
    const after = syncExamples(before);
    writeFileSync(doc, after);
    console.log(
      before === after ? `${name}: examples already in sync` : `${name}: examples updated`,
    );
  }
}
