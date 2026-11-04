import { describe, expect, it } from 'vitest';
import { harness, memory } from '../test/helpers.js';
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
      expect(() => JSON.parse(r.io.stdout), args.join(' ')).not.toThrow();
    }
  });

  it('output.explain-json-has-ranks-and-timings', async () => {
    const h = harness();
    const m = memory();
    await h.store.upsert(TG, m);
    const r = await h.run(['explain', 'auth service port', '--json']);
    const out = JSON.parse(r.io.stdout) as {
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
});
