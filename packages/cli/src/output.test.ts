import { describe, expect, it } from 'vitest';
import { harness, memory, data } from '../test/helpers.js';
import { TG } from '@oortmem/core/store-conformance';

const ESC = '\u001b[';

describe('consistent output', () => {
  it('output.one-header-line-for-humans-none-for-json', async () => {
    const h = harness();
    const m = memory({ tier: 'hot' });
    await h.store.upsert(TG, m);
    const human: string[][] = [
      ['stats'],
      ['inspect'],
      ['inspect', m.id],
      ['explain', 'auth service port'],
      ['recall', 'auth service port'],
      ['keys', 'list'],
      ['consolidate'],
    ];
    for (const args of human) {
      const r = await h.run(args);
      expect(r.code, args.join(' ')).toBe(0);
      const lines = r.io.stdout.split('\n');
      expect(lines[0], args.join(' ')).toMatch(new RegExp(`^oort ${args[0]}`));
      // Exactly one header line.
      // A header is `oort <command>`; `keys list`'s padded `oort       …` row is a key, not a header.
      expect(lines.filter((l) => /^oort \S/.test(l)).length, args.join(' ')).toBe(1);
      expect(r.io.stdout, args.join(' ')).not.toContain(ESC);
    }
    for (const args of [
      ['stats', '--json'],
      ['inspect', '--json'],
      ['inspect', m.id, '--json'],
      ['explain', 'auth service port', '--json'],
      ['recall', 'auth service port', '--json'],
      ['keys', 'list', '--json'],
    ]) {
      const r = await h.run(args);
      expect(r.code, args.join(' ')).toBe(0);
      expect(() => data(r.io.stdout), args.join(' ')).not.toThrow();
    }
  });

  it('output.explain-json-has-ranks-and-timings', async () => {
    const h = harness();
    const m = memory();
    await h.store.upsert(TG, m);
    const r = await h.run(['explain', 'auth service port', '--json']);
    const out = data(r.io.stdout) as {
      memories: { rank: number; id: string; tier: string; explanation: { lexicalRank?: number } }[];
      timings: Record<string, number>;
    };
    expect(out.memories[0]).toMatchObject({ rank: 1, id: m.id, tier: 'warm' });
    expect(out.memories[0]?.explanation.lexicalRank).toBe(1);
    expect(typeof out.timings['totalMs']).toBe('number');
    expect(r.io.stdout).not.toContain('"embedding"');
  });

  it('output.tiers-coloured-on-a-terminal-unless-no-color', async () => {
    const h = harness();
    await h.store.upsertMany(TG, [memory({ tier: 'hot' }), memory({ tier: 'cold' })]);
    const tty = await h.run(['inspect'], { stdoutTTY: true });
    expect(tty.io.stdout).toContain(ESC);
    expect(tty.io.stdout).toContain('● hot');
    const plain = await h.run(['inspect'], {
      stdoutTTY: true,
      env: { HOME: h.root, OORT_HOME: h.home, NO_COLOR: '1' },
    });
    expect(plain.io.stdout).not.toContain(ESC);
    expect(plain.io.stdout).toContain('● hot');
    expect(plain.io.stdout).toContain('○ cold');
    // --json never carries colour, even on a terminal.
    const json = await h.run(['stats', '--json'], { stdoutTTY: true });
    expect(json.io.stdout).not.toContain(ESC);
  });

  const BRAILLE = /[\u2800-\u28ff]/;
  /** A truecolor terminal, as far as the CLI can tell. */
  const colourTty = (h: { root: string; home: string }, extra: Record<string, string> = {}) => ({
    stdoutTTY: true,
    env: { HOME: h.root, OORT_HOME: h.home, COLORTERM: 'truecolor', FORCE_COLOR: '3', ...extra },
  });

  it('output.help-banner-only-with-colour-on-a-terminal', async () => {
    const h = harness();
    const plain = await h.run(['--help']);
    expect(plain.code).toBe(0);
    expect(plain.io.stdout).not.toContain(ESC);
    expect(plain.io.stdout).not.toMatch(BRAILLE);
    expect(plain.io.stdout.startsWith('Usage: oort [options] [command]\n')).toBe(true);
    expect(plain.io.stdout).toContain('Oort: tiered memory for coding agents.');
    // Plain `oort` is the help on stdout, exit 0.
    const bare = await h.run([]);
    expect(bare.code).toBe(0);
    expect(bare.io.stdout).toBe(plain.io.stdout);
    expect(bare.io.stderr).toBe('');
    // FORCE_COLOR into a pipe: coloured help, no art.
    const forced = await h.run(['--help'], { env: { HOME: h.root, FORCE_COLOR: '3' } });
    expect(forced.io.stdout).toContain(ESC);
    expect(forced.io.stdout).not.toMatch(BRAILLE);
    const tty = await h.run(['--help'], colourTty(h));
    expect(tty.io.stdout).toMatch(BRAILLE);
    expect(tty.io.stdout).toContain('Kuiper Belt');
    const noColor = await h.run(['--help'], colourTty(h, { NO_COLOR: '1' }));
    expect(noColor.io.stdout).toBe(plain.io.stdout);
    // Subcommand help never carries the mark.
    const sub = await h.run(['stats', '--help'], colourTty(h));
    expect(sub.io.stdout).not.toMatch(BRAILLE);
  });

  it('output.setup-mark-only-with-colour-on-a-terminal', async () => {
    const args = ['setup', '--yes', '--agents', 'none', '--keys', 'skip', '--no-demo'];
    const h = harness();
    const plain = await h.run(args);
    expect(plain.code, plain.io.stderr).toBe(0);
    expect(plain.io.stdout).not.toMatch(BRAILLE);
    expect(plain.io.stdout.split('\n')[0]).toBe('oort setup · non-interactive (--yes)');
    const tty = await h.run(args, colourTty(h));
    expect(tty.code, tty.io.stderr).toBe(0);
    expect(tty.io.stdout).toMatch(BRAILLE);
    const noColor = await h.run(args, colourTty(h, { NO_COLOR: '1' }));
    expect(noColor.io.stdout).not.toMatch(BRAILLE);
    expect(noColor.io.stdout).not.toContain(ESC);
  });

  it('output.data-output-is-plain-on-a-colour-terminal', async () => {
    const h = harness();
    await h.store.upsert(TG, memory({ tier: 'hot' }));
    const tty = colourTty(h);
    for (const args of [
      ['stats', '--json'],
      ['inspect', '--json'],
      ['recall', 'auth service port', '--json'],
      ['explain', 'auth service port', '--json'],
      ['keys', 'list', '--json'],
      ['doctor', '--json'],
      ['export'],
    ]) {
      const coloured = await h.run(args, tty);
      const plain = await h.run(args);
      expect(coloured.io.stdout, args.join(' ')).not.toContain(ESC);
      expect(coloured.io.stdout, args.join(' ')).not.toMatch(BRAILLE);
      const docs =
        args[0] === 'export' ? coloured.io.stdout.trimEnd().split('\n') : [coloured.io.stdout];
      for (const d of docs) expect(() => JSON.parse(d), args.join(' ')).not.toThrow();
      // Read-only commands answer the same bytes (recall and explain record the access).
      if (['stats', 'inspect', 'keys'].includes(args[0] ?? '')) {
        const strip = (o: string): string =>
          o.replace(/"[a-zA-Z]*Ms": [0-9.]+/g, '').replace(/"rssBytes": \d+/, '');
        expect(strip(coloured.io.stdout), args.join(' ')).toBe(strip(plain.io.stdout));
      }
    }
    // The recall block agents read is the same bytes; only the header line above it is styled.
    const human = await h.run(['recall', 'auth service port'], tty);
    const plainHuman = await h.run(['recall', 'auth service port']);
    const block = (o: string): string => o.slice(o.indexOf('<oort-memory'));
    expect(human.io.stdout.split('\n')[0]).toContain(ESC);
    expect(block(human.io.stdout)).toBe(block(plainHuman.io.stdout));
    expect(block(human.io.stdout)).not.toContain(ESC);
    expect(block(human.io.stdout)).toContain('<oort-memory');
    // Hook stdout is JSON for Claude Code, whatever the terminal.
    const stdin = JSON.stringify({
      session_id: 's-1',
      cwd: h.cwd,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'which port does the auth service use?',
    });
    const hook = await h.run(['hook', 'UserPromptSubmit'], { ...tty, stdin });
    expect(hook.io.hookStdout).toBeDefined();
    expect(hook.io.hookStdout).not.toContain(ESC);
    expect(hook.io.stdout).toBe('');
    expect(() => JSON.parse(hook.io.hookStdout ?? '')).not.toThrow();
  });
});
