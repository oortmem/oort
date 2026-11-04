import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Observation } from '@oortmem/core';
import { fakeIo, tmpdir } from '../test/helpers.js';
import { runCli } from './program.js';
import {
  ACCOUNT_URL,
  DEFAULT_RELAY_URL,
  OortRelayError,
  RELAY_MODELS,
  relayErrorOf,
  relayUrl,
} from './relay.js';
import { wire as realWire, type WireOptions } from './wire.js';

/** Assembled at runtime so no key literal sits in a source file. */
const oortKey = (): string => ['oort', 'sk', `test${Date.now()}`.padEnd(43, 'A')].join('_');
const vendorKey = (name: string): string => ['test', name, String(Date.now())].join('-');

const obs: Observation = {
  userText: 'we deploy on port 8443',
  assistantText: 'Noted.',
  toolSummaries: [],
  at: '2026-11-04T10:00:00.000Z',
};

interface Seen {
  url: string;
  auth: string | null;
  apiKey: string | null;
}

/** A fetch that records every request and answers `status` (no request ever leaves the process). */
function recorder(status = 402): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({
      url: req.url,
      auth: req.headers.get('authorization'),
      apiKey: req.headers.get('x-api-key'),
    });
    return Response.json({ error: 'refused by the fake relay' }, { status });
  }) as typeof fetch;
  return { fetch: f, seen };
}

function env(over: Record<string, string> = {}): Record<string, string> {
  const root = tmpdir();
  return { HOME: root, OORT_HOME: path.join(root, 'home'), ...over };
}

async function wired(e: Record<string, string>, opts: WireOptions = {}) {
  return realWire(tmpdir(), { env: e, keychain: async () => undefined, ...opts });
}

/** Calls every adapter once, collecting what each threw. */
async function callAll(w: Awaited<ReturnType<typeof wired>>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  out['embed'] = await w.embed?.embed(['q'], 'query').catch((e: unknown) => e);
  out['rerank'] = await w.rerank?.rerank('q', [{ id: 'a', text: 'a' }], 1).catch((e: unknown) => e);
  out['decide'] = await w.decide?.gate(obs).catch((e: unknown) => e);
  out['write'] = await w.write?.write(obs, 'ADD').catch((e: unknown) => e);
  return out;
}

