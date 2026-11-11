#!/usr/bin/env node
// Fails when a package imports across a seam it shouldn't (CON-19). `@oortmem/core` defines the
// interfaces and the adapters plug into it, so:
//
//   - core imports no other workspace package;
//   - each adapter (embed-voyage, rerank-voyage, decide-jev, writer, store-sqlite, local-models,
//     mcp, claude-code) imports core and nothing else from the workspace. embed-voyage and
//     rerank-voyage publish on their own and must not depend on each other (check-voyage-http.mjs);
//   - only the CLI wires adapters together, and it loads the model adapters lazily, with `import()`
//     or `import type` ("Vendor SDKs ... loaded by import() at wire time", docs/design/
//     2026-11-06-sdk-design.md §7.2). @oortmem/local-models is an optional peer, so a static import
//     would break the CLI where it isn't installed;
//   - bench is a private harness and may import what it measures;
//   - a relative import never leaves its package (that would bypass the package's exports);
//   - every other bare import is declared in the package's own dependencies, peerDependencies or
//     optionalDependencies, so a vendor SDK reaches a package only through its package.json;
//   - only cli and bench touch the raw network and process builtins (http, net, child_process, …).
//     The adapters reach the network through `fetch` only, and only the ones marked `fetch: true`
//     may: core, store-sqlite, mcp and claude-code never name fetch, WebSocket and the like.
//
// It reads import, export ... from, side-effect, `import()` and `require()` specifiers in
// packages/*/src, skipping *.test.ts. Specifiers built at run time are not seen.
//
//   node scripts/check-seams.mjs [--root <dir>]   (pnpm check:seams, part of pnpm verify)
//
// examples/test/check-seams.test.ts tests it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What each package under packages/ may import from the workspace, by directory name. `uses` may be
 * imported any way; `lazy` only with `import()` or `import type`. A package missing here fails the
 * check, so a new package needs a decision.
 */
export const SEAMS = {
  core: { uses: [] },
  'embed-voyage': { uses: ['core'], fetch: true },
  'rerank-voyage': { uses: ['core'], fetch: true },
  'decide-jev': { uses: ['core'], fetch: true },
  writer: { uses: ['core'], fetch: true },
  'store-sqlite': { uses: ['core'] },
  'local-models': { uses: ['core'], fetch: true }, // downloads the model files
  mcp: { uses: ['core'] },
  'claude-code': { uses: ['core'] },
  cli: {
    uses: ['core', 'claude-code', 'mcp', 'store-sqlite'],
    lazy: ['embed-voyage', 'rerank-voyage', 'decide-jev', 'writer', 'local-models'],
    network: true,
  },
  bench: {
    uses: ['core', 'store-sqlite', 'embed-voyage', 'rerank-voyage', 'local-models'],
    network: true,
  },
};

/**
 * Imports that break a rule above but are allowed for now, each with the reason:
 * `{ file: 'packages/<dir>/src/<file>.ts', specifier: '<as written>', why: '<reason>' }`.
 * An entry that no longer matches an import fails the check, so the list only shrinks.
 */
export const EXCEPTIONS = [];

/** Globals that reach the network without an import: only `network` or `fetch` packages name them. */
const NETWORK_GLOBALS = new Set([
  'fetch',
  'WebSocket',
  'XMLHttpRequest',
  'EventSource',
  'sendBeacon',
]);
/** `globalThis.fetch` is the global; `store.fetch` is someone's method. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self', 'window', 'navigator']);

/** Builtins that open a socket or start a process or thread the zero-network stubs can't see. */
const NETWORK_BUILTINS = new Set([
  'child_process',
  'cluster',
  'dgram',
  'dns',
  'http',
  'http2',
  'https',
  'net',
  'tls',
  'worker_threads',
]);
const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));

const KEYWORDS_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * The tokens of a TypeScript source that matter for imports: identifiers and keywords
 * (`{ t: 'id' }`), string literals (`{ t: 'str' }`, value unescaped only for simple escapes),
 * numbers (`{ t: 'num' }`) and punctuation (`{ t: 'p' }`), each with its line. Comments, regex literals and template literal
 * text are skipped; `${}` expressions inside templates are tokenized.
 */
