#!/usr/bin/env node
// Generates docs/sdk-reference.md, the SDK's API reference, from the built type declarations of
// the `oortmem` package: its root export and `oortmem/ai-sdk` (packages/cli/package.json
// `exports`). Only what those entry points export is listed, plus the declarations a listed one
// refers to that the entry point does not export itself, each marked as such. Nothing else under
// dist (for example `createOortWith`, the internal test hook) can appear.
//
//   pnpm docs:reference           regenerate (after `pnpm build`)
//   pnpm docs:reference --check   fail when docs/sdk-reference.md is out of date (pnpm verify)
//
// TypeDoc would be the usual tool, but it needs the TypeScript 6 compiler API and this repo builds
// with TypeScript 7, which has none. The declarations tsc emits are regular enough to read here.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = path.join(ROOT, 'packages/cli');
const OUT = path.join(ROOT, 'docs/sdk-reference.md');

/** Splits a .d.ts file into top-level statements, each with the JSDoc block right before it. */
export function statements(text) {
  const out = [];
  let i = 0;
  let doc = null;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (text.startsWith('/**', i)) {
      const end = text.indexOf('*/', i + 3);
      // A JSDoc block followed by another one belongs to no statement: the file's own comment.
      if (doc !== null) out.push({ doc, text: '' });
      doc = text.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (text.startsWith('//', i)) {
      i = text.indexOf('\n', i) === -1 ? n : text.indexOf('\n', i);
      continue;
    }
    if (text.startsWith('/*', i)) {
      i = text.indexOf('*/', i + 2) + 2;
      continue;
    }
    const start = i;
    const block = /^(export\s+)?(declare\s+)?(abstract\s+)?(interface|class|enum|namespace)\b/.test(
      text.slice(start, start + 80),
    );
    let depth = 0;
    let sawBody = false;
    while (i < n) {
      const ch = text[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        i = skipString(text, i);
        continue;
      }
      if (text.startsWith('/*', i)) {
        i = text.indexOf('*/', i + 2) + 2;
        continue;
      }
      if (text.startsWith('//', i)) {
        i = text.indexOf('\n', i);
        continue;
      }
      if (ch === '{' || ch === '(' || ch === '[') {
        depth++;
        if (ch === '{') sawBody = true;
      } else if (ch === '}' || ch === ')' || ch === ']') {
        depth--;
        if (depth === 0 && ch === '}' && block && sawBody) {
          i++;
          break;
        }
      } else if (ch === ';' && depth === 0) {
        i++;
        break;
      }
      i++;
    }
    out.push({ doc, text: text.slice(start, i).trim() });
    doc = null;
  }
  return out;
}

function skipString(text, i) {
  const q = text[i];
  i++;
  while (i < text.length && text[i] !== q) i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

const DECL =
  /^(export\s+)?(declare\s+)?(abstract\s+)?(interface|type|class|function|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/;
const REEXPORT = /^export\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/;
const REEXPORT_ALL = /^export\s+(type\s+)?\*\s+from\s*['"]([^'"]+)['"]/;
const LOCAL_EXPORT = /^export\s+(type\s+)?\{([^}]*)\}\s*;?$/;

const modules = new Map();

/** One parsed .d.ts: its declarations by name, its re-exports, and its leading module comment. */
function parse(file) {
  if (modules.has(file)) return modules.get(file);
  const text = readFileSync(file, 'utf8');
  const decls = new Map();
  const reexports = [];
  const localExports = new Set();
  let moduleDoc = null;
  const stmts = statements(text);
  for (const [k, s] of stmts.entries()) {
    let m = DECL.exec(s.text);
    if (m) {
      const kind = m[4] === 'let' || m[4] === 'var' ? 'const' : m[4];
      decls.set(m[5], {
        name: m[5],
        kind,
        doc: s.doc,
        text: s.text,
        exported: Boolean(m[1]),
        file,
      });
      continue;
    }
    if ((m = REEXPORT.exec(s.text))) {
      for (const part of m[2].split(',')) {
        const p = part.trim().replace(/^type\s+/, '');
        if (p === '') continue;
        const [from, as = from] = p.split(/\s+as\s+/);
        reexports.push({ from: m[3], name: from, as });
      }
    } else if ((m = REEXPORT_ALL.exec(s.text))) {
      reexports.push({ from: m[2], all: true });
    } else if ((m = LOCAL_EXPORT.exec(s.text))) {
      for (const part of m[2].split(',')) {
        const p = part.trim().replace(/^type\s+/, '');
        if (p !== '') localExports.add(p);
      }
    }
    // The file's own comment: a detached JSDoc block, or one on a first statement that is not a
    // declaration (a re-export).
    if (
      moduleDoc === null &&
      s.doc !== null &&
      (s.text === '' || (k === 0 && !DECL.test(s.text)))
    ) {
      moduleDoc = s.doc;
    }
  }
  const mod = { file, decls, reexports, localExports, moduleDoc };
  modules.set(file, mod);
  return mod;
}

/** The .d.ts a module specifier names, from the importing file. */
function resolveDts(spec, fromFile) {
  if (spec.startsWith('.')) {
    return path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, '.d.ts'));
  }
  // The package's directory, found as Node does: node_modules/<spec> in this or a parent folder.
  let dir = path.dirname(fromFile);
  while (!existsSync(path.join(dir, 'node_modules', spec, 'package.json'))) {
    if (path.dirname(dir) === dir) throw new Error(`${fromFile}: cannot find ${spec}`);
    dir = path.dirname(dir);
  }
  const pkgJson = path.join(dir, 'node_modules', spec, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
  const types = pkg.exports?.['.']?.types ?? pkg.types;
  return path.join(path.dirname(pkgJson), types);
}

