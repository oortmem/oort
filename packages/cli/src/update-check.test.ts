/**
 * The update check and its notice (CON-114): the cache (TTL, atomic 0600 writes), every opt-out,
 * the one request it makes, and the SessionStart message for the person (`systemMessage`, never
 * the model's `additionalContext`). Throwaway homes and a fake registry; no network.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERSION } from '@oortmem/core';
import { harness, tmpdir } from '../test/helpers.js';
import { RESTART_FILE, SKIP_FILE, hookViaDaemon, readSkip } from './serve-client.js';
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION, socketPathFor } from './serve-protocol.js';
import * as nodeNet from 'node:net';
import { compareVersions, isNewerVersion } from './serve-protocol.js';
import {
  CACHE_FILE,
  CHECK_EVERY_MS,
  CHECK_USER_AGENT,
  REGISTRY_LATEST_URL,
  availableUpdate,
  cacheDir,
  fetchLatest,
  refresherEnv,
  spawnRefresh,
  isStale,
  noticeText,
  readUpdateCache,
  refreshUpdateCache,
  requestRefresh,
  sessionStartNotice,
  updateCheckOff,
  withSystemMessage,
  writeUpdateCache,
} from './update-check.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const NEWER = '99.0.0';

function home(): string {
  const dir = path.join(tmpdir('oort-update-check-'), '.oort');
  fs.mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** A fake registry: records every request, answers `body` (or a status). */
function registry(
  answer: () => Response | Promise<Response> = () => Response.json({ version: NEWER }),
) {
  const seen: Request[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return answer();
  }) as typeof fetch;
  return { seen, fetchFn };
}

let net: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  net = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('the update check must not use the real network in tests');
  });
});
afterEach(() => {
  expect(net).not.toHaveBeenCalled();
  net.mockRestore();
});

