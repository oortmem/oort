import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '@oortmem/core';
import { tmpdir } from '../test/helpers.js';
import { fakeAdapters } from '../test/helpers/sdk-fakes.js';
import { createOortWith } from './sdk/create.js';
import type { OortOptions } from './sdk/types.js';
import { callDaemon } from './serve-client.js';
import { startDaemon, type Daemon } from './serve-daemon.js';
import { MAX_BODY_BYTES, digestOf, tokenMatches } from './serve-http.js';
import {
  isLoopback,
  parseListen,
  serviceDigests,
  serviceSettings,
  tokenPathFor,
  writeTokenFile,
} from './serve-token.js';
import { wire } from './wire.js';

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

  it('refuses a cwd, an org, an expert role and a missing project', async () => {
    const tcp = (h: Record<string, string>) => request('GET', '/v1/whoami', h, undefined, true);
    expect((await tcp({ ...auth, 'oort-cwd': '/etc' })).status).toBe(400);
    expect((await tcp({ ...auth, 'oort-org': 'other' })).status).toBe(400);
    expect((await tcp({ ...auth, 'oort-judge-role': 'expert' })).body.error?.['reason']).toBe(
      'expert-only',
    );
    expect((await tcp({ authorization: auth.authorization })).status).toBe(400);
  });

  it('compares tokens by digest, accepting either of two', () => {
    const d = [digestOf(TOKEN), digestOf('B'.repeat(43))];
    expect(tokenMatches(`Bearer ${TOKEN}`, d)).toBe(true);
    expect(tokenMatches(`Bearer ${'B'.repeat(43)}`, d)).toBe(true);
    expect(tokenMatches(`Bearer ${TOKEN}x`, d)).toBe(false);
    expect(tokenMatches(`bearer ${TOKEN}`, d)).toBe(false);
    expect(tokenMatches(undefined, d)).toBe(false);
    expect(tokenMatches('Bearer ', d)).toBe(false);
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
