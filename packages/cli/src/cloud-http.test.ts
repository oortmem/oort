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
  lexicalFirstOf,
  parseServerTiming,
  timedFetch,
  warmCloud,
} from './cloud-http.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RECALL_TEXT_MAX_BYTES,
  clipRecallText,
  cloudRemote,
  gateMissSupport,
} from './cloud-remote.js';
import { OortCloudError, createCloudClient, withCloudTimings, type CloudClient } from './cloud.js';
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

/** Waits until `ok()` holds, polling; fails the test after `ms`. */
async function waitFor(ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
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

  it(
    'cloud-http.keep-warm-refreshes-an-idle-connection-for-a-while-after-a-prompt',
    { timeout: 30_000 },
    async () => {
      // Each /health waits for the test to answer it, and the clock is the test's: `forMs` passes
      // between two given refreshes, however slowly a busy machine runs the timers.
      const held: (() => void)[] = [];
      const s = await server((req, res) => {
        if (req.url === '/health') held.push(() => res.end('{"ok":true}'));
        else res.end('{"ok":true}');
      });
      closers.push(s.close);
      const health = (): number => s.paths.filter((p) => p === '/health').length;
      const answerNext = async (n: number): Promise<void> => {
        await waitFor(() => health() >= n);
        held.shift()?.();
      };
      let now = 0;
      const w = { mode: 'cloud', cloud: { url: s.url } } as unknown as Wired;
      const warm = new KeepWarm(() => now, 40, 300);
      warm.start(w);
      // It repeats: the warm-up, then a refresh after each answer.
      await answerNext(1);
      await answerNext(2);
      await waitFor(() => health() >= 3);
      // Past `forMs` without a prompt, the refresh in flight is the last one.
      now = 300;
      held.shift()?.();
      await new Promise((r) => setTimeout(r, 400)); // ten intervals: a fourth would be here by now
      expect(health()).toBe(3);
      expect(held).toEqual([]);
      expect(s.connections()).toBe(1);
      warm.stop();
    },
  );

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

  it('cloud.gate-miss-rerank-is-asked-for-only-in-fast-mode-and-only-when-on', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = {
      recall: async (q: Record<string, unknown>) => {
        bodies.push(q);
        return { memories: [], timings: {} };
      },
    } as unknown as CloudClient;
    const cases = [
      ['fast', true],
      ['fast', false],
      ['fast', undefined],
      ['full', true],
      ['lexical', true],
    ] as const;
    for (const [mode, gateMiss] of cases) {
      await cloudRemote(client, undefined, undefined, undefined, mode, undefined, gateMiss).recall({
        text: 'qué puerto usa el servicio de cobros',
      });
    }
    expect(bodies.map((b) => ('rerank' in b ? b['rerank'] : 'absent'))).toEqual([
      'gate-miss',
      false,
      false,
      // `full` reranks anyway; `lexical` has no dense match to make a miss plausible.
      'absent',
      false,
    ]);
  });

  it('cloud.gate-miss-refused-by-an-older-api-falls-back-to-fast-and-is-remembered', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-gm-'));
    const bodies: Record<string, unknown>[] = [];
    // An API from before CON-131: `rerank` must be a boolean.
    const client = {
      url: 'https://api.example.test',
      recall: async (q: Record<string, unknown>) => {
        bodies.push(q);
        if (typeof q['rerank'] !== 'boolean') {
          throw new OortCloudError(
            'bad-request',
            400,
            'rerank must be true or false.',
            'bad_request',
          );
        }
        return { memories: [], timings: {} };
      },
    } as unknown as CloudClient;
    const remote = (support = gateMissSupport(home, client.url)) =>
      cloudRemote(client, undefined, undefined, undefined, 'fast', undefined, true, support);
    // The first prompt still recalls: asked, refused, retried as plain fast.
    const r = await remote().recall({ text: 'qué puerto usa el servicio de cobros' });
    expect(r.memories).toEqual([]);
    expect(bodies.map((b) => b['rerank'])).toEqual(['gate-miss', false]);
    // The next prompt, in this process or a new one (a fresh hook), does not ask again.
    await remote().recall({ text: 'otra pregunta' });
    expect(bodies.slice(2).map((b) => b['rerank'])).toEqual([false]);
    // Another API (a new deploy elsewhere) and a day later are asked again.
    expect(gateMissSupport(home, 'https://other.example.test').refused()).toBe(false);
    expect(gateMissSupport(home, client.url, () => Date.now() + 25 * 3600_000).refused()).toBe(
      false,
    );
  });

  it('cloud.gate-miss-back-off-ignores-a-refusal-dated-in-the-future', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-gm-'));
    const url = 'https://api-future.example.test';
    // A cache file written by a clock running ahead (or edited): it must not keep the back-off
    // on past a day.
    const file = path.join(home, 'cache', 'cloud-gate-miss.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ [url]: Date.now() + 30 * 24 * 3600_000 })}\n`);
    expect(gateMissSupport(home, url).refused()).toBe(false);
    // The same in this process: a refusal remembered at a time after now does not count.
    const ahead = gateMissSupport(home, `${url}/p`, () => Date.now() + 48 * 3600_000);
    ahead.remember();
    expect(gateMissSupport(home, `${url}/p`).refused()).toBe(false);
    // Inside the day it still holds.
    const now = gateMissSupport(home, `${url}/q`);
    now.remember();
    expect(gateMissSupport(home, `${url}/q`, () => Date.now() + 23 * 3600_000).refused()).toBe(
      true,
    );
  });

  it('cloud.only-a-refusal-of-rerank-turns-gate-miss-off', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-gm-'));
    let calls = 0;
    const client = {
      url: 'https://api-two.example.test',
      recall: async () => {
        calls++;
        throw new OortCloudError('bad-request', 400, 'text is required.', 'bad_request');
      },
    } as unknown as CloudClient;
    const support = gateMissSupport(home, client.url);
    await expect(
      cloudRemote(client, undefined, undefined, undefined, 'fast', undefined, true, support).recall(
        { text: 'x' },
      ),
    ).rejects.toThrow(/text is required/);
    expect(calls).toBe(1);
    expect(support.refused()).toBe(false);
  });

  it('cloud.lexical-first-is-sent-as-configured-except-where-nothing-embeds', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = {
      recall: async (q: Record<string, unknown>) => {
        bodies.push(q);
        return { memories: [], timings: {} };
      },
    } as unknown as CloudClient;
    const cases = [
      ['fast', true],
      ['fast', false],
      ['full', true],
      ['fast', undefined],
      ['lexical', true],
    ] as const;
    for (const [mode, lexicalFirst] of cases) {
      await cloudRemote(client, undefined, undefined, undefined, mode, lexicalFirst).recall({
        text: 'which port does auth use',
      });
    }
    expect(bodies.map((b) => ('lexicalFirst' in b ? b['lexicalFirst'] : 'absent'))).toEqual([
      true,
      false,
      true,
      'absent',
      // `lexical` never embeds, so there is nothing to skip.
      'absent',
    ]);
  });

  it('cloud-http.reads-what-lexical-first-decided-from-server-timing', () => {
    expect(lexicalFirstOf('auth;dur=4, lexfirst;desc=hit, total;dur=9')).toBe('hit');
    expect(lexicalFirstOf('lexfirst;desc=miss')).toBe('miss');
    expect(lexicalFirstOf('auth;dur=4, total;dur=9')).toBeUndefined();
    expect(lexicalFirstOf('lexfirst;desc=maybe')).toBeUndefined();
    expect(lexicalFirstOf(null)).toBeUndefined();
    // A description is not a duration: the metrics stay numbers only.
    expect(parseServerTiming('auth;dur=4, lexfirst;desc=hit')).toEqual({ auth: 4 });
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
