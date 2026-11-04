import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { colorEnabled, createUi, uiFor, visibleLength } from './ui.js';
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
});
