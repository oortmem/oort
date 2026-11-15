import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../test/helpers.js';
import {
  AUTOSTART_FILE,
  LOG_MAX_BYTES,
  RECENT_SPAWN_MS,
  SKIP_FILE,
  STARTING_GRACE_MS,
  YOUNG_DEATH_MS,
  autostartOff,
  autostartPlan,
  backoffMs,
  daemonStarting,
  hookViaDaemon,
  noteServed,
  openPrivateLog,
  readAutostartState,
  readSkip,
  recordStartFailure,
  writeAutostartState,
} from './serve-client.js';

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
    // Only the boolean true (or no key) is on. Anything else the daemon's own config check would
    // refuse, so it would fail on every start: off, and doctor says why.
    for (const bad of [
      '{"serve":{"autostart":"false"}}',
      '{"serve":{"autostart":"true"}}',
      '{"serve":{"autostart":0}}',
      '{"serve":{"autostart":null}}',
      '{"serve":{"idleMinutes":"x"}}',
      '{"serve":{"idleMinutes":0}}',
      '{"serve":{"idleMinutes":1.5}}',
      '{"serve":{"idleMinutes":1441}}',
      '{"serve":"on"}',
      '{"serve":null}',
      '[]',
    ]) {
      expect(autostartOff(home(bad), {}, 'linux'), bad).toBe('serve.invalid');
    }
    expect(autostartOff(home('{"serve":{"idleMinutes":1440}}'), {}, 'linux')).toBeUndefined();
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

describe('autostart backs off a daemon that will not stay up', () => {
  const MIN = 60_000;
  const absent = { served: false as const, reason: 'absent' as const };
  const fresh = (): string => tmpdir('oort-backoff-');

  it('serve.autostart-backoff-grows-1m-5m-30m-and-a-config-change-resets-it', () => {
    expect([1, 2, 3, 4, 9].map(backoffMs)).toEqual([MIN, 5 * MIN, 30 * MIN, 30 * MIN, 30 * MIN]);
    const h = fresh();
    const t = 1_000_000_000_000;
    expect(recordStartFailure(h, 'start', t)).toBe(t + MIN);
    expect(readSkip(h)).toEqual({ until: t + MIN, reason: 'start' });
    expect(recordStartFailure(h, 'start', t + 2 * MIN)).toBe(t + 7 * MIN);
    expect(recordStartFailure(h, 'start', t + 8 * MIN)).toBe(t + 38 * MIN);
    expect(recordStartFailure(h, 'start', t + 40 * MIN)).toBe(t + 70 * MIN);
    expect(readAutostartState(h).failures).toBe(4);
    // Editing the home config starts the count again: the next failure waits a minute.
    fs.writeFileSync(path.join(h, 'config.json'), '{"serve":{"idleMinutes":5}}');
    expect(recordStartFailure(h, 'start', t + 71 * MIN)).toBe(t + 72 * MIN);
    expect(readAutostartState(h).failures).toBe(1);
    // A pending migration keeps its own reason (oort doctor clears it).
    expect(recordStartFailure(h, 'migration', t + 73 * MIN)).toBe(t + 78 * MIN);
    expect(readSkip(h)?.reason).toBe('migration');
  });

  it('serve.autostart-a-recent-start-is-not-repeated-and-a-daemon-that-died-young-counts-as-a-failure', () => {
    const h = fresh();
    const t = 1_000_000_000_000;
    expect(autostartPlan(absent, h, {}, t)).toBe('start');
    // spawnDaemon records the start; this stands in for it.
    writeAutostartState(h, { spawnedAt: t, failures: 0 });
    // Within 30 s nothing answers yet, or the daemon already died: start no other.
    expect(autostartPlan(absent, h, {}, t + RECENT_SPAWN_MS - 1)).toBeUndefined();
    expect(readSkip(h)).toBeUndefined();
    // Between 30 s and a minute with no daemon: it died young. A failure, the breaker opens.
    expect(autostartPlan(absent, h, {}, t + 45_000)).toBeUndefined();
    expect(readSkip(h)).toEqual({ until: t + 45_000 + 60_000, reason: 'start' });
    expect(readAutostartState(h).failures).toBe(1);
    // Past a minute (a daemon that ran, then exited idle or was stopped): start one.
    fs.rmSync(path.join(h, SKIP_FILE));
    writeAutostartState(h, { spawnedAt: t, failures: 1 });
    expect(autostartPlan(absent, h, {}, t + YOUNG_DEATH_MS + 1)).toBe('start');
  });

  it('serve.autostart-a-daemon-that-served-and-stayed-up-a-minute-resets-the-backoff', () => {
    const h = fresh();
    const t = 1_000_000_000_000;
    writeAutostartState(h, { spawnedAt: t, failures: 2 });
    noteServed(h, t + 10_000); // too young to count as healthy
    expect(readAutostartState(h).failures).toBe(2);
    noteServed(h, t + YOUNG_DEATH_MS + 1);
    expect(readAutostartState(h)).toMatchObject({ spawnedAt: t, failures: 0 });
  });

  it('serve.autostart-an-edited-config-reopens-a-start-breaker-at-once', async () => {
    const h = fresh();
    const now = Date.now();
    recordStartFailure(h, 'start', now);
    const env = { OORT_HOME: h };
    expect(await hookViaDaemon('UserPromptSubmit', '{}', h, env)).toEqual({
      served: false,
      reason: 'skipped',
    });
    fs.writeFileSync(path.join(h, 'config.json'), '{"serve":{"idleMinutes":5}}');
    // Not skipped any more: there is no daemon, so the hook may start one.
    expect(await hookViaDaemon('UserPromptSubmit', '{}', h, env)).toMatchObject({
      served: false,
      reason: 'absent',
    });
    expect(readSkip(h)).toBeUndefined();
    expect(readAutostartState(h).failures).toBe(0);
    expect(fs.existsSync(path.join(h, AUTOSTART_FILE))).toBe(true);
  });
});

