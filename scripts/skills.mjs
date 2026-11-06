#!/usr/bin/env node
// The Agent Skills this repo publishes for developers building with Oort. Each lives once under
// skills/<name>/ (standalone: copy the folder into any agent that reads SKILL.md) and is copied
// into the plugins that ship it. A ```ts block after `<!-- example: examples/src/<file>.ts -->`
// in any of its Markdown files is that tested example, byte for byte.
//
//   pnpm skills:sync           fill example blocks, then copy each skill into its plugins
//   pnpm skills:sync --check   fail when a block or a copy is out of date (pnpm verify)
//
// examples/test/skill.test.ts and packages/mcp/src/distribution.test.ts test the rest.
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncExamples } from './sdk-examples.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Each skill and the plugin directories that carry a copy of it. */
export const SKILLS = [
  {
    name: 'oort-sdk',
    copies: ['distribution/claude-code/oort-dev', 'distribution/codex/oort-dev'],
  },
];

/** Every file under `dir`, as paths relative to it, sorted. */
export function filesUnder(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk('');
  return out.sort();
}

/**
 * The YAML frontmatter of a SKILL.md, for the small subset the Agent Skills fields need: `key:
 * value` lines and one level of `key:` with indented `child: value` lines. Anything else throws,
 * so a file this accepts is plain YAML every host parses the same way.
 */
export function frontmatter(text) {
  if (!text.startsWith('---\n')) throw new Error('SKILL.md must start with a --- line');
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) throw new Error('SKILL.md frontmatter has no closing --- line');
  const scalar = (raw, where) => {
    const v = raw.trim();
    const quoted = /^'((?:[^']|'')*)'$/.exec(v) ?? /^"([^"\\]*)"$/.exec(v);
    if (quoted) return quoted[1].replace(/''/g, "'");
    if (v === '' || /^[&*!|>%@`'"[\]{},#?-]/.test(v) || /: |\s#/.test(v) || v.endsWith(':')) {
      throw new Error(`${where}: quote this value, or it is not a plain YAML string`);
    }
    return v;
  };
  const data = {};
  let parent = null;
  for (const line of text.slice(4, end).split('\n')) {
    if (line.trim() === '') continue;
    const child = /^ {2}([A-Za-z0-9_.-]+):(?: (.*))?$/.exec(line);
    if (child && parent !== null) {
      if (child[2] === undefined) throw new Error(`${child[1]}: nesting deeper than one level`);
      data[parent][child[1]] = scalar(child[2], `${parent}.${child[1]}`);
      continue;
    }
    const top = /^([A-Za-z0-9_-]+):(?: (.*))?$/.exec(line);
    if (!top) throw new Error(`unreadable frontmatter line: ${line}`);
    if (top[1] in data) throw new Error(`${top[1]} appears twice`);
    if (top[2] === undefined || top[2].trim() === '') {
      data[top[1]] = {};
      parent = top[1];
    } else {
      data[top[1]] = scalar(top[2], top[1]);
      parent = null;
    }
  }
  return { data, body: text.slice(end + 5) };
}

/** The fields the Agent Skills specification allows (agentskills.io/specification). */
export const SPEC_FIELDS = [
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
];

/**
 * Problems with a skill directory against the Agent Skills specification: required fields and
 * their limits, a name that matches the directory, only the spec's fields (so claude.ai and the
 * Skills API accept it too), and a SKILL.md under 500 lines.
 */
export function skillProblems(dir) {
  const problems = [];
  const file = path.join(dir, 'SKILL.md');
  if (!existsSync(file)) return [`${file} is missing`];
  const text = readFileSync(file, 'utf8');
  let fm;
  try {
    fm = frontmatter(text);
  } catch (e) {
    return [`${file}: ${e.message}`];
  }
  const { data } = fm;
  const name = data.name;
  if (
    typeof name !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9]|-(?!-))*$/.test(name) ||
    name.endsWith('-') ||
    name.length > 64
  ) {
    problems.push(`name "${name}" is not 1-64 lowercase letters, digits and single hyphens`);
  } else if (name !== path.basename(dir)) {
    problems.push(`name "${name}" does not match its directory ${path.basename(dir)}`);
  }
  const description = data.description;
  if (typeof description !== 'string' || description.length < 1 || description.length > 1024) {
    problems.push(`description must be 1-1024 characters (is ${description?.length})`);
  }
  if (data.compatibility !== undefined) {
    if (typeof data.compatibility !== 'string' || data.compatibility.length > 500) {
      problems.push('compatibility must be a string of at most 500 characters');
    }
  }
  if (data.metadata !== undefined) {
    if (typeof data.metadata !== 'object') problems.push('metadata must be a map');
  }
  for (const k of Object.keys(data)) {
    if (!SPEC_FIELDS.includes(k)) problems.push(`${k} is not an Agent Skills field`);
  }
  const lines = text.split('\n').length;
  if (lines >= 500) problems.push(`SKILL.md has ${lines} lines; keep it under 500`);
  return problems;
}

/** What `pnpm skills:sync` would change: files whose content differs, as relative paths. */
export function syncSkills({ write }) {
  const stale = [];
  for (const skill of SKILLS) {
    const src = path.join(ROOT, 'skills', skill.name);
    for (const rel of filesUnder(src).filter((f) => f.endsWith('.md'))) {
      const file = path.join(src, rel);
      const before = readFileSync(file, 'utf8');
      const after = syncExamples(before);
      if (after !== before) {
        stale.push(path.relative(ROOT, file));
        if (write) writeFileSync(file, after);
      }
    }
    const want = filesUnder(src);
    for (const copy of skill.copies) {
      const dest = path.join(ROOT, copy, 'skills', skill.name);
      const have = existsSync(dest) && statSync(dest).isDirectory() ? filesUnder(dest) : [];
      const differs =
        have.join('\n') !== want.join('\n') ||
        want.some((f) => !readFileSync(path.join(src, f)).equals(readFileSync(path.join(dest, f))));
      if (differs) {
        stale.push(path.relative(ROOT, dest));
        if (write) {
          rmSync(dest, { recursive: true, force: true });
          cpSync(src, dest, { recursive: true });
        }
      }
    }
  }
  return stale;
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const stale = syncSkills({ write: !check });
  if (check && stale.length > 0) {
    console.error(`skills: out of date (run \`pnpm skills:sync\`):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  for (const skill of SKILLS) {
    const problems = skillProblems(path.join(ROOT, 'skills', skill.name));
    if (problems.length > 0) {
      console.error(`skills/${skill.name}:\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
  }
  console.log(stale.length === 0 ? 'skills: in sync' : `skills: updated\n  ${stale.join('\n  ')}`);
}