describe('the oort provider', () => {
  it('pro.oort-key-routes-every-role-through-the-relay', async () => {
    const key = oortKey();
    const r = recorder(402);
    const w = await wired(env({ OORT_API_KEY: key }), { fetch: r.fetch });
    expect(w.unavailable).toEqual({});
    expect(Object.values(w.routes ?? {}).map((x) => [x.role, x.via, x.source])).toEqual([
      ['embed', 'oort', 'env'],
      ['rerank', 'oort', 'env'],
      ['decide', 'oort', 'env'],
      ['write', 'oort', 'env'],
    ]);
    const errors = await callAll(w);
    await w.close();
    expect(r.seen.map((s) => s.url)).toEqual([
      `${DEFAULT_RELAY_URL}/v1/voyage/embeddings`,
      `${DEFAULT_RELAY_URL}/v1/voyage/rerank`,
      `${DEFAULT_RELAY_URL}/v1/typesafe/v1/systemone`,
      `${DEFAULT_RELAY_URL}/v1/anthropic/v1/messages`,
    ]);
    for (const s of r.seen) {
      expect(s.auth).toBe(`Bearer ${key}`);
      expect(s.apiKey).toBeNull();
    }
    for (const [role, e] of Object.entries(errors)) {
      expect(e, role).toBeInstanceOf(OortRelayError);
      expect((e as Error).message, role).toContain(ACCOUNT_URL);
      expect((e as Error).message, role).toContain('402');
      expect((e as Error).message, role).not.toContain(key);
    }
    expect(w.relayErrors?.map((e) => e.kind)).toEqual([
      'payment-required',
      'payment-required',
      'payment-required',
      'payment-required',
    ]);
  });

  it('pro.vendor-key-always-wins-per-role', async () => {
    const key = oortKey();
    const voyage = vendorKey('voyage');
    const r = recorder(402);
    const w = await wired(env({ OORT_API_KEY: key, VOYAGE_API_KEY: voyage }), { fetch: r.fetch });
    expect(w.routes?.embed).toEqual({
      role: 'embed',
      via: 'vendor',
      provider: 'voyage',
      source: 'env',
    });
    expect(w.routes?.write).toMatchObject({ via: 'oort', provider: 'oort' });
    const errors = await callAll(w);
    await w.close();
    expect(r.seen[0]).toMatchObject({
      url: 'https://api.voyageai.com/v1/embeddings',
      auth: `Bearer ${voyage}`,
    });
    expect(r.seen[1]?.url).toBe('https://api.voyageai.com/v1/rerank');
    expect(r.seen[2]?.url).toBe(`${DEFAULT_RELAY_URL}/v1/typesafe/v1/systemone`);
    expect(r.seen[3]).toMatchObject({
      url: `${DEFAULT_RELAY_URL}/v1/anthropic/v1/messages`,
      auth: `Bearer ${key}`,
    });
    // A vendor's own 402 is the vendor's business, not an Oort Pro message.
    expect(errors['embed']).not.toBeInstanceOf(OortRelayError);
    expect(errors['write']).toBeInstanceOf(OortRelayError);
  });

  it('pro.oort-key-from-keychain-item-oort-oort-read-once', async () => {
    const key = oortKey();
    const reads: string[] = [];
    const w = await realWire(tmpdir(), {
      env: env(),
      keychain: async (p) => {
        reads.push(p);
        return p === 'oort' ? key : undefined;
      },
      fetch: recorder().fetch,
    });
    await w.close();
    expect(w.unavailable).toEqual({});
    expect(w.routes?.decide).toMatchObject({ via: 'oort', source: 'keychain' });
    expect(reads.filter((p) => p === 'oort')).toHaveLength(1);
    // The env var beats the Keychain item.
    const reads2: string[] = [];
    const w2 = await realWire(tmpdir(), {
      env: env({ OORT_API_KEY: key }),
      keychain: async (p) => {
        reads2.push(p);
        return undefined;
      },
    });
    await w2.close();
    expect(w2.routes?.embed).toMatchObject({ via: 'oort', source: 'env' });
    expect(reads2).not.toContain('oort');
  });

  it('pro.no-key-at-all-keeps-the-missing-credential-errors', async () => {
    const w = await wired(env());
    await w.close();
    expect(w.embed).toBeUndefined();
    expect(w.unavailable.embed?.message).toContain('oort keys set voyage');
    expect(w.routes?.embed).toEqual({ role: 'embed', via: 'none', provider: 'voyage' });
  });

  it('pro.relay-url-override-for-local-dev', async () => {
    const r = recorder(429);
    const w = await wired(
      env({ OORT_API_KEY: oortKey(), OORT_RELAY_URL: 'http://127.0.0.1:8787/' }),
      { fetch: r.fetch },
    );
    const e = await w.embed?.embed(['q'], 'query').catch((x: unknown) => x);
    await w.close();
    expect(r.seen[0]?.url).toBe('http://127.0.0.1:8787/v1/voyage/embeddings');
    expect(e).toBeInstanceOf(OortRelayError);
    expect((e as OortRelayError).kind).toBe('rate-limit');
    expect((e as Error).message).toContain(ACCOUNT_URL);
  });

  it('pro.cap-429-is-not-retried-by-any-adapter-and-shows-the-relay-message', async () => {
    const cap = 'You have used the 50,000 recalls included in Oort Pro this month.';
    const seen: string[] = [];
    const capped = (async (input: string | URL | Request) => {
      seen.push(new Request(input).url);
      return Response.json({ error: cap }, { status: 429 });
    }) as typeof fetch;
    const w = await wired(env({ OORT_API_KEY: oortKey() }), { fetch: capped });
    const errors = await callAll(w);
    await w.close();
    expect(seen).toHaveLength(4); // one request per role, no retry
    for (const [role, e] of Object.entries(errors)) {
      expect(e, role).toBeInstanceOf(OortRelayError);
      expect((e as Error).message, role).toContain(cap);
      expect((e as Error).message, role).toContain('429');
    }
  });

  it('pro.relay-url-must-be-https-or-loopback', async () => {
    expect(relayUrl({})).toEqual({ url: DEFAULT_RELAY_URL });
    expect(relayUrl({ OORT_RELAY_URL: '' })).toEqual({ url: DEFAULT_RELAY_URL });
    expect(relayUrl({ OORT_RELAY_URL: 'https://relay.example.test/' })).toEqual({
      url: 'https://relay.example.test',
    });
    expect(relayUrl({ OORT_RELAY_URL: 'http://localhost:8787' })).toEqual({
      url: 'http://localhost:8787',
    });
    for (const bad of [
      'http://relay.example.test',
      'not a url',
      'https://user:pw@relay.example.test',
      'https://relay.example.test/?k=1',
      'ftp://relay.example.test',
    ]) {
      expect(relayUrl({ OORT_RELAY_URL: bad }), bad).toHaveProperty('error');
    }
    const r = recorder();
    const w = await wired(
      env({ OORT_API_KEY: oortKey(), OORT_RELAY_URL: 'http://relay.example.test' }),
      { fetch: r.fetch },
    );
    await w.close();
    expect(w.embed).toBeUndefined();
    expect(w.unavailable.embed?.message).toContain('OORT_RELAY_URL');
    expect(r.seen).toEqual([]);
  });

  it('pro.401-402-429-map-to-one-clear-line-and-others-pass-through', () => {
    expect(relayErrorOf({ status: 402 })?.kind).toBe('payment-required');
    expect(relayErrorOf({ status: 429 })?.kind).toBe('rate-limit');
    expect(relayErrorOf({ status: 401 })?.kind).toBe('unauthorized');
    expect(relayErrorOf({ status: 500 })).toBeUndefined();
    // The relay's own 503: the providers are busy for everyone, not this account's cap.
    const busy = relayErrorOf({ status: 503 });
    expect(busy?.kind).toBe('busy');
    expect(busy?.message).toBe('Oort Pro is busy, try again shortly (HTTP 503).');
    // A cap 429 names its pool; a rate-limit 429 says so.
    expect(
      new OortRelayError('rate-limit', 429, 'You have used the 50,000 recalls included.').message,
    ).toContain('50,000 recalls');
    expect(new OortRelayError('rate-limit', 429).message).not.toContain('busy');
    expect(relayErrorOf(new Error('x'))).toBeUndefined();
    for (const kind of ['payment-required', 'rate-limit', 'unauthorized'] as const) {
      const m = new OortRelayError(kind, 400).message;
      expect(m).not.toContain('\n');
      expect(m).toContain(ACCOUNT_URL);
    }
    expect(new OortRelayError('unauthorized', 401).message).toContain('oort login');
  });

  it('pro.a-model-the-relay-does-not-serve-is-unavailable-with-the-fix', async () => {
    const e = env({ OORT_API_KEY: oortKey() });
    fs.mkdirSync(e['OORT_HOME']!, { recursive: true });
    fs.writeFileSync(
      path.join(e['OORT_HOME']!, 'config.json'),
      JSON.stringify({ writer: { provider: 'anthropic', model: 'claude-opus-5-5' } }),
    );
    const w = await wired(e, { fetch: recorder().fetch });
    await w.close();
    expect(w.write).toBeUndefined();
    expect(w.unavailable.write?.message).toContain('not served by Oort Pro');
    expect(w.unavailable.write?.message).toContain('claude-haiku-5-5');
    expect(w.unavailable.write?.message).toContain('ANTHROPIC_API_KEY');
    expect(w.embed).toBeDefined();
  });

  it('pro.relay-models-match-the-relay', async () => {
    const relay = (await import(
      pathToFileURL(
        path.join(import.meta.dirname, '..', '..', '..', 'apps', 'relay', 'src', 'relay.ts'),
      ).href
    )) as { MODELS: Record<string, readonly string[]> };
    expect([...RELAY_MODELS.embed]).toEqual([...(relay.MODELS['embed'] ?? [])]);
    expect([...RELAY_MODELS.rerank]).toEqual([...(relay.MODELS['rerank'] ?? [])]);
    expect([...RELAY_MODELS.write]).toEqual([...(relay.MODELS['messages'] ?? [])]);
    const { RELAY_MODEL } = await import('@oortmem/decide-jev');
    expect([RELAY_MODEL]).toEqual([...(relay.MODELS['decide'] ?? [])]);
  });
});

