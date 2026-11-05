/**
 * How the CLI's requests reach Oort Cloud, and how long each part took (CON-101).
 *
 * A short-lived process (one hook, one command) makes one or two requests and exits: it uses the
 * global fetch, and opening the connection (DNS, TCP, TLS: about 200 ms from Europe) is paid every
 * time. A long-lived process (`oort serve`, `oort mcp`) keeps one pool of connections for its whole
 * life instead, so a warm daemon sends a prompt's recall on a connection that is already open.
 * That pool is undici's, loaded only by the processes that use it (about 50 ms to load).
 *
 * Every request can report where its time went (`CloudTiming`): the connection phases when it
 * opened one, the wait for the first byte, the body, and the API's own `Server-Timing` entries
 * when it sent them. Numbers only: never a header value other than Server-Timing's metrics.
 */

import type { Socket } from 'node:net';

/** Where one request's time went, in milliseconds. */
export interface CloudTiming {
  /** The request opened a new connection (false: it reused a warm one). Known via the pool only. */
  connected?: boolean;
  /** When it connected: DNS lookup, TCP handshake and TLS handshake (only via the pool). */
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  /** Sent to the response headers, the connection's set-up included. */
  headersMs: number;
  /** Response headers to the last byte of the body. */
  bodyMs: number;
  totalMs: number;
  /** The API's Server-Timing metrics (`name;dur=12.3`), when it sent them. */
  server?: Record<string, number>;
}

/**
 * A pooled connection stays open this long without a request. Cloudflare kept an idle client
 * connection open for at least 150 s and closed it within 400 s when measured on 2026-11-05;
 * closing ours first means a request never races the server's close.
 */
export const KEEP_ALIVE_MS = 120_000;

/** The header that asks the API for its Server-Timing breakdown (`OORT_HOOK_TIMING=1`). */
export const TIMING_HEADER = 'x-oort-timing';

const METRIC = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * Server-Timing metrics with a duration, as `{ name: ms }`. Anything else in the header
 * (descriptions, metrics without `dur`, odd names) is dropped; at most 32 metrics.
 */
export function parseServerTiming(header: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (header === null || header === undefined) return out;
  let n = 0;
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.split(';').map((s) => s.trim());
    if (rawName === undefined || !METRIC.test(rawName)) continue;
    for (const p of params) {
      const m = /^dur=(\d+(?:\.\d+)?)$/.exec(p);
      if (m === null) continue;
      out[rawName] = Number(m[1]);
      if (++n >= 32) return out;
      break;
    }
  }
  return out;
}

/** The most recent connection the pool opened, as its connector saw it. */
interface ConnectRecord {
  startedAt: number;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
}

let lastConnect: ConnectRecord | undefined;

/** The connect record of a connection opened since `since` (performance.now()), if any. */
export function connectedSince(since: number): ConnectRecord | undefined {
  return lastConnect !== undefined && lastConnect.startedAt >= since ? lastConnect : undefined;
}

type Pool = { fetch: typeof fetch; close: () => Promise<void> };
/** The keep-alive pool, and the timed one-shot pool `OORT_HOOK_TIMING=1` uses in a short process. */
const pools = new Map<'keep-alive' | 'timed', Promise<Pool>>();

/**
 * A pool of undici connections, loaded on first use. Its connector notes the DNS, TCP and TLS
 * times of every connection it opens (for `CloudTiming`); nothing else is recorded. The timed pool
 * keeps undici's own idle timeout (4 s, as the global fetch does), so timing a request does not
 * change how it connects.
 */
function loadPool(kind: 'keep-alive' | 'timed'): Promise<Pool> {
  let p = pools.get(kind);
  if (p !== undefined) return p;
  p = import('undici').then(({ Agent, buildConnector, fetch: undiciFetch }) => {
    const base = buildConnector({});
    const agent = new Agent({
      ...(kind === 'keep-alive' && {
        keepAliveTimeout: KEEP_ALIVE_MS,
        keepAliveMaxTimeout: KEEP_ALIVE_MS,
      }),
      connect: (opts, cb) => {
        const rec: ConnectRecord = { startedAt: performance.now() };
        lastConnect = rec;
        const since = (): number => performance.now() - rec.startedAt;
        // undici's connector returns the socket it opens (its types say void).
        const socket = base(opts, (...args) => {
          if (args[0] === null) rec.tlsMs = since() - (rec.tcpMs ?? 0) - (rec.dnsMs ?? 0);
          cb(...args);
        }) as unknown as Socket | undefined;
        socket?.once('lookup', () => (rec.dnsMs = since()));
        socket?.once('connect', () => (rec.tcpMs = since() - (rec.dnsMs ?? 0)));
      },
    });
    const f = ((input: string | URL | Request, init?: RequestInit) =>
      undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never)) as never;
    return { fetch: f, close: () => agent.close() };
  });
  pools.set(kind, p);
  return p;
}

const poolFetch = (kind: 'keep-alive' | 'timed'): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) =>
    (await loadPool(kind)).fetch(input, init)) as typeof fetch;

/**
 * A fetch that sends every request through the process's keep-alive pool. The pool loads on the
 * first request; `warmCloud` loads it (and opens the connection) ahead of time.
 */
export const keepAliveFetch: typeof fetch = poolFetch('keep-alive');

/** The global fetch's behaviour (a 4 s idle timeout), with the connection phases timed. */
export const timedFetch: typeof fetch = poolFetch('timed');

/**
 * Opens a pooled connection to the API now, so the next request finds it warm: `GET /health`,
 * which needs no key, reads nothing and is not metered. Best effort, never rejects.
 */
export async function warmCloud(url: string, timeoutMs = 5000): Promise<void> {
  try {
    const res = await keepAliveFetch(`${url}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    await res.arrayBuffer();
  } catch {
    // The first real request opens it instead.
  }
}

/** Closes the pools' connections (a stopping daemon). */
export async function closeCloudPool(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map(async (p) => (await p).close().catch(() => {})));
}
