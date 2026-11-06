import { describe, expect, it } from 'vitest';
import { data, harness } from '../test/helpers.js';
import { createKeychain } from './keychain.js';
import { commandPath } from './output.js';
import { program } from './program.js';
import type { Ctx } from './util.js';

/**
 * CON-107 step 3: `oort --help` groups the commands by purpose, gives a short example for the
 * common ones and links to the docs; `oort <cmd> --help` stays as it was. Step 4: the aliases
 * that resolve the naming overlaps, with the old names still working.
 */

const GROUPS = ['Start:', 'Memory:', 'Agents:', 'Cloud and sharing:', 'Maintenance:'] as const;

/** Each group's lines of the top-level help: from its heading to the next blank line. */
function groups(help: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = help.split('\n');
  for (const g of GROUPS) {
    const at = lines.indexOf(g);
    expect(at, `group ${g}`).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > at && l === '');
    out.set(g, lines.slice(at + 1, end === -1 ? undefined : end));
  }
  return out;
}

/** The command names a group lists (`  recall [options] <text>  …` is `recall`). */
const names = (rows: string[]): string[] =>
  rows.filter((r) => /^ {2}\S/.test(r)).map((r) => r.trim().split(/[\s|]/)[0]!);

describe('oort --help: grouped, with examples (CON-107 step 3)', () => {
  it('groups every command by purpose, in order, with no flat "Commands:" list', async () => {
    const h = harness();
    const r = await h.run(['--help']);
    expect(r.code).toBe(0);
    const help = r.io.stdout;
    expect(help).not.toMatch(/^Commands:$/m);
    const at = GROUPS.map((g) => help.indexOf(`\n${g}\n`));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const g = groups(help);
    expect(names(g.get('Start:')!)).toEqual(['setup', 'init', 'whoami']);
    expect(names(g.get('Memory:')!)).toEqual(
      expect.arrayContaining(['recall', 'remember', 'observe', 'inspect', 'forget', 'judge']),
    );
    expect(names(g.get('Agents:')!)).toEqual(
      expect.arrayContaining(['connect', 'install', 'mcp', 'hook', 'serve']),
    );
    expect(names(g.get('Cloud and sharing:')!)).toEqual(
      expect.arrayContaining(['login', 'cloud', 'share', 'constellation', 'galaxy']),
    );
    expect(names(g.get('Maintenance:')!)).toEqual(
      expect.arrayContaining(['doctor', 'update', 'models', 'keys', 'reembed']),
    );
  });

  it('lists every top-level command in exactly one group', async () => {
    const h = harness();
    const help = (await h.run(['--help'])).io.stdout;
    const listed = [...groups(help).values()].flatMap(names);
    const ctx: Ctx = {
      io: (await h.run([])).io,
      wire: h.wire,
      keychain: createKeychain({ platform: 'none' }),
    };
    const all = program(ctx, () => {}).commands.map((c) => c.name());
    expect([...listed].sort()).toEqual([...all, 'help'].sort());
  });

  it('ends with short examples for the common commands and a link to the docs', async () => {
    const h = harness();
    const help = (await h.run(['--help'])).io.stdout;
    const tail = help.slice(help.indexOf('\nExamples:\n'));
    expect(help.indexOf('\nExamples:\n')).toBeGreaterThan(help.indexOf('\nMaintenance:\n'));
    for (const cmd of [
      'oort setup',
      'oort remember "',
      'oort recall "',
      'oort inspect',
      'oort forget ',
      'oort doctor',
    ]) {
      expect(tail, cmd).toContain(`  ${cmd}`);
    }
    expect(tail).toContain('https://oortcloud.dev/docs');
    expect(tail).toContain('docs/cli.md');
    expect(tail).toContain('oort <command> --help');
  });

  it("a command's own help stays as it was: no groups, no examples", async () => {
    const h = harness();
    for (const args of [
      ['recall', '--help'],
      ['help', 'recall'],
      ['cloud', '--help'],
    ]) {
      const out = (await h.run(args)).io.stdout;
      expect(out, args.join(' ')).not.toContain('Examples:');
      expect(out, args.join(' ')).not.toContain('Cloud and sharing:');
    }
    const recall = (await h.run(['recall', '--help'])).io.stdout;
    expect(recall.startsWith('Usage: oort recall [options] <text>\n')).toBe(true);
    // A command group's subcommands keep commander's plain heading.
    expect((await h.run(['cloud', '--help'])).io.stdout).toMatch(/^Commands:$/m);
  });
});

describe('naming aliases (CON-107 step 4)', () => {
  it('cloud upload and cloud download are cloud import and cloud export', async () => {
    const h = harness();
    const help = (await h.run(['cloud', '--help'])).io.stdout;
    expect(help).toMatch(/^ {2}import\|upload /m);
    expect(help).toMatch(/^ {2}export\|download /m);
    const up = (await h.run(['cloud', 'upload', '--help'])).io.stdout;
    expect(up).toContain('Usage: oort cloud import|upload [options]');
  });

  it('keys remove and models remove are keys rm and models rm; the envelope keeps the old name', async () => {
    const h = harness();
    const root = program(
      { io: (await h.run([])).io, wire: h.wire, keychain: createKeychain({ platform: 'none' }) },
      () => {},
    );
    const sub = (path: string): string[] => {
      const [g, c] = path.split(' ');
      const cmd = root.commands.find((x) => x.name() === g)!.commands.find((x) => x.name() === c)!;
      expect(commandPath(cmd)).toBe(path);
      return cmd.aliases();
    };
    expect(sub('keys rm')).toContain('remove');
    expect(sub('models rm')).toContain('remove');
    expect(sub('cloud import')).toContain('upload');
    expect(sub('cloud export')).toContain('download');
    // The old names still run, and an alias reports the canonical command in its envelope.
    const old = await h.run(['models', 'rm', '--json']);
    expect(old.code, old.io.stderr).toBe(0);
    data(old.io.stdout, 'models rm');
    const alias = await h.run(['models', 'remove', '--json']);
    expect(alias.code, alias.io.stderr).toBe(0);
    data(alias.io.stdout, 'models rm');
  });
});
