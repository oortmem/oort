import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '@oortmem/core';
import { tmpdir } from '../test/helpers.js';
import { fakeAdapters } from '../test/helpers/sdk-fakes.js';
import { createOortWith } from './sdk/create.js';
import type { OortOptions } from './sdk/types.js';
import { callDaemon } from './serve-client.js';
import { startDaemon, type Daemon } from './serve-daemon.js';
import { MAX_BODY_BYTES, allowedHost, digestOf, tokenMatches } from './serve-http.js';
import {
  isLoopback,
  parseListen,
  readTokenFile,
  serviceDigests,
  serviceSettings,
  serviceTokens,
  tokenPathFor,
  writeTokenFile,
} from './serve-token.js';
import { wire } from './wire.js';

/**
 * A private (0700) directory under the checkout's `.test-homes`, not under the system temp
 * directory: a mounted-secret test is about the directories above the file, so those must not
 * depend on what `/tmp` looks like on the machine running it.
 */
const sealed = (prefix: string): string => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..',
    '.test-homes',
  );
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  return fs.realpathSync(fs.mkdtempSync(path.join(root, prefix)));
};

/**
 * The memory protocol on `oort serve` (CON-108 §8.1): HTTP and hook frames on one socket, the
 * envelope, the limits and refusals, and service mode's token and address checks. The Python
 * client's own suites (python/tests, python.test.ts) cover the SDK calls end to end.
 */

const TOKEN = 'A'.repeat(43);
let root: string;
let home: string;
let daemon: Daemon;
let options: OortOptions[] = [];

beforeAll(async () => {
  root = tmpdir('oort-http-');
  home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  daemon = await startDaemon({
    home,
    env: { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_AGENT: 'daemon-agent' },
    wire,
    version: VERSION,
    idleMs: 600_000,
    spawnDrain: () => {},
    log: () => {},
    warmCwd: root,
    createHandle: (o) => {
      options.push(o);
      return createOortWith(o, { adapters: fakeAdapters() });
    },
    listen: { host: '127.0.0.1', port: 0, auth: { digests: [digestOf(TOKEN)], org: 'acme' } },
  });
});

afterAll(async () => {
  await daemon.stop('test');
});

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: { ok: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> };
}

