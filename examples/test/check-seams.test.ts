import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSeams, importsOf } from '../../scripts/check-seams.mjs';

/**
 * scripts/check-seams.mjs (CON-19, in pnpm verify): the repo as it is passes, and a fixture
 * workspace with one import across a seam fails, with the file, the line and the rule.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/check-seams.mjs');

type Pkg = { name: string; dependencies?: Record<string, string>; src: Record<string, string> };

/** A workspace with packages/<dir>/package.json and packages/<dir>/src/<file> for each entry. */
function workspace(pkgs: Record<string, Pkg>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'oort-seams-'));
  for (const [dir, { src, ...manifest }] of Object.entries(pkgs)) {
    mkdirSync(path.join(root, 'packages', dir), { recursive: true });
    for (const [file, text] of Object.entries(src)) {
      const p = path.join(root, 'packages', dir, 'src', file);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
    writeFileSync(path.join(root, 'packages', dir, 'package.json'), JSON.stringify(manifest));
  }
  return root;
}

const core = (src: Record<string, string> = { 'index.ts': 'export const x = 1;\n' }): Pkg => ({
  name: '@oortmem/core',
  src,
});
const adapter = (name: string, src: Record<string, string>): Pkg => ({
  name,
  dependencies: { '@oortmem/core': 'workspace:*' },
  src,
});

describe('check-seams', () => {
  it('seams.repo-passes', () => {
    expect(checkSeams()).toEqual([]);
  });

  it('seams.fetch-outside-the-network-packages-fails', () => {
    // CON-19: "a deliberately added fetch call in core fails pnpm verify". fetch is a global, so
    // no import shows it; the check reads the identifiers instead.
    const root = workspace({
      core: core({
        'a.ts': "export const get = () => fetch('https://example.com');\n",
        'b.ts': 'export const ws = () => new globalThis.WebSocket("wss://x");\n',
        'ok.ts':
          '// a comment may say fetch\nexport const s = "fetch";\nexport const f = (store: { fetch: () => void; fetchAll?: () => void }) => store.fetch();\n',
      }),
      'embed-voyage': adapter('@oortmem/embed-voyage', {
        'index.ts': "export const e = () => fetch('https://api.voyageai.com');\n",
      }),
    });
    const seams = { core: { uses: [] }, 'embed-voyage': { uses: ['core'], fetch: true } };
    expect(checkSeams({ root, seams })).toEqual([
      "packages/core/src/a.ts:1: 'fetch' reaches the network; only packages with network or fetch in SEAMS may",
      "packages/core/src/b.ts:1: 'WebSocket' reaches the network; only packages with network or fetch in SEAMS may",
    ]);
  });

  it('seams.core-importing-an-adapter-fails', () => {
    const root = workspace({
      core: core({
        'index.ts':
          "import { x } from './x.js';\nimport { voyageEmbedder } from '@oortmem/embed-voyage';\n",
        'x.ts': 'export const x = 1;\n',
      }),
      'embed-voyage': adapter('@oortmem/embed-voyage', { 'index.ts': 'export {};\n' }),
    });
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "packages/core/src/index.ts:2: '@oortmem/embed-voyage' crosses a seam: packages/core may not import packages/embed-voyage",
    );
    // The same workspace without the import passes.
    const clean = workspace({ core: core(), 'embed-voyage': adapter('@oortmem/embed-voyage', {}) });
    expect(spawnSync(process.execPath, [SCRIPT, '--root', clean]).status).toBe(0);
  });

  it('seams.every-rule', () => {
    const root = workspace({
      core: core(),
      'embed-voyage': adapter('@oortmem/embed-voyage', {
        'a.ts': "export { rerank } from '@oortmem/rerank-voyage';\n",
        'b.ts': "import '../../rerank-voyage/src/index.js';\n",
        'c.ts': "import { z } from 'zod';\n",
        'd.ts': "import * as http from 'node:http';\n",
      }),
      'rerank-voyage': adapter('@oortmem/rerank-voyage', { 'index.ts': 'export {};\n' }),
      writer: adapter('@oortmem/writer', {}),
      cli: {
        name: 'oortmem',
        dependencies: { '@oortmem/core': 'workspace:*', '@oortmem/writer': 'workspace:*' },
        src: {
          'static.ts': "import { anthropicWriter } from '@oortmem/writer';\n",
          'lazy.ts': [
            "import type { Writer } from '@oortmem/writer';",
            "const w = await import('@oortmem/writer');",
            "import * as http from 'node:http';",
          ].join('\n'),
          'x.test.ts': "import { x } from '@oortmem/embed-voyage';\n",
        },
      },
      newcomer: { name: '@oortmem/newcomer', src: {} },
    });
    expect(
      checkSeams({
        root,
        exceptions: [{ file: 'packages/core/src/gone.ts', specifier: 'x', why: 'stale' }],
      }),
    ).toEqual([
      "packages/cli/src/static.ts:1: '@oortmem/writer' must be loaded lazily here, with import() or import type",
      "packages/embed-voyage/src/a.ts:1: '@oortmem/rerank-voyage' crosses a seam: packages/embed-voyage may not import packages/rerank-voyage",
      "packages/embed-voyage/src/b.ts:1: '../../rerank-voyage/src/index.js' leaves packages/embed-voyage; import the other package by name",
      "packages/embed-voyage/src/c.ts:1: 'zod' is not in packages/embed-voyage/package.json dependencies, peerDependencies or optionalDependencies",
      "packages/embed-voyage/src/d.ts:1: 'node:http' is a network or process builtin; only cli and bench may use one",
      'packages/newcomer: not in SEAMS (scripts/check-seams.mjs); say what it may import',
      "packages/core/src/gone.ts: exception for 'x' matches no import; remove it",
    ]);
  });

  it('seams.reads-only-real-imports', () => {
    const src = [
      "// import { a } from 'in-a-comment';",
      "/* export * from 'in-a-block-comment'; */",
      'const s = "import { b } from \'in-a-string\'";',
      "const t = `import { c } from 'in-a-template' ${await import('in-a-template-expr')}`;",
      "const r = /from 'in-a-regex'/;",
      'const half = 1 / 2;',
      "import type { D } from 'type-only';",
      "import { type E, type F } from 'all-type-names';",
      "import G, { type H } from 'default-and-type';",
      "export type { I } from 'export-type';",
      "export * as ns from 'export-star';",
      "import 'side-effect';",
      "type J = typeof import('type-position');",
      "const k = require('required');",
      'const meta = import.meta.url;',
    ].join('\n');
    expect(importsOf(src).map(({ specifier, kind, line }) => [specifier, kind, line])).toEqual([
      ['in-a-template-expr', 'dynamic', 4],
      ['type-only', 'type', 7],
      ['all-type-names', 'type', 8],
      ['default-and-type', 'static', 9],
      ['export-type', 'type', 10],
      ['export-star', 'static', 11],
      ['side-effect', 'static', 12],
      ['type-position', 'dynamic', 13],
      ['required', 'static', 14],
    ]);
  });
});
