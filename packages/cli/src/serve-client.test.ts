import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../test/helpers.js';
import { STARTING_GRACE_MS, autostartOff, daemonStarting } from './serve-client.js';

describe('serve.autostart (the hook side)', () => {
  const home = (config?: string): string => {
    const h = tmpdir('oort-autostart-');
    if (config !== undefined) fs.writeFileSync(path.join(h, 'config.json'), config);
    return h;
  };

  it('serve.autostart-is-on-unless-something-turns-it-off', () => {
    // A fresh install, and an existing config that never mentions serve: on.
    expect(autostartOff(home(), {}, 'darwin')).toBeUndefined();
    expect(autostartOff(home('{"recall":{"budgetChars":100}}'), {}, 'linux')).toBeUndefined();
    expect(autostartOff(home('{"serve":{"idleMinutes":5}}'), {}, 'linux')).toBeUndefined();
    expect(autostartOff(home('{"serve":{"autostart":true}}'), {}, 'linux')).toBeUndefined();
    // Turned off in the home config, or for one environment.
    expect(autostartOff(home('{"serve":{"autostart":false}}'), {}, 'linux')).toBe(
      'serve.autostart',
    );
    expect(autostartOff(home(), { OORT_NO_AUTOSTART: '1' }, 'linux')).toBe('OORT_NO_AUTOSTART');
    expect(autostartOff(home(), { OORT_NO_AUTOSTART: 'true' }, 'linux')).toBe('OORT_NO_AUTOSTART');
    expect(autostartOff(home(), { OORT_NO_AUTOSTART: '0' }, 'linux')).toBeUndefined();
    expect(autostartOff(home(), { OORT_NO_AUTOSTART: '' }, 'linux')).toBeUndefined();
    // A config that does not parse: the daemon could not read it either, so nothing starts.
    expect(autostartOff(home('{not json'), {}, 'linux')).toBe('config');
    // The daemon needs Unix sockets: on Windows autostart is a no-op whatever the config says.
    expect(autostartOff(home('{"serve":{"autostart":true}}'), {}, 'win32')).toBe('windows');
  });

  it('serve.autostart-waits-for-a-daemon-that-holds-the-lock-while-it-starts', () => {
    const dir = tmpdir('oort-autostart-');
    const lock = path.join(dir, 'oort.pid');
    const now = Date.now();
    expect(daemonStarting(lock, now)).toBe(false); // no lock: nobody is starting
    fs.writeFileSync(lock, `${process.pid}\n`);
    expect(daemonStarting(lock, now)).toBe(true); // a live holder, just taken
    // Held too long without a socket: not "starting" (a reused pid, or a daemon that hangs).
    expect(daemonStarting(lock, now + STARTING_GRACE_MS + 1000)).toBe(false);
    // A holder that is gone (a daemon killed outright): stale, the next start replaces it.
    fs.writeFileSync(lock, '999999999\n');
    expect(daemonStarting(lock, now)).toBe(false);
    fs.writeFileSync(lock, 'garbage\n');
    expect(daemonStarting(lock, now)).toBe(false);
    fs.rmSync(lock);
    fs.mkdirSync(lock);
    expect(daemonStarting(lock, now)).toBe(false); // not a file
  });
});
