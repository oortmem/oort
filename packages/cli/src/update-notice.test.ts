/**
 * Where the update notice appears (CON-114): one dim stderr line after an interactive command, a
 * line in `oort serve status`, and never in `--json`, `OORT_OUTPUT=json`, a pipe, the hook's
 * stdout to the model, `oort mcp`, or CI. The cache is written by hand; nothing is fetched.
 */
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERSION } from '@oortmem/core';
import { harness, type Harness } from '../test/helpers.js';
import { writeUpdateCache } from './update-check.js';

const LINE = `Oort 99.0.0 is available (you have ${VERSION}): oort update`;
const TERMINAL = { stdoutTTY: true, stderrTTY: true, tty: true };

function withUpdate(fresh = true): Harness {
  const h = harness();
  fs.mkdirSync(h.home, { recursive: true, mode: 0o700 });
  writeUpdateCache(h.home, {
    checkedAt: fresh ? Date.now() : Date.now() - 2 * 86_400_000,
    latest: '99.0.0',
  });
  return h;
}

let net: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  net = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('the notice must never fetch');
  });
});
afterEach(() => {
  expect(net).not.toHaveBeenCalled();
  net.mockRestore();
});

describe('the update notice on the command line', () => {
  it('notice.one-dim-stderr-line-after-an-interactive-command', async () => {
    const h = withUpdate();
    const r = await h.run(['stats'], TERMINAL);
    expect(r.code).toBe(0);
    expect(r.io.stdout).not.toContain('is available');
    expect(r.io.stderr.split('\n').filter((l) => l.includes(LINE))).toHaveLength(1);
    // After the output: the last line on stderr.
    expect(r.io.stderr.trimEnd().endsWith(LINE) || r.io.stderr.includes(`${LINE}\u001b`)).toBe(
      true,
    );
    // A fresh cache starts no background check.
    expect(r.io.updateChecks).toBe(0);
  });

  it('notice.never-with-json-output-json-a-pipe-or-an-opt-out', async () => {
    const h = withUpdate();
    for (const [args, io] of [
      [['stats', '--json'], TERMINAL],
      [['stats'], { ...TERMINAL, env: { HOME: h.root, OORT_HOME: h.home, OORT_OUTPUT: 'json' } }],
      [['stats'], { stdoutTTY: false, stderrTTY: true }],
      [['stats'], { stdoutTTY: true, stderrTTY: false }],
      [
        ['stats'],
        { ...TERMINAL, env: { HOME: h.root, OORT_HOME: h.home, OORT_NO_UPDATE_CHECK: '1' } },
      ],
      [
        ['stats'],
        { ...TERMINAL, env: { HOME: h.root, OORT_HOME: h.home, NO_UPDATE_NOTIFIER: '1' } },
      ],
      [['stats'], { ...TERMINAL, env: { HOME: h.root, OORT_HOME: h.home, CI: 'true' } }],
    ] as const) {
      const r = await h.run([...args], io);
      expect(
        `${r.io.stdout}${r.io.stderr}`,
        JSON.stringify(args) + JSON.stringify(io),
      ).not.toContain('is available');
      expect(r.io.updateChecks).toBe(0);
    }
    fs.writeFileSync(`${h.home}/config.json`, '{"updates":{"check":false}}');
    const off = await h.run(['stats'], TERMINAL);
    expect(off.io.stderr).not.toContain('is available');
  });

  it('notice.never-in-the-hook-output-mcp-update-or-doctor-own-line-only', async () => {
    const h = withUpdate();
    // The prompt hook prints only its JSON for the model, even on a terminal.
    const prompt = await h.run(['hook', 'UserPromptSubmit'], {
      ...TERMINAL,
      stdin: JSON.stringify({ session_id: 's', cwd: h.cwd, prompt: 'auth port?' }),
    });
    expect(`${prompt.io.hookStdout ?? ''}${prompt.io.stdout}${prompt.io.stderr}`).not.toContain(
      'is available',
    );
    // SessionStart: only in `systemMessage`, never in the model's `additionalContext`.
    const start = await h.run(['hook', 'SessionStart'], {
      ...TERMINAL,
      stdin: JSON.stringify({ session_id: 's', cwd: h.cwd, source: 'startup' }),
    });
    const out = JSON.parse(start.io.hookStdout ?? '{}') as Record<string, unknown>;
    expect(out['systemMessage']).toBe(LINE);
    expect(JSON.stringify(out['hookSpecificOutput'] ?? {})).not.toContain('99.0.0');
    expect(start.io.stderr).not.toContain('is available');
    // Doctor has its own info line, not the dim one on stderr.
    const doctor = await h.run(['doctor'], TERMINAL);
    expect(doctor.io.stderr).not.toContain(LINE);
    expect(doctor.io.stdout).toContain(`Oort 99.0.0 is available (you have ${VERSION})`);
  });

  it('notice.a-stale-cache-asks-for-one-background-check-and-shows-what-it-knows', async () => {
    const h = withUpdate(false);
    const r = await h.run(['stats'], TERMINAL);
    expect(r.io.updateChecks).toBe(1);
    expect(r.io.stderr).toContain(LINE);
    const again = await h.run(['stats'], TERMINAL);
    expect(again.io.updateChecks).toBe(0);
  });
});

describe('oort serve status', () => {
  it('notice.serve-status-shows-a-line-never-in-json', async () => {
    const h = withUpdate();
    const text = await h.run(['serve', 'status'], TERMINAL);
    expect(text.io.stdout).toContain(LINE);
    expect(text.io.stderr).not.toContain(LINE);
    const json = await h.run(['serve', 'status', '--json'], TERMINAL);
    expect(json.io.stdout).not.toContain('99.0.0');
  });
});