describe('versions', () => {
  it('update.versions-compare-as-semver-and-garbage-decides-nothing', () => {
    expect(compareVersions('0.6.3', '0.6.2')).toBe(1);
    expect(compareVersions('0.6.2', '0.6.10')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.7.0-rc.1', '0.7.0')).toBe(-1);
    expect(compareVersions('0.7.0-rc.2', '0.7.0-rc.10')).toBe(-1);
    expect(compareVersions('0.6.2', '0.6.2')).toBe(0);
    expect(compareVersions('unknown', '0.6.2')).toBeUndefined();
    expect(isNewerVersion('unknown', '0.6.2')).toBe(false);
    expect(isNewerVersion('0.6.2', 'garbage')).toBe(false);
  });
});

describe('the cache', () => {
  it('update.cache-ttl-is-24h-and-a-future-stamp-is-stale', () => {
    expect(isStale({}, NOW)).toBe(true);
    expect(isStale({ checkedAt: NOW - CHECK_EVERY_MS + 1000 }, NOW)).toBe(false);
    expect(isStale({ checkedAt: NOW - CHECK_EVERY_MS }, NOW)).toBe(true);
    expect(isStale({ checkedAt: NOW + 2 * 3_600_000 }, NOW)).toBe(true);
  });

  it('update.cache-is-written-atomically-0600-and-never-through-a-symlink', () => {
    const h = home();
    expect(writeUpdateCache(h, { checkedAt: NOW, latest: '0.6.3' })).toBe(true);
    const file = path.join(h, CACHE_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readUpdateCache(h)).toEqual({ checkedAt: NOW, latest: '0.6.3' });
    // No temporary file is left beside it.
    expect(fs.readdirSync(h)).toEqual([CACHE_FILE]);
    // A wider file is replaced by a new 0600 one (rename), not rewritten in place.
    fs.chmodSync(file, 0o644);
    const before = fs.statSync(file).ino;
    writeUpdateCache(h, { checkedAt: NOW + 1 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file).ino).not.toBe(before);
    // A symlink at the path is replaced by the rename; its target is never written.
    const target = path.join(path.dirname(h), 'elsewhere.json');
    fs.writeFileSync(target, 'keep');
    fs.rmSync(file);
    fs.symlinkSync(target, file);
    writeUpdateCache(h, { checkedAt: NOW + 2 });
    expect(fs.readFileSync(target, 'utf8')).toBe('keep');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
  });

  it('update.cache-is-never-written-into-a-missing-home-and-garbage-reads-as-empty', () => {
    const missing = path.join(tmpdir(), 'no-oort-home');
    expect(writeUpdateCache(missing, { checkedAt: NOW })).toBe(false);
    expect(fs.existsSync(missing)).toBe(false);
    const h = home();
    fs.writeFileSync(path.join(h, CACHE_FILE), '{"checkedAt":"soon","latest":"\\u001b[2J"}');
    expect(readUpdateCache(h)).toEqual({});
    fs.writeFileSync(path.join(h, CACHE_FILE), 'not json');
    expect(readUpdateCache(h)).toEqual({});
  });

  it('update.available-only-for-a-newer-version', () => {
    expect(availableUpdate('0.6.2', { latest: '0.6.3' })).toBe('0.6.3');
    expect(availableUpdate('0.6.3', { latest: '0.6.3' })).toBeUndefined();
    expect(availableUpdate('0.7.0', { latest: '0.6.3' })).toBeUndefined();
    expect(availableUpdate('0.6.2', {})).toBeUndefined();
  });
});

describe('opt-outs', () => {
  it('update.every-opt-out-turns-the-check-off', () => {
    const h = home();
    expect(updateCheckOff({}, h)).toBeUndefined();
    expect(updateCheckOff({ OORT_NO_UPDATE_CHECK: '1' }, h)).toBe('OORT_NO_UPDATE_CHECK');
    expect(updateCheckOff({ OORT_NO_UPDATE_CHECK: '0' }, h)).toBeUndefined();
    expect(updateCheckOff({ NO_UPDATE_NOTIFIER: '1' }, h)).toBe('NO_UPDATE_NOTIFIER');
    expect(updateCheckOff({ CI: 'true' }, h)).toBe('CI');
    expect(updateCheckOff({ CI: '1' }, h)).toBe('CI');
    expect(updateCheckOff({ CI: 'false' }, h)).toBeUndefined();
    fs.writeFileSync(path.join(h, 'config.json'), '{"updates":{"check":false}}');
    expect(updateCheckOff({}, h)).toBe('updates.check');
    fs.writeFileSync(path.join(h, 'config.json'), '{"updates":{"check":true}}');
    expect(updateCheckOff({}, h)).toBeUndefined();
  });

  it('update.an-opt-out-starts-no-check-and-shows-no-notice', () => {
    for (const env of [
      { OORT_NO_UPDATE_CHECK: '1' },
      { NO_UPDATE_NOTIFIER: '1' },
      { CI: 'true' },
      {},
    ]) {
      const h = home();
      writeUpdateCache(h, { checkedAt: NOW - CHECK_EVERY_MS - 1, latest: NEWER });
      if (Object.keys(env).length === 0) {
        fs.writeFileSync(path.join(h, 'config.json'), '{"updates":{"check":false}}');
      }
      let spawned = 0;
      expect(requestRefresh(h, env, () => spawned++, NOW)).toBe(false);
      const out = sessionStartNotice('', '{"source":"startup"}', {
        home: h,
        env,
        current: VERSION,
        spawnRefresh: () => spawned++,
        now: NOW,
      });
      expect(out).toBe('');
      expect(spawned).toBe(0);
    }
  });
});

describe('the request', () => {
  it('update.one-get-to-npm-with-a-generic-user-agent-and-nothing-about-you', async () => {
    const reg = registry();
    expect(await fetchLatest(reg.fetchFn)).toBe(NEWER);
    expect(reg.seen).toHaveLength(1);
    const req = reg.seen[0]!;
    expect(req.url).toBe(REGISTRY_LATEST_URL);
    expect(req.method).toBe('GET');
    expect(req.headers.get('user-agent')).toBe(CHECK_USER_AGENT);
    expect(CHECK_USER_AGENT).not.toContain(VERSION);
    expect(req.headers.get('authorization')).toBeNull();
    expect(req.headers.get('cookie')).toBeNull();
    expect(req.redirect).toBe('error');
    expect([...req.headers.keys()].sort()).toEqual(['accept', 'user-agent']);
  });

  it('update.a-bad-answer-or-a-slow-registry-throws', async () => {
    await expect(
      fetchLatest(registry(() => new Response('', { status: 500 })).fetchFn),
    ).rejects.toThrow('500');
    await expect(
      fetchLatest(registry(() => Response.json({ version: 'latest!' })).fetchFn),
    ).rejects.toThrow('no version');
    const hang = (async (_i: unknown, init?: RequestInit) =>
      new Promise((_r, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )) as typeof fetch;
    const t0 = Date.now();
    await expect(fetchLatest(hang, { timeoutMs: 100 })).rejects.toThrow('aborted');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('update.refresh-records-the-answer-and-a-failure-waits-a-day', async () => {
    const h = home();
    expect(await refreshUpdateCache(h, registry().fetchFn, () => NOW)).toBe(NEWER);
    expect(readUpdateCache(h)).toEqual({ checkedAt: NOW, latest: NEWER });
    const down = registry(() => new Response('', { status: 503 }));
    expect(await refreshUpdateCache(h, down.fetchFn, () => NOW + 5)).toBeUndefined();
    // The last known version stays; the attempt is stamped, so it is not retried today.
    expect(readUpdateCache(h)).toEqual({ checkedAt: NOW + 5, latest: NEWER });
  });

  it('update.a-stale-cache-asks-for-one-background-check-and-stamps-it-first', () => {
    const h = home();
    let spawned = 0;
    expect(requestRefresh(h, {}, () => spawned++, NOW)).toBe(true);
    expect(spawned).toBe(1);
    expect(readUpdateCache(h).checkedAt).toBe(NOW);
    // A second hook at once (another session) does not start another.
    expect(requestRefresh(h, {}, () => spawned++, NOW + 10)).toBe(false);
    expect(spawned).toBe(1);
    expect(requestRefresh(h, {}, () => spawned++, NOW + CHECK_EVERY_MS)).toBe(true);
    expect(spawned).toBe(2);
  });
});

describe('the SessionStart notice', () => {
  const MEMORY = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '<oort-memory>\npinned: deploy from main\n</oort-memory>',
    },
  });
  const notice = (h: string, stdout: string, source = 'startup', now = NOW, spawn = () => {}) =>
    sessionStartNotice(stdout, JSON.stringify({ session_id: 's', cwd: '/w', source }), {
      home: h,
      env: {},
      current: '0.6.2',
      spawnRefresh: spawn,
      now,
    });

  it('update.session-start-tells-the-person-in-systemMessage-and-keeps-the-memory-context', () => {
    const h = home();
    writeUpdateCache(h, { checkedAt: NOW, latest: '0.6.3' });
    const out = JSON.parse(notice(h, MEMORY)) as Record<string, unknown>;
    // `systemMessage` is shown to the user; the model's context is exactly the memory block.
    expect(out['systemMessage']).toBe('Oort 0.6.3 is available (you have 0.6.2): oort update');
    expect(out['hookSpecificOutput']).toEqual(JSON.parse(MEMORY).hookSpecificOutput);
    expect(JSON.stringify(out['hookSpecificOutput'])).not.toContain('0.6.3');
    expect(Object.keys(out).sort()).toEqual(['hookSpecificOutput', 'systemMessage']);
  });

  it('update.session-start-output-fits-codex-schema-which-rejects-unknown-fields (M7)', () => {
    // Codex runs the same hook; its session-start.command.output schema has
    // additionalProperties: false at both levels.
    const TOP = ['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'hookSpecificOutput'];
    const INNER = ['hookEventName', 'additionalContext'];
    const h = home();
    for (const stdout of [MEMORY, '']) {
      writeUpdateCache(h, { checkedAt: NOW, latest: '0.6.3' });
      const out = JSON.parse(notice(h, stdout)) as Record<string, unknown>;
      expect(typeof out['systemMessage']).toBe('string');
      for (const k of Object.keys(out)) expect(TOP).toContain(k);
      const inner = (out['hookSpecificOutput'] ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(inner)) expect(INNER).toContain(k);
      writeUpdateCache(h, {});
    }
  });

  it('update.session-start-with-no-memories-prints-only-the-message', () => {
    const h = home();
    writeUpdateCache(h, { checkedAt: NOW, latest: '0.6.3' });
    expect(JSON.parse(notice(h, ''))).toEqual({
      systemMessage: noticeText('0.6.3', '0.6.2'),
    });
  });

  it('update.session-start-shows-a-version-once-a-day-and-a-newer-one-at-once', () => {
    const h = home();
    writeUpdateCache(h, { checkedAt: NOW, latest: '0.6.3' });
    expect(notice(h, MEMORY)).toContain('systemMessage');
    expect(notice(h, MEMORY, 'startup', NOW + 60_000)).toBe(MEMORY);
    expect(notice(h, MEMORY, 'resume', NOW + 23 * 3_600_000)).toBe(MEMORY);
    expect(notice(h, MEMORY, 'startup', NOW + 24 * 3_600_000)).toContain('systemMessage');
    writeUpdateCache(h, { ...readUpdateCache(h), latest: '0.6.4' });
    expect(notice(h, MEMORY, 'startup', NOW + 24 * 3_600_000 + 1)).toContain('0.6.4');
  });

  it('update.session-start-never-on-compact-nor-when-current-and-never-breaks-the-output', () => {
    const h = home();
    writeUpdateCache(h, { checkedAt: NOW, latest: '0.6.3' });
    expect(notice(h, MEMORY, 'compact')).toBe(MEMORY);
    writeUpdateCache(h, { checkedAt: NOW, latest: '0.6.2' });
    expect(notice(h, MEMORY)).toBe(MEMORY);
    writeUpdateCache(h, { checkedAt: NOW, latest: '0.6.3' });
    expect(notice(h, 'not json')).toBe('not json');
    expect(withSystemMessage('[1]', 'x')).toBeUndefined();
    expect(withSystemMessage('{"systemMessage":"theirs"}', 'x')).toBeUndefined();
  });

  it('update.session-start-only-reads-the-cache-and-asks-for-a-background-check', () => {
    const h = home();
    let spawned = 0;
    // No cache yet: nothing shown, one background check asked for, no request made here.
    expect(notice(h, MEMORY, 'startup', NOW, () => spawned++)).toBe(MEMORY);
    expect(spawned).toBe(1);
  });
});

describe('hardening', () => {
  it('update.the-background-check-gets-only-its-allowlisted-environment (M3)', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/Users/x',
      OORT_HOME: '/elsewhere',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      VOYAGE_API_KEY: 'pa-secret',
      OORT_API_KEY: 'oort_sk_secret',
      NPM_TOKEN: 'npm_secret',
      GITHUB_TOKEN: 'ghp_secret',
      HTTPS_PROXY: 'http://proxy:3128',
      no_proxy: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      NODE_USE_ENV_PROXY: '1',
      CI: 'false',
    };
    const out = refresherEnv(env, '/Users/x/.oort');
    expect(out).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      OORT_HOME: '/Users/x/.oort',
      HTTPS_PROXY: 'http://proxy:3128',
      no_proxy: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      NODE_USE_ENV_PROXY: '1',
      CI: 'false',
    });
    // And that is what the spawned process really gets.
    let seen: NodeJS.ProcessEnv | undefined;
    const fakeSpawn = ((_f: string, _a: string[], o: { env: NodeJS.ProcessEnv }) => {
      seen = o.env;
      return { on() {}, unref() {} };
    }) as unknown as Parameters<typeof spawnRefresh>[2];
    spawnRefresh('/Users/x/.oort', env, fakeSpawn);
    expect(seen).toEqual(out);
    expect(JSON.stringify(seen)).not.toContain('secret');
  });

  it('update.a-declared-oversized-answer-is-refused-before-reading (M4)', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
      },
    });
    const res = new Response(body, { headers: { 'content-length': String(50 * 1024 * 1024) } });
    await expect(fetchLatest(registry(() => res).fetchFn)).rejects.toThrow('too large');
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('update.an-endless-answer-is-aborted-past-the-cap (M4)', async () => {
    let bytes = 0;
    let aborted = false;
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => (aborted = true));
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            bytes += 64 * 1024;
            c.enqueue(new Uint8Array(64 * 1024).fill(0x20));
          },
        }),
      );
    }) as typeof fetch;
    await expect(fetchLatest(fetchFn, { timeoutMs: 10_000 })).rejects.toThrow('too large');
    expect(aborted).toBe(true);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
  });

  it('update.a-symlinked-home-is-followed-only-when-it-is-yours-alone (M6)', () => {
    const root = tmpdir();
    const real = path.join(root, 'real-oort');
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(root, '.oort');
    fs.symlinkSync(real, link);
    expect(cacheDir(link)).toEqual({ dir: fs.realpathSync(real) });
    expect(updateCheckOff({}, link)).toBeUndefined();
    expect(writeUpdateCache(link, { checkedAt: NOW })).toBe(true);
    expect(fs.existsSync(path.join(real, CACHE_FILE))).toBe(true);
    // Writable by others: refused, and said why; nothing is written or started.
    fs.chmodSync(real, 0o777);
    expect(updateCheckOff({}, link)).toBe(
      'home: it is a symlink to a directory that group or others can write',
    );
    fs.rmSync(path.join(real, CACHE_FILE));
    expect(writeUpdateCache(link, { checkedAt: NOW })).toBe(false);
    let spawned = 0;
    expect(requestRefresh(link, {}, () => spawned++, NOW)).toBe(false);
    expect(spawned).toBe(0);
    fs.chmodSync(real, 0o700);
    // A symlink that leads nowhere, or to a file.
    const dangling = path.join(root, 'dangling');
    fs.symlinkSync(path.join(root, 'nothing'), dangling);
    expect(cacheDir(dangling)).toEqual({ why: 'it is a symlink that leads nowhere' });
    fs.writeFileSync(path.join(root, 'file'), '');
    const toFile = path.join(root, 'to-file');
    fs.symlinkSync(path.join(root, 'file'), toFile);
    expect(cacheDir(toFile)).toEqual({
      why: 'it is a symlink to something that is not a directory',
    });
    // No home yet: nothing is wrong, nothing is created.
    expect(cacheDir(path.join(root, 'none'))).toEqual({ missing: true });
  });

  it('update.doctor-says-why-a-refused-home-skips-the-check (M6)', async () => {
    const h = harness();
    const real = path.join(h.root, 'real-oort');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.chmodSync(real, 0o777);
    fs.symlinkSync(real, h.home);
    const r = await h.run(['doctor']);
    expect(r.io.stdout).toContain(
      'update check skipped: ~/oort-home it is a symlink to a directory that group or others can write',
    );
    fs.chmodSync(real, 0o700);
  });

  it('update.two-restarting-answers-within-a-minute-open-the-breaker (M9)', async () => {
    const h = home();
    fs.chmodSync(h, 0o700);
    const socket = socketPathFor(h);
    let answered = 0;
    const server = nodeNet.createServer((conn) => {
      const decoder = new FrameDecoder();
      conn.on('data', (c: Buffer) => {
        for (const f of decoder.push(c) as { id: number }[]) {
          answered++;
          conn.end(
            encodeFrame({
              v: PROTOCOL_VERSION,
              id: f.id,
              ok: false,
              error: { code: 'restarting', message: 'this daemon is oort 0.0.1' },
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => server.listen(socket, r));
    try {
      const env = { HOME: path.dirname(h), OORT_HOME: h };
      const stdin = JSON.stringify({ session_id: 's', cwd: '/w', prompt: 'x' });
      const first = await hookViaDaemon('UserPromptSubmit', stdin, '/w', env, { now: () => NOW });
      expect(first).toEqual({ served: false, reason: 'error', code: 'restarting' });
      expect(readSkip(h)).toBeUndefined();
      expect(fs.readFileSync(path.join(h, RESTART_FILE), 'utf8').trim()).toBe(String(NOW));
      // Again 30 s later: something keeps starting an older daemon. Open the breaker, start nothing.
      const second = await hookViaDaemon('UserPromptSubmit', stdin, '/w', env, {
        now: () => NOW + 30_000,
      });
      expect(second).toMatchObject({ code: 'restarting', tripped: true });
      expect(readSkip(h)).toEqual({ until: NOW + 30_000 + 60_000, reason: 'refused' });
      // While it is open the daemon is not even asked.
      const third = await hookViaDaemon('UserPromptSubmit', stdin, '/w', env, {
        now: () => NOW + 31_000,
      });
      expect(third).toEqual({ served: false, reason: 'skipped' });
      expect(answered).toBe(2);
      // Once per update, a minute apart or more, never trips it.
      fs.rmSync(path.join(h, SKIP_FILE));
      const later = await hookViaDaemon('UserPromptSubmit', stdin, '/w', env, {
        now: () => NOW + 10 * 60_000,
      });
      expect(later).toEqual({ served: false, reason: 'error', code: 'restarting' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