/** Every name an entry module exports, mapped to its declaration. */
function exportsOf(file) {
  const mod = parse(file);
  const out = new Map();
  for (const d of mod.decls.values()) {
    if (d.exported || mod.localExports.has(d.name)) out.set(d.name, d);
  }
  for (const r of mod.reexports) {
    const target = resolveDts(r.from, file);
    if (r.all) {
      for (const [name, d] of exportsOf(target)) out.set(name, d);
    } else {
      const d = exportsOf(target).get(r.name);
      if (d === undefined) throw new Error(`${file}: ${r.name} is not exported by ${r.from}`);
      out.set(r.as, d);
    }
  }
  return out;
}

const IDENT = /[A-Za-z_$][\w$]*/g;

/**
 * The public API of each entry point: its exports, then the declarations they refer to (in the
 * same .d.ts) that the entry point does not export, marked `exported: false`.
 */
export function publicApi() {
  const pkg = JSON.parse(readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
  const entries = [];
  for (const [sub, target] of Object.entries(pkg.exports)) {
    if (typeof target !== 'object' || target.types === undefined) continue;
    const file = path.join(PKG_DIR, target.types);
    if (!existsSync(file)) {
      throw new Error(`${path.relative(ROOT, file)} is missing: run \`pnpm build\` first`);
    }
    const spec = sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`;
    const exported = exportsOf(file);
    const symbols = [...exported].map(([name, d]) => ({ ...d, name, exported: true }));
    const seen = new Set(symbols.map((s) => `${s.file}#${s.name}`));
    for (let k = 0; k < symbols.length; k++) {
      const s = symbols[k];
      const local = parse(s.file).decls;
      const code = s.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const [id] of code.matchAll(IDENT)) {
        const d = local.get(id);
        if (d === undefined || id === s.name || exported.get(id) === d) continue;
        const keyOf = `${d.file}#${d.name}`;
        if (seen.has(keyOf)) continue;
        seen.add(keyOf);
        symbols.push({ ...d, exported: false, usedBy: s.name, root: s.root ?? s.name });
      }
    }
    entries.push({ spec, version: pkg.version, moduleDoc: parse(file).moduleDoc, symbols });
  }
  return entries;
}

/** The member names of an interface, class or object type (one level deep). */
export function membersOf(declaration) {
  const text = declaration.replace(/\/\*[\s\S]*?\*\//g, '');
  const open = text.indexOf('{');
  if (open === -1) return [];
  const names = [];
  let depth = 0;
  let line = '';
  const flush = () => {
    const m = /^\s*(?:readonly\s+|static\s+)*(\[Symbol\.\w+\]|[A-Za-z_$][\w$]*)\??\s*[:(<]/.exec(
      line,
    );
    if (m && !names.includes(m[1])) names.push(m[1]);
    line = '';
  };
  let computed = false; // inside a computed name: `[Symbol.asyncDispose]`
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (depth === 0 && ch === '[' && /^\s*(readonly\s+)?$/.test(line)) computed = true;
    if (computed) {
      line += ch;
      if (ch === ']') computed = false;
    } else if (ch === '{' || ch === '(' || ch === '[' || ch === '<') {
      if (depth === 0) line += ch; // a member's name ends at its first bracket
      depth++;
    } else if (ch === '}' || ch === ')' || ch === ']' || (ch === '>' && text[i - 1] !== '=')) {
      if (depth === 0) break; // the body's closing brace
      depth--;
    } else if (depth === 0 && (ch === '\n' || ch === ';')) flush();
    else if (depth === 0) line += ch;
  }
  flush();
  return names;
}

/** A JSDoc block as Markdown: its text, `@example` as code, other tags in bold. */
function docMarkdown(doc) {
  if (doc === null || doc === undefined) return '';
  const lines = doc
    .replace(/^\/\*\*\s?/, '')
    .replace(/\s*\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\* ?/, ''));
  const out = [];
  let code = false;
  for (const l of lines) {
    const tag = /^@(\w+)\s*(.*)$/.exec(l);
    if (tag && code) {
      out.push('```');
      code = false;
    }
    if (tag && tag[1] === 'example') {
      out.push('', '```ts');
      code = true;
      if (tag[2] !== '') out.push(tag[2]);
    } else if (tag) {
      out.push('', `**@${tag[1]}**${tag[2] === '' ? '' : ` ${tag[2]}`}`);
    } else {
      out.push(l);
    }
  }
  if (code) out.push('```');
  return out.join('\n').trim();
}

