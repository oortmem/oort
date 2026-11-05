import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../test/helpers.js';
import { parseIdle } from './commands/serve.js';
import { acquireLock, checkSocketDir, lockHolder } from './serve-daemon.js';
import {
  FrameDecoder,
  MAX_FRAME_BYTES,
  encodeFrame,
  homeFrom,
  lockPathFor,
  socketPathFor,
} from './serve-protocol.js';

describe('serve protocol', () => {
  it('serve.frames-split-and-joined-across-chunks', () => {
    const a = encodeFrame({ v: 1, id: 1, method: 'ping', params: {} });
    const b = encodeFrame({ v: 1, id: 2, method: 'status', params: { x: 'é' } });
    const both = Buffer.concat([a, b]);
    const d = new FrameDecoder();
    expect(d.push(both.subarray(0, 3))).toEqual([]);
    expect(d.push(both.subarray(3, a.length + 5))).toEqual([
      { v: 1, id: 1, method: 'ping', params: {} },
    ]);
    expect(d.push(both.subarray(a.length + 5))).toEqual([
      { v: 1, id: 2, method: 'status', params: { x: 'é' } },
    ]);
  });

  it('serve.frames-too-large-or-not-json-are-refused', () => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(MAX_FRAME_BYTES + 1);
    expect(() => new FrameDecoder().push(head)).toThrow(/too large/);
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(2);
    expect(() => new FrameDecoder().push(Buffer.concat([bad, Buffer.from('{x')]))).toThrow();
    expect(() => encodeFrame({ s: 'x'.repeat(MAX_FRAME_BYTES) })).toThrow(/too large/);
  });

  it('serve.socket-path-beside-the-home-or-a-short-fallback', () => {
    expect(socketPathFor('/Users/a/.oort')).toBe('/Users/a/.oort/oort.sock');
    const long = `/Users/a/${'d'.repeat(120)}/.oort`;
    const fallback = socketPathFor(long);
    expect(fallback).toMatch(/^\/tmp\/oort-\d+\/[0-9a-f]{16}\.sock$/);
    expect(socketPathFor(long)).toBe(fallback);
    expect(socketPathFor(`${long}2`)).not.toBe(fallback);
    expect(lockPathFor('/Users/a/.oort/oort.sock')).toBe('/Users/a/.oort/oort.pid');
    expect(homeFrom({ OORT_HOME: '/x/y' }, () => '/h')).toBe('/x/y');
    expect(homeFrom({ HOME: '/h' }, () => '/nope')).toBe('/h/.oort');
    expect(homeFrom({}, () => '/h')).toBe('/h/.oort');
  });

  it('serve.idle-durations', () => {
    expect(parseIdle('30')).toBe(30 * 60_000);
    expect(parseIdle('45s')).toBe(45_000);
    expect(parseIdle('500ms')).toBe(500);
    expect(parseIdle('2h')).toBe(2 * 3_600_000);
    for (const bad of ['0', '50ms', '25h', 'soon', '-1m', '1.5m']) {
      expect(() => parseIdle(bad)).toThrow(/not a duration/);
    }
  });
});

describe('serve lock and socket directory', () => {
  it('serve.lock-is-exclusive-and-a-dead-holder-is-replaced', async () => {
    const dir = tmpdir('oort-lock-');
    const lock = path.join(dir, 'oort.pid');
    await acquireLock(lock, async () => false);
    expect(fs.readFileSync(lock, 'utf8').trim()).toBe(String(process.pid));
    expect(fs.statSync(lock).mode & 0o777).toBe(0o600);
    expect(lockHolder(lock)).toBe(process.pid);
    // Held by a live process that answers: refused.
    await expect(acquireLock(lock, async () => true)).rejects.toThrow(/already running/);
    // Held by a live process that does not answer yet, freshly written: still starting.
    await expect(acquireLock(lock, async () => false)).rejects.toThrow(/starting/);
    // A reused pid: old and silent, so stale.
    await acquireLock(
      lock,
      async () => false,
      () => Date.now() + 60_000,
    );
    // A holder that is gone.
    fs.writeFileSync(lock, '999999999\n');
    expect(lockHolder(lock)).toBeUndefined();
    await acquireLock(lock, async () => true);
    expect(fs.readFileSync(lock, 'utf8').trim()).toBe(String(process.pid));
    // Never through a symlink.
    fs.rmSync(lock);
    fs.symlinkSync(path.join(dir, 'elsewhere'), lock);
    await expect(acquireLock(lock, async () => false)).rejects.toThrow(/not a regular file/);
    expect(fs.existsSync(path.join(dir, 'elsewhere'))).toBe(false);
  });

  it('serve.socket-directory-must-be-private', () => {
    const dir = tmpdir('oort-sockdir-');
    const home = path.join(dir, 'home');
    checkSocketDir(home);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    fs.chmodSync(home, 0o755);
    checkSocketDir(home); // readable by others: tightened, as Oort does for its home
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    fs.chmodSync(home, 0o730);
    expect(() => checkSocketDir(home)).toThrow(/writable by group or others/);
    fs.chmodSync(home, 0o700);
    const other = (process.getuid?.() ?? 0) + 1;
    expect(() => checkSocketDir(home, other)).toThrow(/belongs to another user/);
  });
});
