import * as fs from 'node:fs';
import * as path from 'node:path';
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
import CONTRACT from '../test/relay-contract.json' with { type: 'json' };

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
    // The relay lives in the private oortmem/oortcloud repo; both sides test against this contract.
    expect([...RELAY_MODELS.embed]).toEqual(CONTRACT.models.embed);
    expect([...RELAY_MODELS.rerank]).toEqual(CONTRACT.models.rerank);
    expect([...RELAY_MODELS.write]).toEqual(CONTRACT.models.messages);
    const { RELAY_MODEL } = await import('@oortmem/decide-jev');
    expect([RELAY_MODEL]).toEqual(CONTRACT.models.decide);
    expect(DEFAULT_RELAY_URL).toBe(CONTRACT.relayUrl);
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

describe('contract with the relay (relay-contract.json)', () => {
  it('pro.adapters-speak-the-relay-routes-with-the-oort-key', async () => {
    const key = oortKey();
    const seen: { path: string; model: unknown; auth: string | null }[] = [];
    let refuse: number | undefined;
    // A stand-in relay that enforces the pinned contract, then answers like the vendors do.
    const relay = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      expect(url.origin).toBe(CONTRACT.relayUrl);
      expect(CONTRACT.routes).toContain(url.pathname);
      expect(req.headers.get('authorization')).toBe(`Bearer ${key}`);
      if (refuse !== undefined) return Response.json({ error: 'refused' }, { status: refuse });
      const raw = await req.arrayBuffer();
      let model: unknown;
      try {
        model = (JSON.parse(new TextDecoder().decode(raw)) as { model?: unknown }).model;
      } catch {
        model = undefined; // the TypeSafe SDK may compress its body; the relay pins that model
      }
      seen.push({ path: url.pathname, model, auth: req.headers.get('authorization') });
      if (url.pathname.endsWith('/embeddings')) {
        const n = (JSON.parse(new TextDecoder().decode(raw)) as { input: string[] }).input.length;
        return Response.json({
          data: Array.from({ length: n }, (_, index) => ({ index, embedding: Array(512).fill(1) })),
        });
      }
      if (url.pathname.endsWith('/rerank')) {
        return Response.json({ data: [{ index: 0, relevance_score: 0.7 }] });
      }
      if (url.pathname.endsWith('/systemone')) {
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

    const w = await wired(env({ OORT_API_KEY: key }), { fetch: relay });
    const [vec] = (await w.embed?.embed(['q'], 'query')) ?? [];
    expect(vec?.length).toBe(512);
    expect(await w.rerank?.rerank('q', [{ id: 'a', text: 'a' }], 1)).toEqual([
      { id: 'a', score: 0.7 },
    ]);
    expect((await w.decide?.gate(obs))?.shouldStore).toBeCloseTo(0.9);
    expect((await w.write?.write(obs, 'ADD'))?.text).toBe('The service deploys on port 8443.');
    expect(seen.map((s) => s.path)).toEqual(CONTRACT.routes);
    const byPath = Object.fromEntries(seen.map((s) => [s.path, s.model]));
    expect(CONTRACT.models.embed).toContain(byPath['/v1/voyage/embeddings']);
    expect(CONTRACT.models.rerank).toContain(byPath['/v1/voyage/rerank']);
    expect(CONTRACT.models.messages).toContain(byPath['/v1/anthropic/v1/messages']);

    // The relay's refusals reach the CLI as OortRelayError, with the contract's kinds.
    for (const [status, kind] of Object.entries(CONTRACT.refusals)) {
      refuse = Number(status);
      const err = await w.write?.write(obs, 'ADD').catch((e: unknown) => e);
      expect((err as OortRelayError).kind).toBe(kind);
    }
    await w.close();
  }, 20_000);
});