describe('relay refusals in commands and hooks', () => {
  const wireWith = (f: typeof fetch) => (cwd: string, o?: WireOptions) =>
    realWire(cwd, { keychain: async () => undefined, fetch: f, ...o });

  it('pro.observe-prints-the-402-as-one-line-without-a-stack', async () => {
    const key = oortKey();
    const e = env({ OORT_API_KEY: key });
    const io = fakeIo({ cwd: tmpdir(), env: e });
    const code = await runCli(
      ['observe', '--user', 'we deploy on port 8443 from now on', '--assistant', 'Noted.'],
      io,
      wireWith(recorder(402).fetch),
    );
    expect(code).toBe(1);
    expect(io.stderr).toContain('Oort Pro is not active');
    expect(io.stderr).toContain(ACCOUNT_URL);
    expect(io.stderr).not.toMatch(/\n\s+at /);
    expect(io.stdout + io.stderr).not.toContain(key);
  });

  it('pro.recall-says-why-it-degraded', async () => {
    const e = env({ OORT_API_KEY: oortKey() });
    const io = fakeIo({ cwd: tmpdir(), env: e });
    const code = await runCli(['recall', 'which port?'], io, wireWith(recorder(429).fetch));
    expect(code).toBe(0);
    expect(io.stderr).toContain('Oort Pro limit reached');
  });

  it('pro.hooks-fail-soft-on-a-relay-refusal', async () => {
    const e = env({ OORT_API_KEY: oortKey() });
    const cwd = tmpdir();
    for (const [event, stdin] of [
      [
        'UserPromptSubmit',
        JSON.stringify({ session_id: 's', cwd, hook_event_name: 'UserPromptSubmit', prompt: 'q?' }),
      ],
      ['drain', ''],
    ] as const) {
      const io = fakeIo({ cwd, env: e, stdin });
      const code = await runCli(['hook', event], io, wireWith(recorder(402).fetch));
      expect(code, event).toBe(0);
      expect(io.hookExits, event).toBe(1);
      expect(io.stderr, event).toBe('');
    }
  });
});

