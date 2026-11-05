import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { RecallResult } from '@oortmem/core';
import * as undici from 'undici';
import {
  closeCloudPool,
  connectedSince,
  createDispatcher,
  proxyFrom,
  keepAliveFetch,
  parseServerTiming,
  timedFetch,
  warmCloud,
} from './cloud-http.js';
import { RECALL_TEXT_MAX_BYTES, clipRecallText, cloudRemote } from './cloud-remote.js';
import { createCloudClient, withCloudTimings, type CloudClient } from './cloud.js';
import { KeepWarm } from './serve-daemon.js';
import type { Wired } from './wire.js';

/** A local HTTP server that counts the TCP connections it accepts and the paths it serves. */
async function server(
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_q, res) =>
    res.end('{"ok":true}'),
): Promise<{
  url: string;
  connections: () => number;
  paths: string[];
  close: () => Promise<void>;
}> {
  let connections = 0;
  const paths: string[] = [];
  const srv = http.createServer((req, res) => {
    paths.push(req.url ?? '');
    handle(req, res);
  });
  srv.keepAliveTimeout = 60_000;
  srv.on('connection', () => connections++);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => connections,
    paths,
    close: () =>
      new Promise((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  };
}

/** Lets the pool take the connection back after a response (as seconds between prompts do). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await closeCloudPool();
  for (const c of closers.splice(0)) await c();
});

describe('cloud-http (CON-101)', () => {
  it('cloud-http.server-timing-keeps-durations-only', () => {
    expect(parseServerTiming('auth;dur=12.5, do;dur=830, total;dur=901.2')).toEqual({
      auth: 12.5,
      do: 830,
      total: 901.2,
    });
    // Descriptions are dropped; metrics without a duration, odd names and junk are ignored.
    expect(
      parseServerTiming('cache;desc="hit";dur=3, miss, bad name;dur=1, x;dur=abc, ok;dur=1'),
    ).toEqual({ cache: 3, ok: 1 });
    expect(parseServerTiming(null)).toEqual({});
    const many = Array.from({ length: 40 }, (_, i) => `m${i};dur=1`).join(', ');
    expect(Object.keys(parseServerTiming(many))).toHaveLength(32);
  });

  it('cloud-http.the-keep-alive-pool-reuses-one-connection', async () => {
    const s = await server();
    closers.push(s.close);
    const t0 = performance.now();
    await (await keepAliveFetch(`${s.url}/a`)).text();
    const first = connectedSince(t0);
    expect(first).toBeDefined();
    expect(first?.tcpMs).toBeTypeOf('number');
    await settle();
    const t1 = performance.now();
    await (await keepAliveFetch(`${s.url}/b`)).text();
    await settle();
    await (await keepAliveFetch(`${s.url}/c`)).text();
    expect(connectedSince(t1)).toBeUndefined();
    expect(s.connections()).toBe(1);
    expect(s.paths).toEqual(['/a', '/b', '/c']);
  });

  it('cloud-http.the-timed-pool-records-the-connection-it-opens', async () => {
    const s = await server();
    closers.push(s.close);
    const t0 = performance.now();
    await (await timedFetch(`${s.url}/x`)).text();
    expect(connectedSince(t0)).toBeDefined();
  });

  it('cloud-http.warm-opens-the-connection-with-health-and-never-rejects', async () => {
    const s = await server();
    closers.push(s.close);
    await warmCloud(s.url);
    await settle();
    await (await keepAliveFetch(`${s.url}/v1/recall`)).text();
    expect(s.paths).toEqual(['/health', '/v1/recall']);
    expect(s.connections()).toBe(1);
    // Nothing listens there: a warm-up that fails is silent.
    await expect(warmCloud('http://127.0.0.1:9', 500)).resolves.toBeUndefined();
  });

  it('cloud-http.keep-warm-refreshes-an-idle-connection-for-a-while-after-a-prompt', async () => {
    const s = await server();
    closers.push(s.close);
    const w = { mode: 'cloud', cloud: { url: s.url } } as unknown as Wired;
    const warm = new KeepWarm(Date.now, 40, 300);
    warm.start(w);
    await new Promise((r) => setTimeout(r, 200));
    const during = s.paths.filter((p) => p === '/health').length;
    expect(during).toBeGreaterThanOrEqual(3);
    // Past `forMs` without a prompt, it stops.
    await new Promise((r) => setTimeout(r, 400));
    const after = s.paths.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(s.paths.length).toBe(after);
    expect(s.connections()).toBe(1);
    warm.stop();
  });

  it('cloud-http.keep-warm-ignores-a-local-engine-and-stops-for-good', async () => {
    const s = await server();
    closers.push(s.close);
    const warm = new KeepWarm(Date.now, 20, 1000);
    warm.start({ mode: 'local' } as unknown as Wired);
    warm.start({ mode: 'cloud' } as unknown as Wired); // cloud mode without a client
    await new Promise((r) => setTimeout(r, 80));
    expect(s.paths).toEqual([]);
    warm.stop();
    warm.touch({ mode: 'cloud', cloud: { url: s.url } } as unknown as Wired);
    await new Promise((r) => setTimeout(r, 80));
    expect(s.paths).toEqual([]);
  });
});

describe('the cloud client reports where a recall went (CON-101)', () => {
  const result = (timings: Record<string, number>): RecallResult =>
    ({ memories: [], timings, temporal: { mode: 'current', inferred: true } }) as never;

  it('cloud.timings-are-added-beside-the-apis-own', () => {
    const r = withCloudTimings(result({ embedMs: 280, rerankMs: 260, totalMs: 560 }), {
      connected: true,
      dnsMs: 10,
      tcpMs: 20,
      tlsMs: 30,
      headersMs: 900,
      bodyMs: 2,
      totalMs: 902,
      server: { auth: 40, do: 700, 'hive-legs': 3 },
    });
    expect(r.timings).toEqual({
      embedMs: 280,
      rerankMs: 260,
      totalMs: 560,
      cloudRecallMs: 560,
      cloudMs: 902,
      cloudHeadersMs: 900,
      cloudBodyMs: 2,
      cloudConnected: 1,
      cloudDnsMs: 10,
      cloudTcpMs: 20,
      cloudTlsMs: 30,
      serverAuthMs: 40,
      serverDoMs: 700,
      serverHivelegsMs: 3,
    });
  });

  it('cloud.the-timing-header-is-sent-only-when-asked', async () => {
    const seen: (string | null)[] = [];
    const fake = (async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('x-oort-timing'));
      return Response.json(result({ totalMs: 5 }), {
        headers: { 'server-timing': 'auth;dur=4, do;dur=9' },
      });
    }) as unknown as typeof fetch;
    const key = ['oort', 'sk', 'timing'.padEnd(43, 'T')].join('_');
    const plain = createCloudClient({ url: 'https://api.example', key, fetch: fake });
    const asked = createCloudClient({
      url: 'https://api.example',
      key,
      fetch: fake,
      serverTiming: true,
    });
    const a = await plain.recall({ text: 'where is it' });
    const b = await asked.recall({ text: 'where is it' });
    expect(seen).toEqual([null, '1']);
    expect(a.timings['cloudMs']).toBeTypeOf('number');
    // An injected fetch says nothing about connections.
    expect(a.timings).not.toHaveProperty('cloudConnected');
    expect(b.timings['serverDoMs']).toBe(9);
  });
});

describe('the prompt hook recall in cloud mode (CON-101)', () => {
  const bytes = (s: string): number => new TextEncoder().encode(s).byteLength;

  it('cloud.a-long-prompt-is-clipped-to-what-the-api-reads', () => {
    expect(clipRecallText('short question')).toBe('short question');
    const long = `${'log line '.repeat(400)}so why does the deploy fail?`;
    const clipped = clipRecallText(long);
    expect(bytes(clipped)).toBeLessThanOrEqual(RECALL_TEXT_MAX_BYTES);
    expect(clipped.startsWith('log line')).toBe(true);
    expect(clipped.endsWith('so why does the deploy fail?')).toBe(true);
    // Multi-byte characters are never split.
    const wide = 'é'.repeat(3000) + '漢字'.repeat(500);
    const w = clipRecallText(wide);
    expect(bytes(w)).toBeLessThanOrEqual(RECALL_TEXT_MAX_BYTES);
    expect(w).not.toContain('�');
    expect(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(w))).toBe(w);
  });

  it('cloud.prompt-mode-says-what-the-api-may-skip', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = {
      recall: async (q: Record<string, unknown>) => {
        bodies.push(q);
        return { memories: [], timings: {} };
      },
    } as unknown as CloudClient;
    for (const mode of ['full', 'fast', 'lexical'] as const) {
      await cloudRemote(client, undefined, undefined, undefined, mode).recall({
        text: 'x'.repeat(5000),
        projectId: 'p',
      });
    }
    expect(bodies.map(({ rerank, embed }) => ({ rerank, embed }))).toEqual([
      { rerank: undefined, embed: undefined },
      { rerank: false, embed: undefined },
      { rerank: false, embed: false },
    ]);
    for (const b of bodies) expect(bytes(b['text'] as string)).toBeLessThanOrEqual(2048);
  });
});

describe('the pool behind a proxy (CON-101)', () => {
  it('cloud-http.a-proxy-in-the-environment-selects-the-env-proxy-agent', async () => {
    expect(proxyFrom({})).toBeUndefined();
    expect(proxyFrom({ HTTPS_PROXY: '' })).toBeUndefined();
    expect(
      proxyFrom({ https_proxy: 'http://proxy.invalid:3128', NO_PROXY: 'localhost,.internal' }),
    ).toEqual({ httpsProxy: 'http://proxy.invalid:3128', noProxy: 'localhost,.internal' });
    for (const kind of ['keep-alive', 'timed'] as const) {
      const direct = createDispatcher(undici, kind, {});
      expect(direct.proxied).toBe(false);
      expect(direct.dispatcher).toBeInstanceOf(undici.Agent);
      expect(direct.dispatcher).not.toBeInstanceOf(undici.EnvHttpProxyAgent);
      const viaProxy = createDispatcher(undici, kind, { HTTPS_PROXY: 'http://proxy.invalid:3128' });
      expect(viaProxy.proxied).toBe(true);
      expect(viaProxy.dispatcher).toBeInstanceOf(undici.EnvHttpProxyAgent);
      await direct.dispatcher.close();
      await viaProxy.dispatcher.close();
    }
  });

  it('cloud-http.no-proxy-hosts-go-direct', async () => {
    const s = await server();
    closers.push(s.close);
    // Nothing listens on the "proxy": a request sent to it fails, one that goes direct answers.
    const dead = 'http://127.0.0.1:9';
    const bypass = createDispatcher(undici, 'keep-alive', {
      HTTP_PROXY: dead,
      NO_PROXY: '127.0.0.1',
    });
    const r = await undici.fetch(`${s.url}/direct`, { dispatcher: bypass.dispatcher });
    expect(await r.text()).toBe('{"ok":true}');
    const proxiedOnly = createDispatcher(undici, 'keep-alive', { HTTP_PROXY: dead });
    await expect(
      undici.fetch(`${s.url}/via-proxy`, { dispatcher: proxiedOnly.dispatcher }),
    ).rejects.toThrow();
    expect(s.paths).toEqual(['/direct']);
    await bypass.dispatcher.close();
    await proxiedOnly.dispatcher.close();
  });
});

describe('clipping at the 2 KB boundary (CON-101)', () => {
  const enc = new TextEncoder();
  const bytes = (s: string): number => enc.encode(s).byteLength;
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const valid = (s: string): void => {
    expect(bytes(s)).toBeLessThanOrEqual(RECALL_TEXT_MAX_BYTES);
    expect(s).not.toMatch(loneSurrogate);
    expect(new TextDecoder('utf-8', { fatal: true }).decode(enc.encode(s))).toBe(s);
  };

  it('cloud.clip-exactly-at-the-limit-and-one-byte-over', () => {
    const at = 'a'.repeat(RECALL_TEXT_MAX_BYTES - 4) + '😀';
    expect(bytes(at)).toBe(RECALL_TEXT_MAX_BYTES);
    expect(clipRecallText(at)).toBe(at);
    const over = `b${at}`;
    expect(bytes(over)).toBe(RECALL_TEXT_MAX_BYTES + 1);
    const c = clipRecallText(over);
    valid(c);
    expect(c).not.toBe(over);
  });

  it('cloud.clip-never-splits-a-surrogate-pair-at-the-cut', () => {
    // The head keeps half of what the ellipsis leaves (2043 bytes): 1021. An emoji (4 bytes, a
    // surrogate pair) starting at byte 1019 straddles that cut, and one in the tail likewise.
    for (const pad of [1017, 1018, 1019, 1020, 1021]) {
      const text =
        'h'.repeat(pad) + '👩‍💻'.repeat(40) + 'm'.repeat(600) + '🎉'.repeat(300) + 't'.repeat(pad);
      expect(bytes(text)).toBeGreaterThan(RECALL_TEXT_MAX_BYTES);
      const c = clipRecallText(text);
      valid(c);
      expect(c.startsWith('h'.repeat(pad))).toBe(true);
      expect(c.endsWith('t'.repeat(Math.min(pad, 1000)))).toBe(true);
    }
  });

  it('cloud.clip-mixed-multibyte-text', () => {
    for (const unit of ['é', '漢字', '𝄞', 'ab😀', 'Ελληνικά ', '🇳🇴']) {
      for (const extra of [0, 1, 2, 3]) {
        const text = 'x'.repeat(extra) + unit.repeat(Math.ceil(3000 / bytes(unit)));
        valid(clipRecallText(text));
      }
    }
  });
});
