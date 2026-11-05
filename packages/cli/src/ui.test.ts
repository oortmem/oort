import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  MARK_WIDTH,
  PALETTE,
  ansi256,
  colorEnabled,
  colorLevel,
  createUi,
  themeOf,
  uiFor,
  visibleLength,
} from './ui.js';
import { fakeIo, tmpdir } from '../test/helpers.js';

const ESC = '\u001b[';

describe('ui', () => {
  it('ui.color-follows-no-color-force-color-and-tty', () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
    // https://no-color.org: present and non-empty disables, whatever else is set.
    expect(colorEnabled({ NO_COLOR: '1' }, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: '' }, true)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: '1' }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: '0' }, true)).toBe(false);
    expect(colorEnabled({ TERM: 'dumb' }, true)).toBe(false);
  });

  it('ui.plain-output-has-no-escape-codes', () => {
    const ui = createUi(false);
    const text =
      ui.header('stats', 'project main-1a2b3c4d') +
      ui.kv([
        ['scope', 'global'],
        ['tiers', `${ui.tierName('hot')} 1`],
      ]) +
      ui.tier('cold');
    expect(text).not.toContain(ESC);
    expect(ui.header('stats', 'project p')).toBe('oort stats · project p\n');
    expect(ui.tier('hot')).toBe('● hot');
    expect(ui.tier('warm')).toBe('◐ warm');
    expect(ui.tier('cold')).toBe('○ cold');
  });

  it('ui.kv-aligns-keys', () => {
    const ui = createUi(false);
    expect(
      ui.kv([
        ['scope', 'global'],
        ['queue', '0 pending'],
        ['sqlite', '1 MB'],
      ]),
    ).toBe('scope   global\nqueue   0 pending\nsqlite  1 MB\n');
    expect(ui.kv([['a', 'b']], { indent: 2 })).toBe('  a  b\n');
  });

  it('ui.colored-tiers-and-table-pads-by-visible-width', () => {
    const ui = createUi(true);
    const hot = ui.tier('hot');
    expect(hot).toContain(ESC);
    expect(visibleLength(hot)).toBe('● hot'.length);
    expect(ui.tierName('warm')).not.toBe(ui.tierName('cold'));
    const t = ui.table(
      ['id', 'tier', 'text'],
      [
        ['a', ui.tier('hot'), 'x'],
        ['b', ui.tier('cold'), 'y'],
      ],
    );
    const lines = t.trimEnd().split('\n').map(visibleLength);
    // Every row's last column starts at the same visible offset.
    const plain = stripVTControlCharacters(t).split('\n');
    expect(plain[1]?.indexOf('x')).toBe(plain[2]?.indexOf('y'));
    expect(lines.length).toBe(3);
  });

  it('ui.ui-for-io-uses-env-and-stdout-tty', () => {
    const cwd = tmpdir();
    expect(uiFor(fakeIo({ cwd })).color).toBe(false);
    expect(uiFor({ ...fakeIo({ cwd }), stdoutIsTTY: true }).color).toBe(true);
    expect(uiFor({ ...fakeIo({ cwd, env: { NO_COLOR: '1' } }), stdoutIsTTY: true }).color).toBe(
      false,
    );
  });

  it('ui.color-level-truecolor-256-16-and-off', () => {
    const tty = true;
    expect(colorLevel({ COLORTERM: 'truecolor' }, tty)).toBe(3);
    expect(colorLevel({ COLORTERM: '24bit' }, tty)).toBe(3);
    expect(colorLevel({ TERM: 'xterm-256color' }, tty)).toBe(2);
    expect(colorLevel({ TERM: 'xterm' }, tty)).toBe(1);
    expect(colorLevel({}, tty)).toBe(1);
    expect(colorLevel({ COLORTERM: 'truecolor' }, false)).toBe(0);
    expect(colorLevel({ FORCE_COLOR: '3' }, false)).toBe(3);
    expect(colorLevel({ FORCE_COLOR: '2' }, false)).toBe(2);
    expect(colorLevel({ FORCE_COLOR: '1', COLORTERM: 'truecolor' }, false)).toBe(3);
    // NO_COLOR wins over everything, truecolor and FORCE_COLOR included.
    expect(colorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor', FORCE_COLOR: '3' }, tty)).toBe(0);
    expect(colorLevel({ TERM: 'dumb', COLORTERM: 'truecolor' }, tty)).toBe(0);
  });

  it('ui.palette-truecolor-256-16-and-plain', () => {
    const photon = PALETTE.photon.dark;
    expect(photon).toBe('#0095ff');
    expect(createUi(3).accent('x')).toBe(`${ESC}38;2;0;149;255mx${ESC}39m`);
    expect(createUi(2).accent('x')).toBe(`${ESC}38;5;33mx${ESC}39m`);
    expect(createUi(1).accent('x')).toBe(`${ESC}34mx${ESC}39m`);
    expect(createUi(0).accent('x')).toBe('x');
    // A light background (COLORFGBG) gets the darker twins.
    expect(createUi(3, { theme: 'light' }).accent('x')).toContain('38;2;0;113;224m');
    expect(themeOf({ COLORFGBG: '0;15' })).toBe('light');
    expect(themeOf({ COLORFGBG: '15;0' })).toBe('dark');
    expect(themeOf({})).toBe('dark');
    for (const level of [0, 1, 2, 3] as const) {
      const ui = createUi(level);
      for (const f of [
        ui.accent,
        ui.glow,
        ui.comet,
        ui.violet,
        ui.muted,
        ui.success,
        ui.warning,
        ui.error,
      ]) {
        expect(stripVTControlCharacters(f('text'))).toBe('text');
        expect(f('text').includes(ESC)).toBe(level > 0);
      }
    }
    expect(ansi256([0, 149, 255])).toBe(33);
    expect(ansi256([128, 128, 128])).toBe(244);
  });

  it('ui.nested-colour-returns-to-the-outer-colour', () => {
    const ui = createUi(3);
    const s = ui.muted(`a ${ui.warning('b')} c`);
    const muted = `${ESC}38;2;142;153;171m`;
    // After the inner colour closes, the outer one is opened again before " c".
    expect(s).toContain(`${ESC}39m${muted} c`);
  });

  it('ui.gradient-per-character-and-one-colour-on-16', () => {
    const tc = createUi(3).gradient('oort');
    expect(stripVTControlCharacters(tc)).toBe('oort');
    // Truecolor: ember first, violet last, one colour per character.
    expect(tc.startsWith(`${ESC}38;2;248;161;63mo`)).toBe(true);
    expect(tc).toContain(`${ESC}38;2;164;107;245mt`);
    expect(tc.match(/38;2;/g)?.length).toBe(4);
    expect(createUi(2).gradient('oort').match(/38;5;/g)?.length).toBe(4);
    // 16 colours: a single colour for the whole word.
    expect(createUi(1).gradient('oort')).toBe(`${ESC}34moort${ESC}39m`);
    expect(createUi(0).gradient('oort')).toBe('oort');
    expect(createUi(0).wordmark()).toBe('oort');
    expect(stripVTControlCharacters(createUi(3).wordmark())).toBe('◉ oort');
  });

  it('ui.mark-only-with-colour-on-a-terminal', () => {
    const side = ['', 'oort', 'tiered memory'];
    expect(createUi(0, { tty: true }).mark(side)).toBe('');
    expect(createUi(3, { tty: false }).mark(side)).toBe('');
    expect(createUi(3).mark(side)).toBe('');
    for (const level of [1, 2, 3] as const) {
      const art = createUi(level, { tty: true }).mark(side);
      const lines = stripVTControlCharacters(art).trimEnd().split('\n');
      expect(lines.length).toBeLessThanOrEqual(7);
      expect(MARK_WIDTH).toBeLessThanOrEqual(30);
      for (const l of lines) expect([...l.split('    ')[0]!].length).toBeLessThanOrEqual(30);
      expect(art).toMatch(/[\u2800-\u28ff]/);
      expect(art).toContain('●');
      // Side lines are centred on the mark: three lines start on row 2.
      expect(lines[3]).toContain('oort');
    }
    // Through uiFor: FORCE_COLOR without a terminal colours output but never draws the mark.
    const cwd = tmpdir();
    expect(uiFor(fakeIo({ cwd, env: { FORCE_COLOR: '3' } })).mark(side)).toBe('');
    expect(
      uiFor({ ...fakeIo({ cwd, env: { NO_COLOR: '1' } }), stdoutIsTTY: true }).mark(side),
    ).toBe('');
    expect(
      uiFor({ ...fakeIo({ cwd, env: { COLORTERM: 'truecolor' } }), stdoutIsTTY: true }).mark(side),
    ).not.toBe('');
  });

  it('ui.status-symbols-and-bar', () => {
    const plain = createUi(0);
    expect(plain.ok('a')).toBe('✓ a');
    expect(plain.warn('a')).toBe('! a');
    expect(plain.fail('a')).toBe('✗ a');
    expect(plain.info('a')).toBe('• a');
    expect(plain.bar(1, 2)).toBe('');
    const ui = createUi(3);
    expect(ui.ok('a')).toContain('38;2;97;203;124m✓');
    expect(ui.fail('a')).toContain('38;2;247;93;89m✗');
    expect(stripVTControlCharacters(ui.bar(1, 2, 10))).toBe('━━━━━─────');
    expect(stripVTControlCharacters(ui.bar(5, 0, 4))).toBe('━━━━');
    // Keys are muted in colour; alignment still follows the visible width.
    const kv = ui.kv([
      ['scope', 'global'],
      ['sqlite', '1 MB'],
    ]);
    expect(stripVTControlCharacters(kv)).toBe('scope   global\nsqlite  1 MB\n');
    expect(kv).toContain('38;2;142;153;171mscope');
  });
});
