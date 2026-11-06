import { execFile, execFileSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../../test/helpers.js';
import PKG from '../../package.json' with { type: 'json' };

/**
 * The published entry points, run from the built package in a fresh Node process (CON-108 §7.2):
 * what `import 'oortmem'` loads, what cloud mode loads and writes, and `require('oortmem')`.
 * These read `dist/`, which `pnpm verify` builds before testing.
 */

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Records every module a child resolves and every native addon it opens. */
const PRELOAD = `
import { registerHooks } from 'node:module';
globalThis.__loaded = [];
globalThis.__dlopen = [];
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    globalThis.__loaded.push(r.url);
    return r;
  },
});
const dlopen = process.dlopen;
process.dlopen = function (module, filename, ...rest) {
  globalThis.__dlopen.push(String(filename));
  return dlopen.call(this, module, filename, ...rest);
};
`;

/** Packages the root export must never load: the CLI's own, and the native store. */
const CLI_ONLY = [
  '/commander/',
  '/@clack/prompts/',
  '/@modelcontextprotocol/server/',
  '/picocolors/',
  '/smol-toml/',
  '/jsonc-parser/',
  '/dist/ui.js',
  '/dist/program.js',
  '/dist/output.js',
  '/dist/commands/',
];
const NATIVE = ['/better-sqlite3/', '/sqlite-vec', '/store-sqlite/'];

function run(
  script: string,
  env: Record<string, string> = {},
): { loaded: string[]; dlopen: string[]; out: unknown } {
  const dir = tmpdir('oort-sdk-pkg-');
  const preload = path.join(dir, 'preload.mjs');
  fs.writeFileSync(preload, PRELOAD);
  const main = path.join(dir, 'main.mjs');
  // Resolved from inside the package (a package may import itself by name through `exports`).
  fs.writeFileSync(
    main,
    `import { createRequire } from 'node:module';
const resolveFrom = createRequire(${JSON.stringify(path.join(PKG_DIR, 'package.json'))});
const load = () => import(resolveFrom.resolve('oortmem'));
let out = null;
${script}
console.log(JSON.stringify({ loaded: globalThis.__loaded, dlopen: globalThis.__dlopen, out }));`,
  );
  const stdout = execFileSync(process.execPath, ['--import', preload, main], {
    cwd: dir,
    env: { PATH: process.env['PATH'] ?? '', HOME: dir, OORT_NO_KEYCHAIN: '1', ...env },
    encoding: 'utf8',
  });
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as {
    loaded: string[];
    dlopen: string[];
    out: unknown;
  };
}

const hits = (loaded: string[], banned: string[]): string[] =>
  loaded.filter((u) => banned.some((b) => u.includes(b)));

describe('packaging (CON-108 §7)', () => {
  it('the exports map: the SDK at the root, the ai-sdk adapter, the bin kept, ESM only', () => {
    expect(PKG.exports['.']).toEqual({
      types: './dist/sdk/index.d.ts',
      default: './dist/sdk/index.js',
    });
    expect(PKG.exports['./ai-sdk'].default).toBe('./dist/sdk/adapters/ai-sdk.js');
    expect(PKG.bin).toEqual({ oort: 'dist/main.js', oortmem: 'dist/main.js' });
    expect(PKG.type).toBe('module');
    expect(PKG.engines.node).toBe('>=22.15.0');
    expect(PKG.sideEffects).toEqual(['./dist/main.js']);
    expect(PKG.peerDependenciesMeta.ai.optional).toBe(true);
  });

  it('import("oortmem") loads none of the CLI, no native module, and no top-level await', () => {
    const r = run(`const m = await load(); out = Object.keys(m).sort();`);
    expect(r.out).toEqual(
      expect.arrayContaining(['createOort', 'formatForPrompt', 'OortError', 'OortRefusedError']),
    );
    // The graph was really walked: the SDK and the engine it wraps were loaded.
    expect(r.loaded.some((u) => u.endsWith('/dist/sdk/index.js'))).toBe(true);
    expect(r.loaded.some((u) => u.includes('/core/dist/'))).toBe(true);
    expect(hits(r.loaded, CLI_ONLY)).toEqual([]);
    expect(hits(r.loaded, NATIVE)).toEqual([]);
    expect(r.dlopen).toEqual([]);
  });

  it('oortmem/ai-sdk loads neither ai nor the CLI', () => {
    const r = run(
      `const m = await import(resolveFrom.resolve('oortmem/ai-sdk')); out = Object.keys(m).sort();`,
    );
    expect(r.out).toEqual(['oortInstructions', 'oortObserve', 'oortTools']);
    expect(hits(r.loaded, ['/node_modules/ai/', ...CLI_ONLY, ...NATIVE])).toEqual([]);
  });

  it('cloud mode loads no native module and creates nothing under OORT_HOME', () => {
    const root = tmpdir('oort-sdk-cloud-');
    const home = path.join(root, 'home');
    const key = ['oort', 'sk', 'pkgtest'.padEnd(43, 'A')].join('_');
    const r = run(
      `const { createOort } = await load();
const fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.pathname === '/v1/whoami') return Response.json({ account: 'a1', plan: 'pro', via: 'key' });
  if (url.pathname === '/v1/recall') return Response.json({ memories: [], timings: {}, temporal: { mode: 'current', inferred: false } });
  return Response.json({ error: { code: 'not_found', message: 'no' } }, { status: 404 });
};
const oort = await createOort({ mode: 'cloud', fetch, keySources: ['env'] });
const who = await oort.whoami();
const rec = await oort.recall('anything');
await oort.close();
out = { mode: who.mode, account: who.account, n: rec.memories.length };`,
      { OORT_HOME: home, OORT_API_KEY: key, HOME: root },
    );
    expect(r.out).toEqual({ mode: 'cloud', account: 'a1', n: 0 });
    expect(hits(r.loaded, NATIVE)).toEqual([]);
    expect(hits(r.loaded, CLI_ONLY)).toEqual([]);
    expect(r.dlopen).toEqual([]);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('local mode does load the store (the import is dynamic, not absent)', () => {
    const root = tmpdir('oort-sdk-local-');
    const r = run(
      `const { createOort } = await load();
const oort = await createOort({ mode: 'local', keySources: [] });
out = (await oort.whoami()).mode;
await oort.close();`,
      { OORT_HOME: path.join(root, 'home'), HOME: root },
    );
    expect(r.out).toBe('local');
    expect(hits(r.loaded, ['/store-sqlite/']).length).toBeGreaterThan(0);
  });

  it('a cloud handle never closed does not keep the process alive (the pool is unref()d)', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ account: 'a1', plan: 'pro', via: 'key' }));
    });
    server.keepAliveTimeout = 120_000;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const dir = tmpdir('oort-sdk-pool-');
    const main = path.join(dir, 'main.mjs');
    fs.writeFileSync(
      main,
      `const { createRequire } = await import('node:module');
const m = await import(createRequire(${JSON.stringify(path.join(PKG_DIR, 'package.json'))}).resolve('oortmem'));
const oort = await m.createOort({ mode: 'cloud', keySources: ['env'], url: 'http://127.0.0.1:${port}' });
console.log((await oort.whoami()).account);`,
    );
    const started = Date.now();
    try {
      const out = await new Promise<string>((resolve, reject) =>
        execFile(
          process.execPath,
          [main],
          {
            cwd: dir,
            timeout: 30_000,
            env: {
              PATH: process.env['PATH'] ?? '',
              HOME: dir,
              OORT_NO_KEYCHAIN: '1',
              OORT_API_KEY: ['oort', 'sk', 'pool'.padEnd(43, 'P')].join('_'),
            },
          },
          (e, stdout) => (e === null ? resolve(stdout) : reject(e)),
        ),
      );
      expect(out.trim()).toBe('a1');
      // Far below the server's 120 s keep-alive: the open socket did not hold the process.
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("require('oortmem') works through Node's require(esm)", () => {
    const dir = tmpdir('oort-sdk-cjs-');
    const main = path.join(dir, 'main.cjs');
    fs.writeFileSync(
      main,
      `const m = require('node:module').createRequire(${JSON.stringify(path.join(PKG_DIR, 'package.json'))})('oortmem');
console.log(JSON.stringify([typeof m.createOort, typeof m.formatForPrompt, typeof m.OortError]));`,
    );
    const out = execFileSync(process.execPath, [main], {
      cwd: dir,
      env: { PATH: process.env['PATH'] ?? '', HOME: dir, NODE_NO_WARNINGS: '1' },
      encoding: 'utf8',
    });
    expect(JSON.parse(out.trim())).toEqual(['function', 'function', 'function']);
  });

  it('the exports map blocks deep imports', () => {
    const dir = tmpdir('oort-sdk-deep-');
    const main = path.join(dir, 'main.cjs');
    fs.writeFileSync(
      main,
      `try { require('node:module').createRequire(${JSON.stringify(path.join(PKG_DIR, 'package.json'))}).resolve('oortmem/dist/wire.js'); console.log('resolved'); }
catch (e) { console.log(e.code); }`,
    );
    const out = execFileSync(process.execPath, [main], { cwd: dir, encoding: 'utf8' });
    expect(out.trim()).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });
});
