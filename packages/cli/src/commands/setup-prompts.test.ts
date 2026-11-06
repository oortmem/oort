import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeIo, harness, tmpdir } from '../../test/helpers.js';
import { uiFor } from '../ui.js';
import { clackPrompter } from './setup.js';

/**
 * CON-107's rule for every prompt: the question goes to stderr, never stdout, so a pipe on stdout
 * never receives it. `oort setup`'s interactive wizard asks through clack, which writes to stdout
 * unless told otherwise.
 */

const ESC = String.fromCharCode(27);
const plain = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), '');

describe('oort setup: questions on stderr', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('confirm, select and multiselect write to stderr and nothing to stdout', async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      err.push(String(c));
      return true;
    });
    const ui = uiFor(fakeIo({ cwd: tmpdir() }));
    const answer = async <T>(ask: (input: PassThrough) => Promise<T>): Promise<T> => {
      const input = new PassThrough();
      const p = ask(input);
      // Enter takes the default once the prompt is listening.
      await new Promise((r) => setTimeout(r, 20));
      input.write('\r');
      return p;
    };
    expect(
      await answer((input) => clackPrompter(ui, { input }).confirm('Write these changes?', true)),
    ).toBe(true);
    expect(
      await answer((input) =>
        clackPrompter(ui, { input }).select(
          'Which keys?',
          [
            { value: 'byo', label: 'my own keys' },
            { value: 'skip', label: 'skip' },
          ],
          'skip',
        ),
      ),
    ).toBe('skip');
    expect(
      await answer((input) =>
        clackPrompter(ui, { input }).multiselect(
          'Which agents?',
          [{ value: 'cursor', label: 'Cursor' }],
          ['cursor'],
        ),
      ),
    ).toEqual(['cursor']);
    vi.restoreAllMocks();
    const said = plain(err.join(''));
    expect(said).toContain('Write these changes?');
    expect(said).toContain('Which keys?');
    expect(said).toContain('Which agents?');
    expect(plain(out.join(''))).not.toMatch(/Write these changes\?|Which keys\?|Which agents\?/);
  });

  it('the intro, steps, notes and outro are on stderr too: stdout gets nothing from the wizard', async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      err.push(String(c));
      return true;
    });
    const p = clackPrompter(uiFor(fakeIo({ cwd: tmpdir() })));
    p.intro('oort setup intro');
    p.step(1, 'Detect agents step');
    p.info('a note line');
    p.outro('the outro line');
    vi.restoreAllMocks();
    const said = plain(err.join(''));
    for (const line of [
      'oort setup intro',
      'Detect agents step',
      'a note line',
      'the outro line',
    ]) {
      expect(said).toContain(line);
    }
    expect(out.join('')).toBe('');
  });

  it('on a terminal with stderr redirected (2> file): a clear refusal, never a silent wait', async () => {
    const h = harness();
    const r = await h.run(['setup'], { tty: true, stdoutTTY: true, stderrTTY: false });
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('stderr is not a terminal');
    expect(r.io.stderr).toContain('--yes');
    expect(r.io.stdout).toBe('');
    // With --yes it runs without asking, as everywhere else.
    const yes = await h.run(['setup', '--yes', '--agents', 'none', '--keys', 'skip', '--no-demo'], {
      tty: true,
      stdoutTTY: true,
      stderrTTY: false,
    });
    expect(yes.code, yes.io.stderr).toBe(0);
  });
});