describe('serve.log', () => {
  it('serve.log-is-rotated-past-1-MB-keeping-one-older-file', () => {
    const dir = tmpdir('oort-log-');
    const log = path.join(dir, 'serve.log');
    fs.writeFileSync(log, 'x'.repeat(LOG_MAX_BYTES - 10), { mode: 0o600 });
    fs.closeSync(openPrivateLog(log)); // under the cap: kept
    expect(fs.existsSync(`${log}.1`)).toBe(false);
    fs.appendFileSync(log, 'y'.repeat(20));
    const fd = openPrivateLog(log);
    fs.writeSync(fd, 'new\n');
    fs.closeSync(fd);
    expect(fs.readFileSync(log, 'utf8')).toBe('new\n');
    expect(fs.statSync(`${log}.1`).size).toBe(LOG_MAX_BYTES + 10);
    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${log}.1`).mode & 0o777).toBe(0o600);
    // Again: the older .1 is replaced, never a third file.
    fs.appendFileSync(log, 'z'.repeat(LOG_MAX_BYTES));
    fs.closeSync(openPrivateLog(log));
    expect(fs.readFileSync(`${log}.1`, 'utf8').startsWith('new\n')).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(['serve.log', 'serve.log.1']);
  });

  it('serve.log-rotation-never-follows-a-symlink', () => {
    const dir = tmpdir('oort-log-');
    const target = path.join(dir, 'elsewhere');
    fs.writeFileSync(target, 'x'.repeat(LOG_MAX_BYTES + 1));
    const log = path.join(dir, 'serve.log');
    fs.symlinkSync(target, log);
    expect(() => openPrivateLog(log)).toThrow();
    expect(fs.statSync(target).size).toBe(LOG_MAX_BYTES + 1);
    expect(fs.existsSync(`${log}.1`)).toBe(false);
  });
});