export function tokenize(src) {
  const out = [];
  const braces = []; // for each open `{`: true when it opened a template `${`
  let i = 0;
  let line = 1;
  const prevAllowsRegex = () => {
    const p = out.at(-1);
    if (p === undefined) return true;
    if (p.t === 'id') return KEYWORDS_BEFORE_REGEX.has(p.v);
    if (p.t === 'str' || p.t === 'num') return false;
    return !(p.v === ')' || p.v === ']' || p.v === '}' || p.v === '`');
  };
  const template = () => {
    // i is just past a backtick or a template `}`; skip text up to the closing backtick or `${`.
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') i += 2;
      else if (c === '`') {
        i++;
        out.push({ t: 'p', v: '`', line });
        return;
      } else if (c === '$' && src[i + 1] === '{') {
        i += 2;
        braces.push(true);
        return;
      } else {
        if (c === '\n') line++;
        i++;
      }
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
    } else if (/\s/.test(c)) i++;
    else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) if (src[i] === '\n') line++;
    } else if (c === '"' || c === "'") {
      let v = '';
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') {
          v += src[i + 1] ?? '';
          i += 2;
        } else v += src[i++];
      }
      i++;
      out.push({ t: 'str', v, line });
    } else if (c === '`') {
      i++;
      template();
    } else if (c === '/' && prevAllowsRegex()) {
      let inClass = false;
      i++;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '/' && !inClass) break;
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        i += src[i] === '\\' ? 2 : 1;
      }
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      out.push({ t: 'str', v: '', line, regex: true });
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z0-9_$]+/.exec(src.slice(i, i + 200));
      out.push({ t: 'id', v: m[0], line });
      i += m[0].length;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9A-Za-z_.]+/.exec(src.slice(i, i + 200));
      out.push({ t: 'num', v: m[0], line });
      i += m[0].length;
    } else if (c === '{') {
      braces.push(false);
      out.push({ t: 'p', v: c, line });
      i++;
    } else if (c === '}') {
      i++;
      if (braces.pop() === true) template();
      else out.push({ t: 'p', v: c, line });
    } else {
      out.push({ t: 'p', v: c, line });
      i++;
    }
  }
  return out.filter((t) => !t.regex);
}

/**
 * The module specifiers a source imports: `{ specifier, line, kind }`, where kind is `static`
 * (a value import, export ... from, side-effect import or require), `type` (`import type`,
 * `export type`, or only `type`-marked names) or `dynamic` (`import()`, also in type position).
 */
export function importsOf(src) {
  const toks = tokenize(src);
  const out = [];
  const at = (k) => toks[k] ?? { t: 'eof', v: '' };
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    if (tok.t !== 'id' || at(k - 1).v === '.') continue;
    if (tok.v === 'require' && at(k + 1).v === '(' && at(k + 2).t === 'str') {
      out.push({ specifier: at(k + 2).v, line: tok.line, kind: 'static' });
    } else if (tok.v === 'import' && at(k + 1).v === '(') {
      if (at(k + 2).t === 'str')
        out.push({ specifier: at(k + 2).v, line: tok.line, kind: 'dynamic' });
    } else if (tok.v === 'import' && at(k + 1).t === 'str') {
      out.push({ specifier: at(k + 1).v, line: tok.line, kind: 'static' });
    } else if (
      (tok.v === 'import' || tok.v === 'export') &&
      (at(k + 1).t === 'id' || at(k + 1).v === '{' || at(k + 1).v === '*')
    ) {
      const clause = fromClause(toks, k + 1, tok.v === 'export');
      if (clause !== undefined) out.push({ ...clause, line: tok.line });
    }
  }
  return out;
}

