import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempHome } from '../test/helpers.js';
import { installHooks, uninstallHooks } from './install.js';

function settingsFile(content?: unknown): string {
  const t = tempHome();
  const file = path.join(t.root, '.claude', 'settings.json');
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content, null, 2) + '\n');
  }
  return file;
}

const read = (file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

const OURS = {
  UserPromptSubmit: [
    { hooks: [{ type: 'command', command: 'oort hook UserPromptSubmit', timeout: 10 }] },
  ],
  Stop: [{ hooks: [{ type: 'command', command: 'oort hook Stop', timeout: 5 }] }],
  SessionStart: [{ hooks: [{ type: 'command', command: 'oort hook SessionStart', timeout: 10 }] }],
};

const USER_STOP = { hooks: [{ type: 'command', command: '/usr/local/bin/notify-done.sh' }] };
const USER_PRE = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: 'guard.sh', timeout: 3 }],
};

describe('installHooks', () => {
  it('install.idempotent', () => {
    const file = settingsFile();
    expect(installHooks(file, 'oort')).toEqual({ changed: true });
    expect(read(file)).toEqual({ hooks: OURS });
    const bytes = fs.readFileSync(file, 'utf8');
    expect(bytes).toBe(JSON.stringify({ hooks: OURS }, null, 2) + '\n');
    expect(installHooks(file, 'oort')).toEqual({ changed: false });
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    // Nothing existed before, so there is nothing to back up.
    expect(fs.existsSync(`${file}.oort-backup`)).toBe(false);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });

  it('install.preserves-other-hooks', () => {
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(ls)'] },
      hooks: { PreToolUse: [USER_PRE], Stop: [USER_STOP] },
      statusLine: { type: 'command', command: 'status.sh' },
    };
    const file = settingsFile(original);
    const before = fs.readFileSync(file, 'utf8');
    expect(installHooks(file, 'oort')).toEqual({ changed: true });
    const after = read(file);
    expect(Object.keys(after)).toEqual(['model', 'permissions', 'hooks', 'statusLine']);
    expect(after).toEqual({
      ...original,
      hooks: {
        PreToolUse: [USER_PRE],
        Stop: [USER_STOP, ...OURS.Stop],
        UserPromptSubmit: OURS.UserPromptSubmit,
        SessionStart: OURS.SessionStart,
      },
    });
    expect(fs.readFileSync(`${file}.oort-backup`, 'utf8')).toBe(before);

    // The backup is one-time: a later change never overwrites it.
    expect(installHooks(file, '/opt/oort/bin/oort')).toEqual({ changed: true });
    expect(fs.readFileSync(`${file}.oort-backup`, 'utf8')).toBe(before);
  });

  it('install.replaces-stale-oort-command', () => {
    const file = settingsFile({
      hooks: {
        Stop: [
          USER_STOP,
          { hooks: [{ type: 'command', command: 'oort hook Stop --legacy', timeout: 30 }] },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              { type: 'command', command: '/old/bin/oort hook UserPromptSubmit', timeout: 60 },
            ],
          },
          {
            hooks: [{ type: 'command', command: 'oort hook UserPromptSubmit', timeout: 10 }],
          },
        ],
      },
    });
    expect(installHooks(file, 'oort')).toEqual({ changed: true });
    expect(read(file)['hooks']).toEqual({
      Stop: [USER_STOP, ...OURS.Stop],
      UserPromptSubmit: OURS.UserPromptSubmit,
      SessionStart: OURS.SessionStart,
    });
    expect(installHooks(file, 'oort')).toEqual({ changed: false });
  });

  it('install.uninstall-leaves-others', () => {
    const original = { model: 'opus', hooks: { PreToolUse: [USER_PRE], Stop: [USER_STOP] } };
    const file = settingsFile(original);
    installHooks(file, 'oort');
    expect(uninstallHooks(file, 'oort')).toEqual({ changed: true });
    expect(read(file)).toEqual(original);
    expect(uninstallHooks(file, 'oort')).toEqual({ changed: false });

    const emptyHooks = settingsFile({ hooks: {} });
    expect(uninstallHooks(emptyHooks, 'oort')).toEqual({ changed: false });
    expect(read(emptyHooks)).toEqual({ hooks: {} });

    const fresh = settingsFile();
    installHooks(fresh, 'oort');
    uninstallHooks(fresh, 'oort');
    expect(read(fresh)).toEqual({});
  });

  it('install.uninstall-missing-file-is-noop', () => {
    const file = settingsFile();
    expect(uninstallHooks(file, 'oort')).toEqual({ changed: false });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('install.refuses-invalid-settings', () => {
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "hooks": ');
    expect(() => installHooks(file, 'oort')).toThrow(/settings/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "hooks": ');
    fs.writeFileSync(file, '{ "hooks": [] }');
    expect(() => installHooks(file, 'oort')).toThrow(/hooks/);
  });

  it('install.keeps-file-mode', () => {
    if (process.platform === 'win32') return;
    const file = settingsFile({ model: 'opus' });
    fs.chmodSync(file, 0o640);
    installHooks(file, 'oort');
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it('install.writes-through-symlinked-settings', () => {
    if (process.platform === 'win32') return;
    const t = tempHome();
    const real = path.join(t.root, 'dotfiles', 'claude-settings.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, JSON.stringify({ model: 'opus' }));
    const link = path.join(t.root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link);
    expect(installHooks(link, 'oort')).toEqual({ changed: true });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(real)).toEqual({ model: 'opus', hooks: OURS });
    expect(uninstallHooks(link, 'oort')).toEqual({ changed: true });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(real)).toEqual({ model: 'opus' });
  });
});