describe('contract with apps/relay', () => {
  /** The relay's own modules, loaded by path (they live outside this package's tsconfig). */
  async function relayModules() {
    const src = path.join(import.meta.dirname, '..', '..', '..', 'apps', 'relay', 'src');
    const load = async <T>(f: string): Promise<T> =>
      (await import(pathToFileURL(path.join(src, f)).href)) as T;
    const relay = await load<{
      handleRelay: (
        req: Request,
        env: unknown,
        ctx: { waitUntil(p: Promise<unknown>): void },
        deps: { fetch: typeof fetch; now?: () => Date },
      ) => Promise<Response>;
    }>('relay.ts');
    const keys = await load<{ hashKey: (k: string) => Promise<string> }>('keys.ts');
    const d1 = await load<{
      sqliteD1: () => {
        prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
      };
    }>('test/d1-sqlite.ts');
    return { ...relay, ...keys, ...d1 };
  }

  it('pro.adapters-speak-the-relay-routes-and-the-relay-uses-its-own-keys', async () => {
    const { handleRelay, hashKey, sqliteD1 } = await relayModules();
    const key = oortKey();
    const ours = {
      VOYAGE_API_KEY: vendorKey('our-voyage'),
      TYPESAFE_API_KEY: vendorKey('our-typesafe'),
      ANTHROPIC_API_KEY: vendorKey('our-anthropic'),
    };
    const db = sqliteD1();
    const now = new Date('2026-11-04T12:00:00Z');
    await db
      .prepare(
        'INSERT INTO accounts (id, clerk_user_id, plan, status, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('acc_1', 'user_1', 'pro', 'active', now.toISOString())
      .run();
    await db
      .prepare(
        'INSERT INTO api_keys (id, account_id, prefix, hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind('key_1', 'acc_1', key.slice(0, 12), await hashKey(key), 'CLI', now.toISOString())
      .run();
    let rateOk = true;
    const relayEnv = {
      DB: db,
      RATE_LIMITER: { limit: async () => ({ success: rateOk }) },
      AUTH_LIMITER: { limit: async () => ({ success: true }) },
      ...ours,
    };
    const upstream: { url: string; headers: Headers }[] = [];
    // The vendors, faked: each answers in its documented shape.
    const vendors = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      upstream.push({ url: req.url, headers: req.headers });
      if (req.url.endsWith('/v1/embeddings')) {
        // Only this body is read: the TypeSafe SDK zstd-compresses bodies of 1 KB and up.
        const input = (JSON.parse(await req.text()) as { input: string[] }).input;
        return Response.json({
          data: input.map((_, index) => ({ index, embedding: Array(512).fill(1) })),
        });
      }
      if (req.url.endsWith('/v1/rerank')) {
        return Response.json({ data: [{ index: 0, relevance_score: 0.7 }] });
      }
      if (req.url.endsWith('/v1/systemone')) {
        const noul = (p: number) => ({ type: 'noul', noul: p });
        return Response.json({
          answers: {
            should_store: noul(0.9),
            salience: {
              type: 'score',
              score: 2,
              confidence: 0.9,
              probabilities: { '0': 0.1, '1': 0.2, '2': 0.6, '3': 0.1 },
            },
            type_semantic: noul(0.9),
            type_episodic: noul(0.1),
            type_procedural: noul(0.1),
            type_preference: noul(0.1),
          },
        });
      }
      const text = JSON.stringify({
        text: 'The service deploys on port 8443.',
        stub: 'deploy port 8443. deploy, port',
        entities: ['deploy'],
        type: 'semantic',
      });
      return Response.json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as typeof fetch;
    const pending: Promise<unknown>[] = [];
    const viaRelay = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await handleRelay(
        new Request(input, init),
        relayEnv,
        { waitUntil: (p) => void pending.push(p) },
        { fetch: vendors, now: () => now },
      );
      await Promise.all(pending.splice(0));
      return res;
    }) as typeof fetch;

    const w = await wired(env({ OORT_API_KEY: key }), { fetch: viaRelay });
    const [vec] = (await w.embed?.embed(['q'], 'query')) ?? [];
    expect(vec?.length).toBe(512);
    expect(await w.rerank?.rerank('q', [{ id: 'a', text: 'a' }], 1)).toEqual([
      { id: 'a', score: 0.7 },
    ]);
    expect((await w.decide?.gate(obs))?.shouldStore).toBeCloseTo(0.9);
    expect((await w.write?.write(obs, 'ADD'))?.text).toBe('The service deploys on port 8443.');
    expect(upstream.map((u) => u.url)).toEqual([
      'https://api.voyageai.com/v1/embeddings',
      'https://api.voyageai.com/v1/rerank',
      'https://api.typesafe.ai/v1/systemone',
      'https://api.anthropic.com/v1/messages',
    ]);
    for (const u of upstream) {
      const sent = `${u.headers.get('authorization') ?? ''} ${u.headers.get('x-api-key') ?? ''}`;
      expect(sent).not.toContain(key);
    }

    // The relay's refusals reach the CLI as OortRelayError.
    rateOk = false;
    const limited = await w.embed?.embed(['q'], 'query').catch((e: unknown) => e);
    expect((limited as OortRelayError).kind).toBe('rate-limit');
    rateOk = true;
    await db.prepare("UPDATE accounts SET status = 'canceled'").bind().run();
    const unpaid = await w.write?.write(obs, 'ADD').catch((e: unknown) => e);
    expect((unpaid as OortRelayError).kind).toBe('payment-required');
    await db.prepare('UPDATE api_keys SET revoked_at = ?').bind(now.toISOString()).run();
    const revoked = await w.decide?.gate(obs).catch((e: unknown) => e);
    expect((revoked as OortRelayError).kind).toBe('unauthorized');
    await w.close();
    // Voyage waits out the relay's Retry-After (capped at 5 s) once before the 429 sticks.
  }, 20_000);
});
