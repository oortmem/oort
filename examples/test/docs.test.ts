import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOC, MARKED, syncExamples } from '../../scripts/sdk-examples.mjs';
import { membersOf, publicApi } from '../../scripts/sdk-reference.mjs';

/**
 * docs/sdk.md stays true: every TypeScript block in it is an example file, byte for byte (so it
 * is typechecked and run), and every API name it mentions exists in the built declarations.
 * Needs `pnpm build` (pnpm verify builds first).
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const doc = readFileSync(DOC, 'utf8');
const examples = readdirSync(path.join(ROOT, 'examples/src')).filter((f) => f.endsWith('.ts'));

interface Symbol {
  name: string;
  kind: string;
  text: string;
  exported: boolean;
}
const api = (publicApi() as { spec: string; symbols: Symbol[] }[]).map((e) => ({
  spec: e.spec,
  symbols: new Map(e.symbols.filter((s) => s.exported).map((s) => [s.name, s])),
}));
const exported = new Map(api.flatMap((e) => [...e.symbols]));
const decl = (name: string): Symbol => {
  const s = exported.get(name);
  if (s === undefined) throw new Error(`${name} is not exported`);
  return s;
};
const members = (name: string): string[] => membersOf(decl(name).text) as string[];

/** The text of the section under `## <title>`, up to the next `## `. */
function section(title: string): string {
  const start = doc.indexOf(`\n## ${title}\n`);
  expect(start, `section "${title}"`).toBeGreaterThan(-1);
  const end = doc.indexOf('\n## ', start + 4);
  return doc.slice(start, end === -1 ? undefined : end);
}

/** The cells of column `col` of every body row of the first table in `text`. */
function column(text: string, col: number): string[] {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.startsWith('|'));
  const after = lines.findIndex((l, k) => k > first && !l.startsWith('|'));
  const rows = lines.slice(first, after === -1 ? undefined : after);
  return rows.slice(2).map((r) => (r.split(/(?<!\\)\|/)[col + 1] ?? '').trim());
}

const spans = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/** Prose only: fenced code blocks removed. */
const prose = doc.replace(/```[\s\S]*?```/g, '');

describe('docs/sdk.md: code blocks are the tested examples', () => {
  it('every ts block is marked as an example file and matches it byte for byte', () => {
    const blocks = [...doc.matchAll(/```ts\n/g)].length;
    const marked = [...doc.matchAll(MARKED)];
    expect(marked.length, 'a ```ts block without an example marker').toBe(blocks);
    for (const [, file, code] of marked) {
      expect(code, `${file} differs from docs/sdk.md: run \`pnpm docs:examples\``).toBe(
        readFileSync(path.join(ROOT, file!), 'utf8'),
      );
    }
    expect(syncExamples(doc)).toBe(doc);
  });

  it('shows every example', () => {
    const shown = new Set([...doc.matchAll(MARKED)].map((m) => path.basename(m[1]!)));
    expect([...shown].sort()).toEqual([...examples].sort());
  });
});

describe('docs/sdk.md: every API name exists in the built .d.ts', () => {
  it('every Oort… name, and every type a table returns, is exported', () => {
    const named = new Set(spans(prose).filter((s) => /^Oort[A-Za-z]*$/.test(s)));
    for (const s of column(section('Methods'), 1).flatMap(spans)) {
      for (const [id] of s.matchAll(/\b[A-Z][A-Za-z]+\b/g)) named.add(id);
    }
    expect(named.size).toBeGreaterThan(15);
    // Names the examples define themselves (OortStore, oortSession) are not the SDK's.
    const own = new Set(
      examples.flatMap((f) =>
        [
          ...readFileSync(path.join(ROOT, 'examples/src', f), 'utf8').matchAll(
            /^export (?:class|function|const) (\w+)/gm,
          ),
        ].map((m) => m[1]),
      ),
    );
    const missing = [...named].filter((n) => !exported.has(n) && !own.has(n));
    expect(missing).toEqual([]);
  });

  it('every method in the Methods table is on Oort, OortJudge or exported', () => {
    const oort = new Set(members('Oort'));
    const judge = new Set(members('OortJudge'));
    const calls = column(section('Methods'), 0).flatMap(spans);
    expect(calls.length).toBeGreaterThan(15);
    for (const c of calls) {
      const name = /^(judge\.)?(\[Symbol\.\w+\]|\w+)/.exec(c);
      expect(name, c).not.toBeNull();
      const [, judged, id] = name!;
      const found = judged ? judge.has(id!) : oort.has(id!) || exported.has(id!);
      expect(found, `${c} in the Methods table`).toBe(true);
    }
  });

  it('every option in the Options table is an OortOptions key', () => {
    const keys = new Set(members('OortOptions'));
    const options = column(section('Options'), 0).flatMap(spans);
    expect(options.length).toBeGreaterThan(15);
    expect(options.filter((o) => !keys.has(o))).toEqual([]);
    // …and the table lists every option.
    expect([...keys].filter((k) => !options.includes(k))).toEqual([]);
  });

  it('the recall options it lists are RecallOptions keys', () => {
    const para = /\*\*`recall` options\.\*\*([\s\S]*?)\n\n/.exec(prose)?.[1] ?? '';
    const keys = new Set(members('RecallOptions'));
    const named = spans(para).filter((s) => /^[a-z][A-Za-z]*$/.test(s) && keys.has(s));
    expect(named.length).toBeGreaterThan(8);
    // Every RecallOptions key is described.
    expect([...keys].filter((k) => !named.includes(k))).toEqual([]);
  });

  it('the result fields it lists are on MemoryView or RecalledMemory', () => {
    const para = /\*\*Results\.\*\*([\s\S]*?)\n\n/.exec(prose)?.[1] ?? '';
    const fields = new Set([...members('MemoryView'), ...members('RecalledMemory')]);
    const named = spans(para).filter((s) => /^[a-z][A-Za-z]*$/.test(s));
    expect(named.length).toBeGreaterThan(15);
    // A field, a RecallResult field (`degraded`, `warnings`), or a MemoryStatus value.
    const unknown = named.filter(
      (s) =>
        !fields.has(s) &&
        !members('RecallResult').includes(s) &&
        !decl('MemoryStatus').text.includes(`'${s}'`),
    );
    expect(unknown).toEqual([]);
  });

  it('the error table matches the classes and their codes', () => {
    const errors = section('Errors');
    const classes = column(errors, 0).flatMap(spans);
    const codes = column(errors, 1).flatMap(spans);
    expect(classes).toHaveLength(10);
    const union = decl('OortErrorCode').text;
    for (const c of classes) expect(decl(c).kind, c).toBe('class');
    for (const c of codes) expect(union, c).toContain(`'${c}'`);
    // One row per code, and every class is in the table.
    expect(new Set(codes).size).toBe(10);
    const errorClasses = [...exported.values()].filter((s) => s.kind === 'class');
    expect(errorClasses.map((s) => s.name).filter((n) => !classes.includes(n))).toEqual([
      'OortError',
    ]);
  });

  it('every name imported from oortmem in its code blocks is exported', () => {
    for (const m of doc.matchAll(/import \{([^}]+)\} from '(oortmem(?:\/ai-sdk)?)'/g)) {
      const entry = api.find((e) => e.spec === m[2])!;
      for (const raw of m[1]!.split(',')) {
        const name = raw.trim().replace(/^type\s+/, '');
        if (name !== '') expect(entry.symbols.has(name), `${name} from ${m[2]}`).toBe(true);
      }
    }
  });
});
