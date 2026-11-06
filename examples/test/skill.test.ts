import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKED } from '../../scripts/sdk-examples.mjs';
import { membersOf, publicApi } from '../../scripts/sdk-reference.mjs';
import {
  filesUnder,
  frontmatter,
  SKILLS,
  skillProblems,
  syncSkills,
} from '../../scripts/skills.mjs';

/**
 * skills/oort-sdk stays true to oortmem as built: it follows the Agent Skills format, every
 * TypeScript block is a tested example byte for byte, the Python block runs against the built
 * CLI, every SDK name it mentions is in the built declarations, and every `oort` command and flag
 * is in docs/cli.md. Needs `pnpm build` (pnpm verify builds first).
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8');
const SKILL = 'skills/oort-sdk';
const files = (filesUnder(path.join(ROOT, SKILL)) as string[]).filter((f) => f.endsWith('.md'));
const texts = new Map(files.map((f) => [f, read(`${SKILL}/${f}`)]));
const all = [...texts.values()].join('\n');
const cliDoc = read('docs/cli.md');
const sdkDoc = read('docs/sdk.md');
const version = (JSON.parse(read('packages/cli/package.json')) as { version: string }).version;

/** `<!-- tested: python, … -->`, a blank line, then a ```python block. */
const TESTED_PYTHON =
  /<!-- tested: python, by examples\/test\/skill\.test\.ts -->\n\n```python\n([\s\S]*?)```\n/g;

/** Prose only: fenced code blocks removed. */
const prose = (text: string): string => text.replace(/```[\s\S]*?```/g, '');
const spans = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
const allSpans = [...texts.values()].flatMap((t) => spans(prose(t)));

/** The text under `## <title>` in a skill file, up to the next `## `. */
function section(file: string, title: string): string {
  const text = texts.get(file)!;
  const start = text.indexOf(`\n## ${title}\n`);
  expect(start, `${file}: section "${title}"`).toBeGreaterThan(-1);
  const end = text.indexOf('\n## ', start + 4);
  return text.slice(start, end === -1 ? undefined : end);
}

/** The cells of column `col` of every body row of the first table in `text`. */
function column(text: string, col: number): string[] {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.startsWith('|'));
  const after = lines.findIndex((l, k) => k > first && !l.startsWith('|'));
  return lines
    .slice(first, after === -1 ? undefined : after)
    .slice(2)
    .map((r) => (r.split(/(?<!\\)\|/)[col + 1] ?? '').trim());
}

/** The code spans of the paragraph that starts with `**<label>**` in `file`. */
function paragraph(file: string, label: string): string[] {
  const para = new RegExp(`\\*\\*${label}\\*\\*([\\s\\S]*?)\\n\\n`).exec(prose(texts.get(file)!));
  expect(para, `${file}: paragraph ${label}`).not.toBeNull();
  return spans(para![1]!);
}

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