const KINDS = [
  ['function', 'Functions'],
  ['const', 'Constants'],
  ['class', 'Classes'],
  ['interface', 'Interfaces and types'],
];
const group = (kind) => (kind === 'type' || kind === 'enum' ? 'interface' : kind);

/** Re-indents tsc's four-space declarations to two, as the rest of the docs. */
const reindent = (text) => text.replace(/^((?: {4})+)/gm, (s) => ' '.repeat(s.length / 2));

export function render(entries) {
  const out = [
    '# `oortmem` API reference',
    '',
    `<!-- Generated by \`pnpm docs:reference\` (scripts/sdk-reference.mjs). Do not edit: \`pnpm verify\` fails when it is out of date. -->`,
    '',
    `Every name the \`oortmem\` ${entries[0].version} package exports from \`${entries.map((e) => e.spec).join('` and `')}\`, as its`,
    'published type declarations state it. The guide, with tested examples, is [sdk.md](sdk.md);',
    'the stability promise is in [sdk.md#stability](sdk.md#stability).',
    '',
  ];
  for (const e of entries) {
    out.push(`## \`${e.spec}\``, '');
    const md = docMarkdown(e.moduleDoc);
    if (md !== '') out.push(md, '');
    // Export order, except that a class comes after the class it extends (OortError first).
    const depth = (s) => {
      const base = /\bextends\s+([A-Za-z_$][\w$]*)/.exec(s.kind === 'class' ? s.text : '')?.[1];
      const parent = e.symbols.find((x) => x.exported && x.name === base);
      return parent === undefined ? 0 : 1 + depth(parent);
    };
    const listed = e.symbols
      .filter((s) => s.exported)
      .map((s, k) => ({ s, k, d: depth(s) }))
      .sort((a, b) => a.d - b.d || a.k - b.k)
      .map((x) => x.s);
    for (const [kind, title] of KINDS) {
      const names = listed
        .filter((s) => group(s.kind) === kind)
        .map((s) => `[\`${s.name}\`](#${anchor(e, s.name)})`);
      if (names.length > 0) out.push(`**${title}:** ${names.join(', ')}`, '');
    }
    for (const [kind, title] of KINDS) {
      const syms = listed.filter((s) => group(s.kind) === kind);
      if (syms.length === 0) continue;
      out.push(`### ${title}`, '');
      for (const s of syms) {
        out.push(`<a id="${anchor(e, s.name)}"></a>`, '', `#### \`${s.name}\``, '');
        const d = docMarkdown(s.doc);
        if (d !== '') out.push(d, '');
        out.push('```ts', reindent(s.text), '```', '');
        for (const x of e.symbols.filter((y) => !y.exported && y.root === s.name)) {
          out.push(
            `\`${x.name}\` is not exported from \`${e.spec}\`; \`${x.usedBy}\` uses it:`,
            '',
            '```ts',
            reindent(x.text),
            '```',
            '',
          );
        }
      }
    }
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

function anchor(entry, name) {
  return `${entry.spec.replace(/[^a-z0-9]+/gi, '-')}-${name}`.toLowerCase();
}

if (import.meta.main) {
  const text = render(publicApi());
  if (process.argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== text) {
      console.error(
        'docs/sdk-reference.md is out of date with the SDK’s types: run `pnpm build && pnpm docs:reference`.',
      );
      process.exit(1);
    }
    console.log('docs/sdk-reference.md is up to date');
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ${path.relative(ROOT, OUT)}`);
  }
}
