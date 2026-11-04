import { describe, expect, it } from 'vitest';
import { hashKey } from './keys.js';
import { handleRelay, type RelayEnv } from './relay.js';
import { sqliteD1 } from './test/d1-sqlite.js';

/**
 * The independent review's relay proofs (review-pro/proofs/relay-review.test.ts), inverted: each
 * one asserted a flaw at 63e6187 and now asserts the fixed behaviour.
 */

const NOW = new Date('2026-11-15T12:00:00Z');

/** A limiter that really counts per key, like the Workers binding within one period. */
function counting(limit: number) {
  const hits = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }: { key: string }) {
      keys.push(key);
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return { success: n <= limit };
    },
  };
}

async function setup(
  keys: string[],
  opts: { periodEnd?: string | null; upstream?: () => Response; limit?: number } = {},
) {
  const db = sqliteD1();
  const pending: Promise<unknown>[] = [];
  const calls: { url: string; body: string; headers: Headers }[] = [];
  await db
    .prepare(
      "INSERT INTO accounts (id, clerk_user_id, plan, status, current_period_end, created_at) VALUES ('acc_1','u','pro','active',?,?)",
    )
    .bind(opts.periodEnd ?? null, NOW.toISOString())
    .run();
  for (const [i, k] of keys.entries())
    await db
      .prepare(
        "INSERT INTO api_keys (id, account_id, prefix, hash, name, created_at) VALUES (?, 'acc_1', 'p', ?, 'n', ?)",
      )
      .bind(`k${i}`, await hashKey(k), NOW.toISOString())
      .run();
  const rate = counting(opts.limit ?? 1_000_000);
  const auth = counting(1_000_000);
  const env: RelayEnv = {
    DB: db,
    RATE_LIMITER: rate,
    AUTH_LIMITER: auth,
    VOYAGE_API_KEY: 'v',
    TYPESAFE_API_KEY: 't',
    ANTHROPIC_API_KEY: 'a',
  };
  const fetchFn = (async (u: string, init: RequestInit) => {
    await new Promise((r) => setTimeout(r, 10)); // upstream latency (Anthropic takes seconds)
    calls.push({
      url: u,
      body:
        typeof init.body === 'string'
          ? init.body
          : new TextDecoder().decode(init.body as Uint8Array),
      headers: new Headers(init.headers),
    });
    return (
      opts.upstream?.() ??
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
  }) as unknown as typeof fetch;
  const send = async (
    path: string,
    body: string,
    key = keys[0]!,
    headers: Record<string, string> = {},
    defer = false,
  ) => {
    const r = await handleRelay(
      new Request(`https://relay.oortcloud.dev${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          ...headers,
        },
        body,
      }),
      env,
      { waitUntil: (p) => void pending.push(p) },
      { fetch: fetchFn, now: () => NOW },
    );
    if (!defer) await Promise.all(pending);
    return r;
  };
  const usage = async () =>
    db
      .prepare('SELECT saves, recalls, embed_inputs, rerank_calls, decide_calls FROM usage')
      .first<Record<string, number>>();
  return { send, usage, calls, db, rate, auth, flush: () => Promise.all(pending) };
}
const KEY = 'oort_sk_' + 'A'.repeat(43);
const jev = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    state: { user: 'x' },
    questions: { q: { type: 'noul', instructions: 'Is it?' } },
    model: 'jev-latest',
    ...over,
  });

describe('review C1: every forwarded call is metered and capped', () => {
  it('meters document embeddings by input, rerank and TypeSafe calls by call', async () => {
    const { send, usage } = await setup([KEY]);
    const big = JSON.stringify({
      model: 'voyage-3.5-lite',
      input: Array(128).fill('x'.repeat(1900)),
      input_type: 'document',
    });
    for (let i = 0; i < 5; i++) expect((await send('/v1/voyage/embeddings', big)).status).toBe(200);
    for (let i = 0; i < 3; i++)
      expect(
        (
          await send(
            '/v1/voyage/rerank',
            JSON.stringify({ model: 'rerank-3-lite', query: 'q', documents: ['d', 'e'] }),
          )
        ).status,
      ).toBe(200);
    for (let i = 0; i < 2; i++)
      expect((await send('/v1/typesafe/v1/systemone', jev())).status).toBe(200);
    expect(await usage()).toEqual({
      saves: 0,
      recalls: 0,
      embed_inputs: 640,
      rerank_calls: 3,
      decide_calls: 2,
    });
  });

  it('refuses an embedding without input_type query or document', async () => {
    const { send, calls } = await setup([KEY]);
    for (const extra of [{}, { input_type: null }]) {
      const r = await send(
        '/v1/voyage/embeddings',
        JSON.stringify({ model: 'voyage-3.5-lite', input: 'what did we decide?', ...extra }),
      );
      expect(r.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('stops each internal counter at its monthly cap with a reason', async () => {
    const { send, db, calls } = await setup([KEY]);
    await db
      .prepare(
        "INSERT INTO usage (account_id, month, embed_inputs, rerank_calls, decide_calls) VALUES ('acc_1','2026-11',199999,60000,150000)",
      )
      .run();
    const two = JSON.stringify({
      model: 'voyage-3.5-lite',
      input: ['a', 'b'],
      input_type: 'document',
    });
    const e = await send('/v1/voyage/embeddings', two);
    expect(e.status).toBe(429);
    expect(await e.json()).toMatchObject({ reason: 'monthly cap: embed inputs' });
    const r = await send(
      '/v1/voyage/rerank',
      JSON.stringify({ model: 'rerank-3-lite', query: 'q', documents: ['d'] }),
    );
    expect(await r.json()).toMatchObject({ reason: 'monthly cap: rerank calls' });
    const d = await send('/v1/typesafe/v1/systemone', jev());
    expect(await d.json()).toMatchObject({ reason: 'monthly cap: decide calls' });
    expect(calls).toHaveLength(0);
  });

  it('TypeSafe: pins the model, accepts only plain JSON of the systemone shape, caps at 64 KB', async () => {
    const { send, calls } = await setup([KEY]);
    expect(
      (await send('/v1/typesafe/v1/systemone', jev({ model: 'any-model-we-pay-for' }))).status,
    ).toBe(400);
    expect(
      (await send('/v1/typesafe/v1/systemone', jev(), KEY, { 'content-encoding': 'zstd' })).status,
    ).toBe(415);
    expect(
      (
        await send('/v1/typesafe/v1/systemone', jev(), KEY, {
          'content-type': 'multipart/form-data; boundary=x',
        })
      ).status,
    ).toBe(415);
    expect((await send('/v1/typesafe/v1/systemone', jev({ extra: 1 }))).status).toBe(400);
    expect((await send('/v1/typesafe/v1/systemone', jev({ questions: {} }))).status).toBe(400);
    expect(
      (await send('/v1/typesafe/v1/systemone', jev({ state: 'x'.repeat(65 * 1024) }))).status,
    ).toBe(413);
    expect(calls).toHaveLength(0);
    expect((await send('/v1/typesafe/v1/systemone', jev({ model: undefined }))).status).toBe(200);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ model: 'jev-latest' });
  });
});

describe('review I1: Anthropic content is allow-listed', () => {
  it('refuses URL document and image sources before any upstream call', async () => {
    const { send, calls } = await setup([KEY]);
    const body = {
      model: 'claude-haiku-5-5',
      max_tokens: 2048,
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'url', url: 'https://example.com/600-page.pdf' } },
            { type: 'image', source: { type: 'url', url: 'https://example.com/huge.png' } },
            { type: 'text', text: 'summarise' },
          ],
        },
      ],
    };
    expect((await send('/v1/anthropic/v1/messages', JSON.stringify(body))).status).toBe(400);
    const cached = {
      model: 'claude-haiku-5-5',
      max_tokens: 10,
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect((await send('/v1/anthropic/v1/messages', JSON.stringify(cached))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('review M2: the checked object is what is forwarded', () => {
  it('forwards the re-serialised object, not the raw bytes with duplicate keys', async () => {
    const { send, calls } = await setup([KEY]);
    const raw2 =
      '{"model":"claude-opus-5-5","max_tokens":128000,"model":"claude-haiku-5-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}';
    expect((await send('/v1/anthropic/v1/messages', raw2)).status).toBe(200);
    expect(calls.at(-1)!.body).not.toBe(raw2);
    expect(calls.at(-1)!.body).toBe(
      JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
  });
});

describe('review C1: rate limit per account as well as per key', () => {
  it('30 keys of one account share one 60-per-10-s budget', async () => {
    const keys = Array.from({ length: 30 }, (_, i) => 'oort_sk_' + String(i).padStart(43, 'K'));
    const { send, rate } = await setup(keys, { limit: 60 });
    const statuses: number[] = [];
    for (let round = 0; round < 3; round++)
      for (const k of keys)
        statuses.push(
          (
            await send(
              '/v1/voyage/embeddings',
              JSON.stringify({ model: 'voyage-3.5-lite', input: 'x', input_type: 'query' }),
              k,
            )
          ).status,
        );
    expect(statuses.filter((s) => s === 200)).toHaveLength(60);
    expect(statuses.filter((s) => s === 429)).toHaveLength(30);
    expect(rate.keys).toContain('account:acc_1');
  });
});

describe('review M1: capacity is reserved atomically before forwarding', () => {
  it('20 concurrent saves at 24,999 let exactly one through', async () => {
    const { send, usage, db, flush } = await setup([KEY]);
    await db
      .prepare(
        "INSERT INTO usage (account_id, month, saves, recalls) VALUES ('acc_1','2026-11',24999,0)",
      )
      .run();
    const b = JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => send('/v1/anthropic/v1/messages', b, KEY, {}, true)),
    );
    await flush();
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    expect(rs.filter((r) => r.status === 429).length).toBe(19);
    expect((await usage())!['saves']).toBe(25000);
  });

  it('refunds the reservation on an upstream 5xx', async () => {
    const { send, usage } = await setup([KEY], {
      upstream: () => new Response('{}', { status: 500 }),
    });
    const b = JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect((await send('/v1/anthropic/v1/messages', b)).status).toBe(503);
    expect((await usage())!['saves']).toBe(0);
  });
});

describe('review M3: the key format is checked before any limiter or D1 work', () => {
  it('a malformed key costs nothing; an unknown key counts against the IP', async () => {
    const { send, rate, auth } = await setup([KEY]);
    const q = JSON.stringify({ model: 'voyage-3.5-lite', input: 'x', input_type: 'query' });
    expect((await send('/v1/voyage/embeddings', q, 'oort_sk_short')).status).toBe(401);
    expect(rate.keys).toHaveLength(0);
    expect(auth.keys).toHaveLength(0);
    const r = await send('/v1/voyage/embeddings', q, 'oort_sk_' + 'Z'.repeat(43), {
      'cf-connecting-ip': '203.0.113.9',
    });
    expect(r.status).toBe(401);
    expect(auth.keys).toEqual(['ip:203.0.113.9']);
  });
});

describe('review M4: the relay answers with its own errors', () => {
  it('maps an upstream 429 or 5xx to 503 busy, and never passes an upstream body', async () => {
    const leaky = () =>
      Response.json(
        { error: { message: 'Organization org_123 rate limit 4000 RPM exceeded' } },
        { status: 429, headers: { 'retry-after': '7' } },
      );
    const { send } = await setup([KEY], { upstream: leaky });
    const q = JSON.stringify({ model: 'voyage-3.5-lite', input: 'x', input_type: 'query' });
    const r = await send('/v1/voyage/embeddings', q);
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('7');
    const text = await r.text();
    expect(text).toContain('Oort Pro is busy, try again shortly');
    expect(text).not.toContain('org_123');
  });

  it('replaces an upstream 4xx body with a plain message', async () => {
    const { send } = await setup([KEY], {
      upstream: () => Response.json({ error: { message: 'org_456 detail' } }, { status: 400 }),
    });
    const r = await send(
      '/v1/voyage/embeddings',
      JSON.stringify({ model: 'voyage-3.5-lite', input: 'x', input_type: 'query' }),
    );
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain('org_456');
  });
});

describe('review M8: the period end is enforced', () => {
  it('denies 3 days after current_period_end, and allows within the grace', async () => {
    const q = JSON.stringify({ model: 'voyage-3.5-lite', input: 'x', input_type: 'query' });
    const late = await setup([KEY], { periodEnd: '2026-11-12T11:59:00Z' });
    expect((await late.send('/v1/voyage/embeddings', q)).status).toBe(402);
    const grace = await setup([KEY], { periodEnd: '2026-11-12T12:01:00Z' });
    expect((await grace.send('/v1/voyage/embeddings', q)).status).toBe(200);
  });
});