describe('skills/oort-sdk: the Agent Skills format', () => {
  it('follows the specification (agentskills.io/specification)', () => {
    expect(skillProblems(path.join(ROOT, SKILL))).toEqual([]);
  });

  it('every skill a plugin ships follows it too', () => {
    const dirs = ['distribution/claude-code', 'distribution/codex'].flatMap((host) =>
      readdirSync(path.join(ROOT, host)).flatMap((plugin) => {
        const skills = path.join(ROOT, host, plugin, 'skills');
        return existsSync(skills) ? readdirSync(skills).map((s) => path.join(skills, s)) : [];
      }),
    );
    expect(dirs.length).toBeGreaterThanOrEqual(4);
    for (const d of dirs) expect(skillProblems(d), d).toEqual([]);
  });

  it('names the oortmem release it describes', () => {
    const { data } = frontmatter(texts.get('SKILL.md')!) as { data: Record<string, any> };
    expect(data['metadata']['oortmem-version']).toBe(version);
    expect(data['compatibility']).toContain(`oortmem ${version}`);
    expect(texts.get('SKILL.md')).toContain(`\`oortmem\` ${version}`);
  });

  it('links every reference from SKILL.md, one level deep', () => {
    const linked = [...texts.get('SKILL.md')!.matchAll(/\]\((references\/[^)]+)\)/g)].map(
      (m) => m[1]!,
    );
    const refs = files.filter((f) => f.startsWith('references/'));
    expect([...new Set(linked)].sort()).toEqual(refs.sort());
    // A reference links only to its siblings (or the web), never deeper.
    for (const f of refs) {
      for (const [, target] of texts.get(f)!.matchAll(/\]\(([^)]+)\)/g)) {
        if (/^https:\/\//.test(target!)) continue;
        expect(target, f).toMatch(/^[a-z-]+\.md(#[a-z0-9-]+)?$/);
        expect(
          existsSync(path.join(ROOT, SKILL, 'references', target!.split('#')[0]!)),
          target,
        ).toBe(true);
      }
    }
  });

  it('the copies in the plugins are current (`pnpm skills:sync`)', () => {
    expect(syncSkills({ write: false })).toEqual([]);
    expect((SKILLS as { name: string }[]).map((s) => s.name)).toContain('oort-sdk');
  });

  it('the declaration files it points to are the package types', () => {
    const pkg = JSON.parse(read('packages/cli/package.json')) as {
      exports: Record<string, { types?: string } | string>;
    };
    const types = Object.values(pkg.exports).flatMap((t) =>
      typeof t === 'object' && t.types !== undefined ? [t.types.replace(/^\.\//, '')] : [],
    );
    const named = allSpans.flatMap(
      (s) => /^node_modules\/oortmem\/(.+\.d\.ts)$/.exec(s)?.[1] ?? [],
    );
    expect(named.sort()).toEqual(types.sort());
  });
});

describe('skills/oort-sdk: code blocks are tested code', () => {
  const examples = readdirSync(path.join(ROOT, 'examples/src')).filter((f) => f.endsWith('.ts'));

  it('every ts block is marked as an example file and matches it byte for byte', () => {
    for (const [f, text] of texts) {
      const blocks = [...text.matchAll(/```ts\n/g)].length;
      const marked = [...text.matchAll(MARKED)];
      expect(marked.length, `${f}: a \`\`\`ts block without an example marker`).toBe(blocks);
      for (const [, file, code] of marked) {
        expect(code, `${file} differs from ${SKILL}/${f}: run \`pnpm skills:sync\``).toBe(
          read(file!),
        );
      }
    }
  });

  it('shows every tested example', () => {
    const shown = new Set([...all.matchAll(MARKED)].map((m) => path.basename(m[1]!)));
    expect([...shown].sort()).toEqual(examples.sort());
  });

  it('has no other code blocks than ts examples, shell, JSON and the tested Python', () => {
    const langs = [...all.matchAll(/^```(\w*)$/gm)].map((m) => m[1]).filter((l) => l !== '');
    expect([...new Set(langs)].sort()).toEqual(['json', 'python', 'sh', 'ts']);
    const python = [...all.matchAll(/```python\n/g)].length;
    expect([...all.matchAll(TESTED_PYTHON)].length).toBe(python);
  });

  const python = ['python3', 'python'].find(
    (p) => spawnSync(p, ['--version'], { encoding: 'utf8' }).status === 0,
  );
  it.skipIf(python === undefined || process.platform === 'win32')(
    'the Python wrapper runs against the built CLI',
    () => {
      const [, code] = new RegExp(TESTED_PYTHON.source).exec(all) ?? [];
      expect(code).toBeDefined();
      const dir = mkdtempSync(path.join(tmpdir(), 'oort-skill-py-'));
      const bin = path.join(dir, 'bin');
      const home = path.join(dir, 'home');
      mkdirSync(bin);
      mkdirSync(home, { mode: 0o700 });
      const main = path.join(ROOT, 'packages/cli/dist/main.js');
      writeFileSync(
        path.join(bin, 'oort'),
        `#!/bin/sh\nexec "${process.execPath}" "${main}" "$@"\n`,
      );
      chmodSync(path.join(bin, 'oort'), 0o755);
      writeFileSync(
        path.join(dir, 'run.py'),
        `${code}
import json as _json

out = {"recall": recall("-h how do we deploy?")}
try:
    observe("We deploy on Fridays now.", "Noted.")
except OortCliError as e:
    out["observe"] = [e.code, e.fix, e.exit_code]
print(_json.dumps(out))
`,
      );
      // No keys and no Keychain (no-network.ts removed them): recall is lexical-only and makes
      // no network call, and observe fails with needs-key before any adapter runs.
      const r = spawnSync(python!, ['-I', path.join(dir, 'run.py')], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`,
          HOME: dir,
          OORT_HOME: home,
          OORT_NO_KEYCHAIN: '1',
        },
        timeout: 60_000,
      });
      expect(r.stderr).toBe('');
      expect(JSON.parse(r.stdout)).toEqual({
        recall: [],
        observe: ['needs-key', 'oort models pull', 2],
      });
    },
  );
});

describe('skills/oort-sdk: every SDK name exists in the built .d.ts', () => {
  // Names the examples define themselves, and the frameworks' own types they mention.
  const own = new Set(
    readdirSync(path.join(ROOT, 'examples/src')).flatMap((f) =>
      [...read(`examples/src/${f}`).matchAll(/^export (?:class|function|const) (\w+)/gm)].map(
        (m) => m[1]!,
      ),
    ),
  );
  const FRAMEWORK = new Set(['BaseStore', 'MemorySession', 'Session']);
  // Claude Code hook events, which docs/cli.md documents.
  const HOOKS = ['UserPromptSubmit', 'SessionStart', 'Stop'];

  it('every type, class and Type.member it names is exported', () => {
    const named = allSpans.filter((s) => /^[A-Z][a-z][A-Za-z]*(\.[a-z]\w*)?$/.test(s));
    expect(named.length).toBeGreaterThan(20);
    const missing = named.filter((s) => {
      const [type, member] = s.split('.');
      if (own.has(type!) || FRAMEWORK.has(type!)) return false;
      if (HOOKS.includes(type!)) return !cliDoc.includes(`\`${type}\``);
      if (!exported.has(type!)) return true;
      return member !== undefined && !members(type!).includes(member);
    });
    expect(missing).toEqual([]);
  });

  it('every function or method it calls is on Oort, OortJudge, or exported', () => {
    const oort = new Set(members('Oort'));
    const judge = new Set(members('OortJudge'));
    const NOT_OORT = new Set([
      'JSON.stringify',
      'util.inspect',
      'console.log',
      'compile',
      'require',
      'process.cwd',
    ]);
    const calls = allSpans.flatMap((s) => {
      const m = /^(?:(?!judge\.)(\w+)\.)?(judge\.)?(\w+)\(/.exec(s);
      return m === null ? [] : [{ s, receiver: m[1], judged: m[2] !== undefined, name: m[3]! }];
    });
    expect(calls.length).toBeGreaterThan(25);
    const missing = calls.filter((c) => {
      if (NOT_OORT.has(c.receiver === undefined ? c.name : `${c.receiver}.${c.name}`)) return false;
      if (c.judged) return !judge.has(c.name);
      return !oort.has(c.name) && exported.get(c.name)?.kind !== 'function';
    });
    expect(missing.map((c) => c.s)).toEqual([]);
  });

  it('its options table lists exactly the OortOptions keys', () => {
    const options = column(section('references/sdk.md', 'Options'), 0).flatMap(spans);
    expect(options.sort()).toEqual([...members('OortOptions')].sort());
  });

  it('the recall options it lists are exactly the RecallOptions keys', () => {
    const keys = new Set(members('RecallOptions'));
    const named = paragraph('references/sdk.md', '`recall` options\\.').filter((s) => keys.has(s));
    expect([...new Set(named)].sort()).toEqual([...keys].sort());
  });

  it('the methods table names only real methods, and every Oort method', () => {
    const calls = column(section('references/sdk.md', 'Methods'), 0).flatMap(spans);
    const names = calls.map((c) => /^(judge\.)?(\[Symbol\.\w+\]|\w+)/.exec(c)![0]);
    const want = [
      ...members('Oort').filter((m) => !['mode', 'judge'].includes(m)),
      ...members('OortJudge').map((m) => `judge.${m}`),
      'formatForPrompt',
    ];
    expect([...new Set(names)].sort()).toEqual(want.sort());
    const scoped = calls.find((c) => c.startsWith('scoped('))!;
    expect([...scoped.matchAll(/(\w+)\?/g)].map((m) => m[1]).sort()).toEqual(
      [...members('ScopedOptions')].sort(),
    );
  });

  it('the result, Turn and whoami fields it lists are on their types', () => {
    const fields = new Set([
      ...members('MemoryView'),
      ...members('RecalledMemory'),
      ...members('RecallResult'),
    ]);
    const results = paragraph('references/sdk.md', 'Results\\.').filter((s) =>
      /^[a-z][A-Za-z]*$/.test(s),
    );
    expect(results.length).toBeGreaterThan(15);
    expect(results.filter((s) => !fields.has(s))).toEqual([]);
    const turn = paragraph('references/sdk.md', 'A `Turn`').filter((s) =>
      /^[a-z][A-Za-z]*$/.test(s),
    );
    expect(turn.filter((s) => !members('Turn').includes(s) && s !== 'observe')).toEqual([]);
    const who = paragraph('references/sdk.md', '`whoami\\(\\)`');
    const routes = decl('RouteKind').text;
    for (const s of who.filter((w) => /^[a-z][\w-]*$/.test(w))) {
      const ok =
        members('Whoami').includes(s) ||
        routes.includes(`'${s}'`) ||
        ['embed', 'rerank', 'decide', 'write'].includes(s);
      expect(ok, s).toBe(true);
    }
  });

  it('the judge and AI SDK tool options it lists exist', () => {
    const judging = /`JudgeOptions` are ([^.]+)\./.exec(
      prose(texts.get('references/judgments.md')!),
    );
    expect(spans(judging![1]!).sort()).toEqual([...members('JudgeOptions')].sort());
    const tools = /`OortToolsOptions` also take ([^.]+)\./.exec(
      prose(texts.get('references/frameworks.md')!).replace(/\s+/g, ' '),
    );
    const named = spans(tools![1]!).filter((s) => /^[a-z][A-Za-z]*$/.test(s));
    expect(named.length).toBe(2);
    for (const s of [...named, 'judge']) expect(members('OortToolsOptions')).toContain(s);
  });

  it('the error table matches the classes, codes and documented reasons', () => {
    const errors = texts.get('references/errors.md')!;
    const classes = column(errors, 0).flatMap(spans);
    const codes = column(errors, 1).flatMap(spans);
    const reasons = column(errors, 2)
      .flatMap(spans)
      .filter((s) => /^[a-z][a-z-]+$/.test(s));
    const errorClasses = [...exported.values()]
      .filter((s) => s.kind === 'class')
      .map((s) => s.name);
    expect(classes.sort()).toEqual(errorClasses.filter((n) => n !== 'OortError').sort());
    for (const c of codes) expect(decl('OortErrorCode').text, c).toContain(`'${c}'`);
    expect(new Set(codes).size).toBe(classes.length);
    // Reasons are not in the types (they are strings); each must be one docs/sdk.md documents.
    const documented = sdkDoc.slice(
      sdkDoc.indexOf('\n## Errors\n'),
      sdkDoc.indexOf('\n## Which calls'),
    );
    for (const r of reasons) expect(documented, r).toContain(`\`${r}\``);
    for (const f of ['code', 'reason', 'fix', 'retryable', 'retryAfter', 'status']) {
      expect(members('OortError'), f).toContain(f);
      expect(errors).toContain(`- \`${f}\``);
    }
  });

  it('every environment variable it names is documented', () => {
    const vars = new Set(allSpans.flatMap((s) => s.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g) ?? []));
    expect(vars.size).toBeGreaterThan(5);
    for (const v of vars) expect(cliDoc.includes(v) || sdkDoc.includes(v), v).toBe(true);
  });
});