function request(
  method: string,
  route: string,
  headers: Record<string, string> = {},
  body?: string,
  tcp = false,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        ...(tcp ? { host: '127.0.0.1', port: daemon.tcp!.port } : { socketPath: daemon.socket }),
        method,
        path: route,
        headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Reply['body'],
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('the memory protocol on the socket', () => {
  it('answers the handshake and the hooks frames on the same socket', async () => {
    const h = await request('GET', '/v1/health');
    expect(h.status).toBe(200);
    expect(h.body.data).toEqual({
      version: VERSION,
      protocol: 1,
      mode: 'local',
      capabilities: ['judgments', 'consolidate'],
    });
    const ping = await callDaemon(daemon.socket, 'ping', {}, { budgetMs: 2000 });
    expect(ping.ok).toBe(true);
    expect((await request('GET', '/v1/health')).status).toBe(200);
  });

  it('runs a call through an SDK handle, with the request scope and none of the daemon agent', async () => {
    options = [];
    const r = await request('GET', '/v1/whoami', {
      'oort-cwd': encodeURIComponent(path.join(root, 'a dir')).replaceAll('%2F', '/'),
      'oort-agent': 'bot',
    });
    expect(r.status).toBe(200);
    expect(r.body.data?.['agent']).toBe('bot');
    expect(options.at(-1)?.env?.['OORT_AGENT']).toBeUndefined();
    expect(options.at(-1)).toMatchObject({
      mode: 'local',
      migrate: false,
      cwd: path.join(root, 'a dir'),
    });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('keeps end users to their Planet and needs an org', async () => {
    const no = await request('GET', '/v1/whoami', { 'oort-user': 'u1' });
    expect([no.status, no.body.error?.['reason']]).toEqual([400, 'principal-required']);
    const empty = await request('GET', '/v1/whoami', { 'oort-user': '', 'oort-org': 'acme' });
    expect(empty.body.error?.['reason']).toBe('user-missing');
    const self = await request('GET', '/v1/whoami', { 'oort-user': 'self', 'oort-org': 'acme' });
    expect(self.body.error?.['reason']).toBe('self-not-derivable');
    const u1 = await request('GET', '/v1/whoami', { 'oort-user': 'u1', 'oort-org': 'acme' });
    expect(u1.body.data).toMatchObject({ user: 'u1', writesTo: 'Planet u1' });
  });

  it('refuses a browser, bad input, and anything over the limits', async () => {
    const origin = await request('GET', '/v1/whoami', { origin: 'https://evil.example' });
    expect([origin.status, origin.body.error?.['reason']]).toEqual([403, 'origin-refused']);
    expect((await request('GET', '/v1/nope')).status).toBe(404);
    expect((await request('PUT', '/v1/recall')).body.error?.['reason']).toBe('method-not-allowed');
    expect((await request('GET', '/v1/memories?bogus=1')).status).toBe(400);
    expect((await request('POST', '/v1/recall', {}, '{nope')).body.error?.['reason']).toBe(
      'bad-request',
    );
    expect((await request('POST', '/v1/recall', {}, '[1]')).body.error?.['reason']).toBe(
      'bad-request',
    );
    const big = await request('POST', '/v1/recall', {}, `"${'x'.repeat(MAX_BODY_BYTES)}"`);
    expect([big.status, big.body.error?.['reason']]).toEqual([413, 'too-large']);
    const plain = await request('POST', '/v1/recall', { 'content-type': 'text/plain' }, '{}');
    expect(plain.status).toBe(400);
    const unknown = await request(
      'POST',
      '/v1/recall',
      {},
      JSON.stringify({ query: 'q', near: {} }),
    );
    expect(unknown.body.error).toMatchObject({ code: 'usage', reason: 'invalid-argument' });
    expect(String(unknown.body.error?.['message'])).toContain('near');
    const relative = await request('GET', '/v1/whoami', { 'oort-cwd': 'relative/dir' });
    expect(relative.status).toBe(400);
  });

  it('answers a recall with the SDK result and its default block budget', async () => {
    const r = await request(
      'POST',
      '/v1/recall',
      {},
      JSON.stringify({ query: 'deploy', limit: 3 }),
    );
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ memories: [], abstained: false, budgetChars: 6000 });
  });

  it('a connection that starts with neither a frame nor a method letter is refused', async () => {
    const out = await new Promise<Buffer>((resolve) => {
      const c = net.createConnection({ path: daemon.socket });
      const chunks: Buffer[] = [];
      c.on('data', (d: Buffer) => chunks.push(d));
      c.on('close', () => resolve(Buffer.concat(chunks)));
      c.write('\u0001garbage');
    });
    expect(out.subarray(4).toString()).toContain('bad-frame');
  });
});

describe('service mode on TCP', () => {
  const auth = { authorization: `Bearer ${TOKEN}`, 'oort-project': '-' };

  it('takes nothing without the token, and acts in the token org', async () => {
    expect((await request('GET', '/v1/whoami', {}, undefined, true)).status).toBe(401);
    const wrong = await request(
      'GET',
      '/v1/whoami',
      { authorization: 'Bearer nope', 'oort-project': '-' },
      undefined,
      true,
    );
    expect(wrong.body.error?.['reason']).toBe('token-rejected');
    const ok = await request('GET', '/v1/whoami', { ...auth, 'oort-user': 'u1' }, undefined, true);
    expect(ok.body.data).toMatchObject({ user: 'u1', writesTo: 'Planet u1' });
    expect((await request('GET', '/healthz', {}, undefined, true)).status).toBe(200);
  });

  it('needs Oort-User on every memory route: a missing one never acts as the org', async () => {
    const tcp = (h: Record<string, string>, route = '/v1/whoami') =>
      request('GET', route, h, undefined, true);
    for (const route of ['/v1/whoami', '/v1/memories']) {
      const none = await tcp(auth, route);
      expect([none.status, none.body.error?.['code'], none.body.error?.['reason']]).toEqual([
        400,
        'usage',
        'user-missing',
      ]);
    }
    const post = await request('POST', '/v1/recall', auth, JSON.stringify({ query: 'q' }), true);
    expect(post.body.error?.['reason']).toBe('user-missing');
    // Deliberate org-level memory says so; the agent may be named with it.
    const org = await tcp({ ...auth, 'oort-user': '-' });
    expect(org.status).toBe(200);
    expect(org.body.data?.['user']).toBeNull();
    const agent = await tcp({ ...auth, 'oort-user': '-', 'oort-agent': 'bot' });
    expect(agent.body.data).toMatchObject({ agent: 'bot', user: null });
    // The health handshake needs no user; an empty one is still the SDK's user-missing.
    expect((await tcp(auth, '/v1/health')).status).toBe(200);
    expect((await tcp({ ...auth, 'oort-user': '' })).body.error?.['reason']).toBe('user-missing');
  });

  it('answers a loopback listener only under its own Host', async () => {
    const tcp = (host: string) =>
      request('GET', '/v1/whoami', { ...auth, 'oort-user': 'u1', host }, undefined, true);
    const port = daemon.tcp!.port;
    for (const bad of [
      'evil.example',
      `evil.example:${port}`,
      '127.0.0.1',
      `localhost:${port + 1}`,
    ]) {
      const r = await tcp(bad);
      expect([r.status, r.body.error?.['reason']], bad).toEqual([403, 'host-refused']);
    }
    for (const good of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      expect((await tcp(good)).status, good).toBe(200);
    }
    expect(allowedHost('[::1]:7807', '::1', 7807)).toBe(true);
    expect(allowedHost('[::1]:7808', '::1', 7807)).toBe(false);
    expect(allowedHost(undefined, '127.0.0.1', 7807)).toBe(false);
  });

  it('refuses a cwd, an org, an expert role and a missing project', async () => {
    const tcp = (h: Record<string, string>) => request('GET', '/v1/whoami', h, undefined, true);
    expect((await tcp({ ...auth, 'oort-cwd': '/etc' })).status).toBe(400);
    expect((await tcp({ ...auth, 'oort-org': 'other' })).status).toBe(400);
    expect(
      (await tcp({ ...auth, 'oort-user': 'u1', 'oort-judge-role': 'expert' })).body.error?.[
        'reason'
      ],
    ).toBe('expert-only');
    expect((await tcp({ authorization: auth.authorization })).status).toBe(400);
  });

  it('compares tokens by digest, accepting either of two', () => {
    const d = [digestOf(TOKEN), digestOf('B'.repeat(43))];
    expect(tokenMatches(`Bearer ${TOKEN}`, d)).toBe(true);
    expect(tokenMatches(`Bearer ${'B'.repeat(43)}`, d)).toBe(true);
    expect(tokenMatches(`Bearer ${TOKEN}x`, d)).toBe(false);
    expect(tokenMatches(`bearer ${TOKEN}`, d)).toBe(true);
    expect(tokenMatches(`BEARER ${TOKEN}`, d)).toBe(true);
    expect(tokenMatches(`Basic ${TOKEN}`, d)).toBe(false);
    expect(tokenMatches(undefined, d)).toBe(false);
    expect(tokenMatches('Bearer ', d)).toBe(false);
  });
});

describe('rotating the service token under a running service', () => {
  it('stops the old token on the next request and starts the new one, with no restart', async () => {
    const base = tmpdir('oort-rot-');
    const h = path.join(base, 'home');
    fs.mkdirSync(h, { recursive: true, mode: 0o700 });
    writeTokenFile(h, false);
    const first = fs.readFileSync(tokenPathFor(h), 'utf8').trim();
    const settings = serviceSettings({ listen: '127.0.0.1:0', org: 'acme' }, {}, h);
    const d = await startDaemon({
      home: h,
      env: { HOME: base, OORT_HOME: h, OORT_NO_KEYCHAIN: '1' },
      wire,
      version: VERSION,
      idleMs: 600_000,
      spawnDrain: () => {},
      log: () => {},
      warmCwd: base,
      createHandle: (o) => createOortWith(o, { adapters: fakeAdapters() }),
      listen: { host: settings.host, port: settings.port, auth: settings.auth },
    });
    try {
      const get = (token: string): Promise<number> =>
        new Promise((resolve, reject) => {
          const port = d.tcp!.port;
          http
            .get(
              {
                host: '127.0.0.1',
                port,
                path: '/v1/whoami',
                headers: {
                  authorization: `Bearer ${token}`,
                  'oort-project': '-',
                  'oort-user': 'u1',
                },
              },
              (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
              },
            )
            .on('error', reject);
        });
      expect(await get(first)).toBe(200);
      writeTokenFile(h, true);
      const second = fs.readFileSync(tokenPathFor(h), 'utf8').trim();
      expect(second).not.toBe(first);
      expect(await get(first)).toBe(401);
      expect(await get(second)).toBe(200);
      // A token file that is gone accepts nothing (fails closed), and works again once it is back.
      fs.rmSync(tokenPathFor(h));
      expect(await get(second)).toBe(401);
      writeTokenFile(h, false);
      expect(await get(second)).toBe(401);
      expect(await get(fs.readFileSync(tokenPathFor(h), 'utf8').trim())).toBe(200);
    } finally {
      await d.stop('test');
    }
  });

  it('follows a kubelet secret rotation (..data swapped, the old directory deleted) with no restart', async () => {
    const base = sealed('oort-kube-');
    const h = path.join(base, 'home');
    fs.mkdirSync(h, { recursive: true, mode: 0o700 });
    // The layout a kubelet mounts: token -> ..data/token, ..data -> ..<generation>.
    const mount = path.join(base, 'secret');
    const generation = (name: string, token: string): void => {
      const dir = path.join(mount, name);
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      fs.chmodSync(dir, 0o755);
      fs.writeFileSync(path.join(dir, 'token'), `${token}\n`, { mode: 0o640 });
    };
    const first = 'A'.repeat(43);
    const second = 'B'.repeat(43);
    generation('..a', first);
    fs.symlinkSync('..a', path.join(mount, '..data'));
    fs.symlinkSync(path.join('..data', 'token'), path.join(mount, 'token'));
    const env = { OORT_SERVE_TOKEN_FILE: path.join(mount, 'token') };
    const settings = serviceSettings({ listen: '127.0.0.1:0', org: 'acme' }, env, h);
    const d = await startDaemon({
      home: h,
      env: { HOME: base, OORT_HOME: h, OORT_NO_KEYCHAIN: '1' },
      wire,
      version: VERSION,
      idleMs: 600_000,
      spawnDrain: () => {},
      log: () => {},
      warmCwd: base,
      createHandle: (o) => createOortWith(o, { adapters: fakeAdapters() }),
      listen: { host: settings.host, port: settings.port, auth: settings.auth },
    });
    try {
      const get = (token: string): Promise<number> =>
        new Promise((resolve, reject) => {
          http
            .get(
              {
                host: '127.0.0.1',
                port: d.tcp!.port,
                path: '/v1/whoami',
                headers: {
                  authorization: `Bearer ${token}`,
                  'oort-project': '-',
                  'oort-user': 'u1',
                },
              },
              (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
              },
            )
            .on('error', reject);
        });
      expect(await get(first)).toBe(200);
      // The kubelet's atomic swap: a new generation, a new link, a rename over ..data, then the
      // old generation is deleted.
      generation('..b', second);
      fs.symlinkSync('..b', path.join(mount, '..data_tmp'));
      fs.renameSync(path.join(mount, '..data_tmp'), path.join(mount, '..data'));
      fs.rmSync(path.join(mount, '..a'), { recursive: true });
      expect(await get(second)).toBe(200);
      expect(await get(first)).toBe(401);
    } finally {
      await d.stop('test');
    }
  });

  it('forceReload (SIGHUP) reads the file again even when its stat did not change', () => {
    const h = path.join(tmpdir('oort-hup-'), 'home');
    fs.mkdirSync(h, { recursive: true, mode: 0o700 });
    writeTokenFile(h, false);
    const t = serviceTokens({}, h);
    const before = t.reload!();
    expect(before).toHaveLength(1);
    t.forceReload!();
    expect(t.reload!()).toHaveLength(1);
    expect(serviceTokens({ OORT_SERVE_TOKEN: TOKEN }, h).reload).toBeUndefined();
  });
});

describe('OORT_SERVE_TOKEN_FILE', () => {
  const make = (mode: number, dirMode = 0o755) => {
    const dir = path.join(sealed('oort-tf-'), 'secret');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, dirMode);
    const file = path.join(dir, 'token');
    fs.writeFileSync(file, `${TOKEN}\n`, { mode });
    fs.chmodSync(file, mode);
    return { dir, file };
  };
  const h = path.join(sealed('oort-tfh-'), 'home');

  it('takes a private or group-readable file, and a link to it (an orchestrator mount)', () => {
    for (const mode of [0o600, 0o640, 0o440]) {
      const { file } = make(mode);
      expect(serviceDigests({ OORT_SERVE_TOKEN_FILE: file }, h)).toHaveLength(1);
    }
    const { dir, file } = make(0o600);
    const link = path.join(dir, 'mounted');
    fs.symlinkSync(file, link);
    expect(serviceDigests({ OORT_SERVE_TOKEN_FILE: link }, h)).toHaveLength(1);
  });

  it('refuses a file others or the group can write, others can read, or in a directory others can write', () => {
    for (const mode of [0o620, 0o660, 0o602, 0o644, 0o604]) {
      const { file } = make(mode);
      expect(() => serviceDigests({ OORT_SERVE_TOKEN_FILE: file }, h), mode.toString(8)).toThrow(
        /others could read or change/,
      );
    }
    const open = make(0o600, 0o777);
    expect(() => serviceDigests({ OORT_SERVE_TOKEN_FILE: open.file }, h)).toThrow(/directory/);
    expect(() => serviceDigests({ OORT_SERVE_TOKEN_FILE: 'relative' }, h)).toThrow(/absolute/);
  });

  it('refuses a group-writable directory unless its group is root (or admin on macOS), by number', () => {
    for (const dirMode of [0o775, 0o770, 0o720]) {
      const { dir, file } = make(0o640, dirMode);
      const gid = fs.statSync(dir).gid;
      const call = () => serviceDigests({ OORT_SERVE_TOKEN_FILE: file }, h);
      // Only gid 0 (and 80 on macOS) may hold group write: never a private group, never a name.
      if (gid === 0 || (process.platform === 'darwin' && gid === 80)) expect(call).not.toThrow();
      else expect(call, dirMode.toString(8)).toThrow(/directory/);
    }
    const { file } = make(0o640, 0o750);
    expect(serviceDigests({ OORT_SERVE_TOKEN_FILE: file }, h)).toHaveLength(1);
  });

  const sharedTmp = ((): string | undefined => {
    if (process.platform === 'win32') return undefined;
    try {
      const real = fs.realpathSync('/tmp');
      const st = fs.statSync(real);
      return st.uid === 0 && (st.mode & 0o1002) === 0o1002 ? real : undefined;
    } catch {
      return undefined;
    }
  })();

  it.skipIf(sharedTmp === undefined)(
    "takes a link in a root-owned sticky directory (/tmp) only if the link is the user's or root's",
    () => {
      const dir = fs.mkdtempSync(path.join(sharedTmp!, 'oort-st-'));
      try {
        fs.chmodSync(dir, 0o755);
        const target = path.join(dir, 'token');
        fs.writeFileSync(target, `${TOKEN}\n`, { mode: 0o640 });
        const link = path.join(sharedTmp!, `oort-st-link-${path.basename(dir)}`);
        fs.symlinkSync(target, link);
        try {
          // Ours, in the shared directory: taken.
          expect(readTokenFile(link, 0o027, true)).toContain(TOKEN);
          // The same link, seen by a process that is another user: refused, whatever the target.
          const me = process.getuid!();
          expect(() => readTokenFile(link, 0o027, true, undefined, { uid: me + 1 })).toThrow(
            /belongs to another user/,
          );
        } finally {
          fs.rmSync(link, { force: true });
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('refuses a link held in a directory others can write, though its target is safe', () => {
    const { file } = make(0o640);
    const folder = path.join(sealed('oort-wl-'), 'links');
    fs.mkdirSync(folder);
    fs.chmodSync(folder, 0o777);
    const link = path.join(folder, 'token');
    fs.symlinkSync(file, link);
    expect(() => serviceDigests({ OORT_SERVE_TOKEN_FILE: link }, h)).toThrow(/directory/);
    // Closing the folder makes the same link acceptable.
    fs.chmodSync(folder, 0o755);
    expect(serviceDigests({ OORT_SERVE_TOKEN_FILE: link }, h)).toHaveLength(1);
  });

  it('refuses a file swapped for another between the checks and the open (device and inode differ)', () => {
    const { dir, file } = make(0o640);
    const swap = () => {
      const other = path.join(dir, 'other');
      fs.writeFileSync(other, `${'C'.repeat(43)}\n`, { mode: 0o640 });
      fs.renameSync(other, file);
    };
    expect(readTokenFile(file, 0o027, true)).toContain(TOKEN);
    expect(() => readTokenFile(file, 0o027, true, swap)).toThrow(/changed while/);
  });

  it('fails closed and logs a reason, never the token, when the path becomes unsafe', () => {
    const { dir, file } = make(0o640);
    const lines: string[] = [];
    const t = serviceTokens({ OORT_SERVE_TOKEN_FILE: file }, h);
    expect(t.digests).toHaveLength(1);
    fs.chmodSync(dir, 0o757);
    t.forceReload!();
    expect(t.reload!((l) => lines.push(l))).toHaveLength(0);
    const text = lines.join('\n');
    expect(text).toMatch(/refusing every request/);
    expect(text).not.toContain(TOKEN);
  });
});

describe('service settings', () => {
  it('parses addresses, IP literals only, a bare port on loopback', () => {
    expect(parseListen('7807')).toEqual({ host: '127.0.0.1', port: 7807 });
    expect(parseListen('localhost:1')).toEqual({ host: '127.0.0.1', port: 1 });
    expect(parseListen('[::1]:7807')).toEqual({ host: '::1', port: 7807 });
    for (const bad of ['example.com:80', '1.2.3.4', ':80', '127.0.0.1:99999', '']) {
      expect(() => parseListen(bad), bad).toThrow();
    }
    expect(isLoopback('127.0.0.2')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(false);
  });

  it('refuses a public address without a TLS proxy, a missing or local org, and weak tokens', () => {
    const h = path.join(tmpdir('oort-svc-'), 'home');
    fs.mkdirSync(h, { recursive: true, mode: 0o700 });
    const env = { OORT_SERVE_TOKEN: TOKEN };
    expect(() => serviceSettings({ listen: '0.0.0.0:7807', org: 'acme' }, env, h)).toThrow(
      /TLS proxy/,
    );
    expect(
      serviceSettings({ listen: '0.0.0.0:7807', org: 'acme', behindTlsProxy: true }, env, h).host,
    ).toBe('0.0.0.0');
    expect(() => serviceSettings({ listen: '7807' }, env, h)).toThrow(/org/);
    expect(() => serviceSettings({ listen: '7807', org: 'local' }, env, h)).toThrow(/other than/);
    expect(() => serviceDigests({ OORT_SERVE_TOKEN: 'short' }, h)).toThrow(/43 characters/);
    expect(() => serviceDigests({ OORT_SERVE_TOKEN: `${TOKEN},${TOKEN},${TOKEN}` }, h)).toThrow();
    expect(serviceDigests({ OORT_SERVE_TOKEN: `${TOKEN}, ${'B'.repeat(43)}` }, h)).toHaveLength(2);
  });

  it('writes the token file 0600, keeps it unless rotated, and refuses it when others can read it', () => {
    const h = path.join(tmpdir('oort-tok-'), 'home');
    fs.mkdirSync(h, { recursive: true, mode: 0o700 });
    expect(() => serviceDigests({}, h)).toThrow(/oort serve token/);
    const first = writeTokenFile(h, false);
    expect(first.created).toBe(true);
    expect(fs.statSync(first.file).mode & 0o777).toBe(0o600);
    const token = fs.readFileSync(first.file, 'utf8').trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(writeTokenFile(h, false).created).toBe(false);
    expect(fs.readFileSync(first.file, 'utf8').trim()).toBe(token);
    expect(serviceDigests({}, h)[0]).toEqual(digestOf(token));
    fs.chmodSync(first.file, 0o644);
    expect(() => serviceDigests({}, h)).toThrow(/chmod 600/);
    fs.chmodSync(first.file, 0o600);
    expect(writeTokenFile(h, true).created).toBe(true);
    expect(fs.readFileSync(first.file, 'utf8').trim()).not.toBe(token);
    // A symlinked token file in the home is never followed.
    const elsewhere = path.join(h, '..', 'elsewhere.token');
    fs.writeFileSync(elsewhere, `${TOKEN}\n`, { mode: 0o600 });
    fs.rmSync(tokenPathFor(h));
    fs.symlinkSync(elsewhere, tokenPathFor(h));
    expect(() => serviceDigests({}, h)).toThrow(/symlink/);
  });
});