/** `import <clause> from 'x'` or `export <clause> from 'x'`, starting at the clause. */
function fromClause(toks, k, isExport) {
  let typeOnly = false;
  if (toks[k]?.v === 'type' && toks[k + 1]?.v !== 'from' && toks[k + 1]?.v !== ',') {
    typeOnly = true;
    k++;
  }
  if (isExport && toks[k]?.v !== '*' && toks[k]?.v !== '{') return undefined;
  let names = 0;
  let typeNames = 0;
  let bare = false; // a default or namespace import
  for (; k < toks.length; k++) {
    const t = toks[k];
    if (t.v === 'from' && toks[k + 1]?.t === 'str') {
      const allTypes = names > 0 && typeNames === names && !bare;
      return { specifier: toks[k + 1].v, kind: typeOnly || allTypes ? 'type' : 'static' };
    }
    if (t.v === ';' || t.v === '=' || t.v === '(' || t.t === 'str') return undefined;
    if (t.v === '{') {
      let first = true;
      for (k++; k < toks.length && toks[k].v !== '}'; k++) {
        if (first && toks[k].t === 'id') {
          names++;
          // `{ type A }` counts as type-only because the packages don't set verbatimModuleSyntax.
          // If they ever do, this form keeps a side-effect import at run time.
          if (toks[k].v === 'type' && toks[k + 1]?.t === 'id' && toks[k + 1].v !== 'as') {
            typeNames++;
          }
        }
        first = toks[k].v === ',';
      }
      if (toks[k + 1]?.v !== 'from') return undefined;
    } else if (t.t === 'id' || t.v === '*') bare = true;
  }
  return undefined;
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
const packageOf = (spec) =>
  spec
    .split('/')
    .slice(0, spec.startsWith('@') ? 2 : 1)
    .join('/');

function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (
        /\.(ts|mts|cts|tsx|js|mjs|cjs)$/.test(e.name) &&
        !/\.test\.[cm]?[jt]sx?$/.test(e.name)
      ) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** Every seam problem under `root`, as `file:line: message` strings; empty when clean. */
export function checkSeams({ root = ROOT, seams = SEAMS, exceptions = EXCEPTIONS } = {}) {
  const problems = [];
  const pkgsDir = path.join(root, 'packages');
  const dirs = readdirSync(pkgsDir)
    .sort()
    .filter((d) => {
      const p = path.join(pkgsDir, d, 'package.json');
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
  const manifest = new Map(
    dirs.map((d) => [d, JSON.parse(readFileSync(path.join(pkgsDir, d, 'package.json'), 'utf8'))]),
  );
  const dirOf = new Map(dirs.map((d) => [manifest.get(d).name, d]));
  const unused = new Set(exceptions);
  const excepted = (file, specifier) => {
    const e = exceptions.find((x) => x.file === file && x.specifier === specifier);
    if (e !== undefined) unused.delete(e);
    return e !== undefined;
  };

  for (const dir of dirs) {
    const rule = seams[dir];
    if (rule === undefined) {
      problems.push(
        `packages/${dir}: not in SEAMS (scripts/check-seams.mjs); say what it may import`,
      );
      continue;
    }
    const pkg = manifest.get(dir);
    const declared = new Set(
      ['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap((f) =>
        Object.keys(pkg[f] ?? {}),
      ),
    );
    const srcDir = path.join(pkgsDir, dir, 'src');
    let files = [];
    try {
      files = sourceFiles(srcDir);
    } catch {
      continue;
    }
    for (const file of files) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      const src = readFileSync(file, 'utf8');
      if (rule.network !== true && rule.fetch !== true) {
        const toks = tokenize(src);
        toks.forEach((t, k) => {
          if (t.t !== 'id' || !NETWORK_GLOBALS.has(t.v)) return;
          if (toks[k - 1]?.v === '.' && !GLOBAL_OBJECTS.has(toks[k - 2]?.v)) return;
          // A property key (`fetch: …`, `fetch?: …`) is a name, not the global. A method signature
          // (`fetch(): void`) looks like a call to this tokenizer, so it is flagged: write it as a
          // property instead.
          if (toks[k + 1]?.v === ':' || (toks[k + 1]?.v === '?' && toks[k + 2]?.v === ':')) return;
          problems.push(
            `${rel}:${t.line}: '${t.v}' reaches the network; only packages with network or fetch in SEAMS may`,
          );
        });
      }
      for (const { specifier, line, kind } of importsOf(src)) {
        const problem = judge(specifier, kind);
        if (problem !== undefined && !excepted(rel, specifier)) {
          problems.push(`${rel}:${line}: '${specifier}' ${problem}`);
        }
      }
      function judge(specifier, kind) {
        if (specifier.startsWith('.')) {
          const target = path.resolve(path.dirname(file), specifier);
          const inside = path.relative(path.join(pkgsDir, dir), target);
          if (inside.startsWith('..') || path.isAbsolute(inside)) {
            return `leaves packages/${dir}; import the other package by name`;
          }
          return undefined;
        }
        const bare = specifier.replace(/^node:/, '');
        if (specifier.startsWith('node:') || BUILTINS.has(packageOf(bare))) {
          if (NETWORK_BUILTINS.has(bare.split('/')[0]) && rule.network !== true) {
            return `is a network or process builtin; only cli and bench may use one`;
          }
          return undefined;
        }
        const name = packageOf(specifier);
        if (name === pkg.name) return undefined;
        const target = dirOf.get(name);
        if (target !== undefined) {
          if ((rule.uses ?? []).includes(target)) return undefined;
          if ((rule.lazy ?? []).includes(target)) {
            return kind === 'static'
              ? `must be loaded lazily here, with import() or import type`
              : undefined;
          }
          return `crosses a seam: packages/${dir} may not import packages/${target}`;
        }
        if (!declared.has(name)) {
          return `is not in packages/${dir}/package.json dependencies, peerDependencies or optionalDependencies`;
        }
        return undefined;
      }
    }
  }
  for (const e of unused) {
    problems.push(`${e.file}: exception for '${e.specifier}' matches no import; remove it`);
  }
  return problems;
}

// Not `import.meta.main`: it needs Node 22.18+, and engines allow 22.15, where the check would
// silently pass without running.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--root');
  const root = at === -1 ? ROOT : path.resolve(process.argv[at + 1]);
  const problems = checkSeams({ root });
  if (problems.length > 0) {
    console.error('check-seams: these imports or network calls cross a seam:\n');
    for (const p of problems) console.error(`  ${p}`);
    console.error('\nSee the rules at the top of scripts/check-seams.mjs.');
    process.exit(1);
  }
}