describe('skills/oort-sdk: every oort command and flag exists in docs/cli.md', () => {
  /** Every `oort …` command line in the skill: code spans, shell blocks and the Python calls. */
  const commands = [
    // `oort …` in prose is a placeholder, not a command.
    ...allSpans.filter((s) => s.startsWith('oort ') && !s.includes('…')),
    ...[...all.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) =>
      m[1]!
        .split('\n')
        .map((l) => l.replace(/\s+#.*$/, '').trim())
        .filter((l) => l.startsWith('oort ')),
    ),
    ...[...all.matchAll(/\boort\(\[([^\]]*)\]/g)].map(
      (m) => `oort ${[...m[1]!.matchAll(/"([^"]*)"/g)].map((q) => q[1]).join(' ')}`,
    ),
  ];
  const tokens = (line: string): string[] => line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const inCli = (s: string): boolean =>
    new RegExp(`${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z-])`).test(cliDoc);

  it('finds the commands', () => {
    expect(commands.length).toBeGreaterThan(30);
  });

  it('every command path is a documented command', () => {
    for (const c of commands) {
      const words: string[] = [];
      for (const t of tokens(c).slice(1)) {
        if (!/^[a-z][a-z-]*$/.test(t)) break;
        words.push(t);
      }
      expect(words.length, c).toBeGreaterThan(0);
      expect(inCli(`oort ${words.join(' ')}`), `\`${c}\`: "oort ${words.join(' ')}"`).toBe(true);
    }
  });

  it('every flag is a documented flag', () => {
    const flags = new Set([
      ...commands.flatMap((c) => tokens(c).filter((t) => /^--[a-z]/.test(t))),
      ...allSpans.filter((s) => /^--[a-z][a-z-]*$/.test(s)),
    ]);
    expect(flags.size).toBeGreaterThan(8);
    for (const f of flags) expect(inCli(f), f).toBe(true);
  });
});
