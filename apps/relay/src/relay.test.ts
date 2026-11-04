import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rates } from '../../site/src/lib/oort-data.js';
import { hashKey } from './keys.js';
import { PLAN_LIMITS, ROUTES, handleRelay, type RelayEnv } from './relay.js';
import { sqliteD1 } from './test/d1-sqlite.js';

const OUR = {
  VOYAGE_API_KEY: 'pa-OUR-VOYAGE-SECRET',
  TYPESAFE_API_KEY: 'ts-OUR-TYPESAFE-SECRET',
  ANTHROPIC_API_KEY: 'sk-ant-OUR-ANTHROPIC-SECRET',
};
const CALLER_KEY = 'oort_sk_callerKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SECRET_TEXT = 'my private memory about the merger with Acme';
const NOW = new Date('2026-11-15T12:00:00Z');

interface Upstream {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array;
}

function setup(opts: { status?: string; plan?: string; revoked?: boolean; limit?: boolean } = {}) {
  const db = sqliteD1();
  const calls: Upstream[] = [];
  const pending: Promise<unknown>[] = [];
  let rateOk = opts.limit ?? true;
  const rateKeys: string[] = [];
  let upstream: (u: Upstream) => Response = () =>
    new Response(JSON.stringify({ ok: true, echo: OUR.VOYAGE_API_KEY.slice(0, 2) }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'request-id': 'req_upstream_123',
        'x-request-id': 'xreq_456',
        'anthropic-organization-id': 'org_789',
        'x-api-key': OUR.ANTHROPIC_API_KEY,
        authorization: `Bearer ${OUR.VOYAGE_API_KEY}`,
        'set-cookie': 'a=b',
        'cf-ray': 'abc',
        server: 'upstream',
        'retry-after': '3',
      },
    });

  const env: RelayEnv = {
    DB: db,
    RATE_LIMITER: {
      async limit({ key }) {
        rateKeys.push(key);
        return { success: rateOk };
      },
    },
    ...OUR,
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const u: Upstream = {
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: new Uint8Array(await req.arrayBuffer()),
    };
    calls.push(u);
    return upstream(u);
  }) as typeof fetch;

  const seed = async () => {
    await db
      .prepare(
        'INSERT INTO accounts (id, clerk_user_id, plan, status, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('acc_1', 'user_1', opts.plan ?? 'pro', opts.status ?? 'active', NOW.toISOString())
      .run();
    await db
      .prepare(
        'INSERT INTO api_keys (id, account_id, prefix, hash, name, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'key_1',
        'acc_1',
        CALLER_KEY.slice(0, 12),
        await hashKey(CALLER_KEY),
        'Laptop',
        NOW.toISOString(),
        opts.revoked ? NOW.toISOString() : null,
      )
      .run();
  };

  const send = async (
    path: string,
    body: unknown,
    init: { key?: string | null; headers?: Record<string, string>; method?: string } = {},
  ) => {
    const headers = new Headers(init.headers);
    const key = init.key === undefined ? CALLER_KEY : init.key;
    if (key !== null && !headers.has('authorization') && !headers.has('x-api-key')) {
      headers.set('authorization', `Bearer ${key}`);
    }
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    const method = init.method ?? 'POST';
    const req = new Request(`https://relay.oortcloud.dev${path}`, {
      method,
      headers,
      ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const res = await handleRelay(
      req,
      env,
      { waitUntil: (p) => void pending.push(p) },
      { fetch: fetchFn, now: () => NOW },
    );
    await Promise.all(pending.splice(0));
    return res;
  };

  const usage = () =>
    db
      .prepare('SELECT saves, recalls FROM usage WHERE account_id = ? AND month = ?')
      .bind('acc_1', '2026-11')
      .first<{ saves: number; recalls: number }>();

  return {
    db,
    env,
    calls,
    rateKeys,
    seed,
    send,
    usage,
    setRate: (ok: boolean) => (rateOk = ok),
    respond: (fn: (u: Upstream) => Response) => (upstream = fn),
  };
}

const embedBody = (n = 2, input_type: 'query' | 'document' = 'document') => ({
  input: Array.from({ length: n }, () => SECRET_TEXT),
  model: 'voyage-3.5-lite',
  input_type,
  output_dimension: 512,
  output_dtype: 'int8',
  truncation: true,
});
const rerankBody = (n = 3, model = 'rerank-3-lite') => ({
  query: SECRET_TEXT,
  documents: Array.from({ length: n }, () => SECRET_TEXT),
  model,
  top_k: 2,
  truncation: true,
});
const jevBody = () => ({ state: SECRET_TEXT, questions: { q: { type: 'noul' } }, model: 'jev' });
const messagesBody = (over: Record<string, unknown> = {}) => ({
  model: 'claude-haiku-5-5',
  max_tokens: 2048,
  system: 'write a memory',
  messages: [{ role: 'user', content: SECRET_TEXT }],
  thinking: { type: 'disabled' },
  ...over,
});

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('routes forward with our key, never the caller key', () => {
  it('embeddings go to Voyage with our bearer key', async () => {
    const s = setup();
    await s.seed();
    const res = await s.send('/v1/voyage/embeddings', embedBody());
    expect(res.status).toBe(200);
    expect(s.calls).toHaveLength(1);
    const c = s.calls[0]!;
    expect(c.url).toBe('https://api.voyageai.com/v1/embeddings');
    expect(c.method).toBe('POST');
    expect(c.headers.get('authorization')).toBe(`Bearer ${OUR.VOYAGE_API_KEY}`);
    expect(JSON.parse(text(c.body))).toEqual(embedBody());
    expect([...c.headers.values()].join(' ')).not.toContain(CALLER_KEY);
  });

  it('rerank goes to Voyage with our bearer key', async () => {
    const s = setup();
    await s.seed();
    expect((await s.send('/v1/voyage/rerank', rerankBody())).status).toBe(200);
    const c = s.calls[0]!;
    expect(c.url).toBe('https://api.voyageai.com/v1/rerank');
    expect(c.headers.get('authorization')).toBe(`Bearer ${OUR.VOYAGE_API_KEY}`);
    expect([...c.headers.values()].join(' ')).not.toContain(CALLER_KEY);
  });

  it('Jev goes to the TypeSafe systemone path with our bearer key, bytes untouched', async () => {
    const s = setup();
    await s.seed();
    const compressed = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4]);
    const req = new Request('https://relay.oortcloud.dev/v1/typesafe/v1/systemone', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CALLER_KEY}`,
        'content-type': 'application/json',
        'content-encoding': 'zstd',
        'x-typesafe-sdk': 'typesafe-sdk/0.7.0',
        'x-typesafe-retry-count': '1',
      },
      body: compressed,
    });
    const res = await handleRelay(
      req,
      s.env,
      { waitUntil: () => undefined },
      {
        fetch: (async (i: string | URL | Request, init?: RequestInit) => {
          const r = new Request(i, init);
          s.calls.push({
            url: r.url,
            method: r.method,
            headers: r.headers,
            body: new Uint8Array(await r.arrayBuffer()),
          });
          return Response.json({ answers: {} });
        }) as typeof fetch,
        now: () => NOW,
      },
    );
    expect(res.status).toBe(200);
    const c = s.calls[0]!;
    expect(c.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(c.headers.get('authorization')).toBe(`Bearer ${OUR.TYPESAFE_API_KEY}`);
    expect(c.headers.get('content-encoding')).toBe('zstd');
    expect(c.headers.get('x-typesafe-retry-count')).toBe('1');
    expect([...c.body]).toEqual([...compressed]);
    expect([...c.headers.values()].join(' ')).not.toContain(CALLER_KEY);
  });

  it('Anthropic messages go with our x-api-key and the caller anthropic-version', async () => {
    const s = setup();
    await s.seed();
    const res = await s.send('/v1/anthropic/v1/messages', messagesBody(), {
      headers: { 'anthropic-version': '2023-06-01', 'x-custom': 'nope' },
    });
    expect(res.status).toBe(200);
    const c = s.calls[0]!;
    expect(c.url).toBe('https://api.anthropic.com/v1/messages');
    expect(c.headers.get('x-api-key')).toBe(OUR.ANTHROPIC_API_KEY);
    expect(c.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(c.headers.get('authorization')).toBeNull();
    expect(c.headers.get('x-custom')).toBeNull();
    expect([...c.headers.values()].join(' ')).not.toContain(CALLER_KEY);
  });

  it('accepts the Oort key in x-api-key too (Anthropic SDK style)', async () => {
    const s = setup();
    await s.seed();
    const res = await s.send('/v1/anthropic/v1/messages', messagesBody(), {
      key: null,
      headers: { 'x-api-key': CALLER_KEY },
    });
    expect(res.status).toBe(200);
    expect(s.calls[0]!.headers.get('x-api-key')).toBe(OUR.ANTHROPIC_API_KEY);
  });

  it('defaults anthropic-version when the caller sends none', async () => {
    const s = setup();
    await s.seed();
    await s.send('/v1/anthropic/v1/messages', messagesBody());
    expect(s.calls[0]!.headers.get('anthropic-version')).toBe('2023-06-01');
  });
});

describe('allowlists and size caps', () => {
  const cases: [string, string, unknown, number][] = [
    [
      'embed: other model',
      '/v1/voyage/embeddings',
      { ...embedBody(), model: 'voyage-3-large' },
      400,
    ],
    ['embed: 129 inputs', '/v1/voyage/embeddings', embedBody(129), 400],
    ['embed: no input', '/v1/voyage/embeddings', { model: 'voyage-3.5-lite' }, 400],
    ['rerank: full model', '/v1/voyage/rerank', rerankBody(3, 'rerank-2.5'), 400],
    ['rerank: 101 documents', '/v1/voyage/rerank', rerankBody(101), 400],
    [
      'messages: other model',
      '/v1/anthropic/v1/messages',
      messagesBody({ model: 'claude-opus-5' }),
      400,
    ],
    [
      'messages: max_tokens 2049',
      '/v1/anthropic/v1/messages',
      messagesBody({ max_tokens: 2049 }),
      400,
    ],
    [
      'messages: no max_tokens',
      '/v1/anthropic/v1/messages',
      messagesBody({ max_tokens: undefined }),
      400,
    ],
    ['messages: tools', '/v1/anthropic/v1/messages', messagesBody({ tools: [{ name: 't' }] }), 400],
    [
      'messages: tool_choice',
      '/v1/anthropic/v1/messages',
      messagesBody({ tool_choice: { type: 'auto' } }),
      400,
    ],
    [
      'messages: mcp_servers',
      '/v1/anthropic/v1/messages',
      messagesBody({ mcp_servers: [{}] }),
      400,
    ],
    ['not JSON', '/v1/voyage/embeddings', '{nope', 400],
    ['unknown path', '/v1/voyage/models', {}, 404],
    ['other Anthropic path', '/v1/anthropic/v1/messages/batches', messagesBody(), 404],
    ['other TypeSafe path', '/v1/typesafe/v1/models', {}, 404],
    ['path traversal', '/v1/typesafe/v1/systemone/../models', {}, 404],
  ];
  for (const [name, path, body, status] of cases) {
    it(`rejects ${name} with ${status} and never calls upstream`, async () => {
      const s = setup();
      await s.seed();
      const res = await s.send(path, body);
      expect(res.status).toBe(status);
      expect(s.calls).toHaveLength(0);
      const j = (await res.json()) as { error: string };
      expect(typeof j.error).toBe('string');
      expect(j.error).not.toContain(SECRET_TEXT);
    });
  }

  it('accepts exactly 128 inputs and 100 documents', async () => {
    const s = setup();
    await s.seed();
    expect((await s.send('/v1/voyage/embeddings', embedBody(128))).status).toBe(200);
    expect((await s.send('/v1/voyage/rerank', rerankBody(100))).status).toBe(200);
  });

  it('accepts the 2.5 lite rerank model too', async () => {
    const s = setup();
    await s.seed();
    expect((await s.send('/v1/voyage/rerank', rerankBody(3, 'rerank-2.5-lite'))).status).toBe(200);
  });

  it('rejects a body over 256 KB with 413', async () => {
    const s = setup();
    await s.seed();
    const big = { ...embedBody(1), input: ['x'.repeat(256 * 1024)] };
    const res = await s.send('/v1/voyage/embeddings', big);
    expect(res.status).toBe(413);
    expect(s.calls).toHaveLength(0);
  });

  it('rejects a body over 256 KB on every route', async () => {
    const s = setup();
    await s.seed();
    for (const path of ROUTES.map((r) => r.path)) {
      const res = await s.send(path, 'x'.repeat(256 * 1024 + 1));
      expect(res.status).toBe(413);
    }
    expect(s.calls).toHaveLength(0);
  });

  it('rejects GET with 405', async () => {
    const s = setup();
    await s.seed();
    expect((await s.send('/v1/voyage/embeddings', null, { method: 'GET' })).status).toBe(405);
  });

  it('rejects a compressed body on the JSON-checked routes', async () => {
    const s = setup();
    await s.seed();
    const res = await s.send('/v1/voyage/embeddings', embedBody(), {
      headers: { 'content-encoding': 'gzip' },
    });
    expect(res.status).toBe(415);
  });

  it('rejects an unknown content-encoding on the TypeSafe route', async () => {
    const s = setup();
    await s.seed();
    const res = await s.send('/v1/typesafe/v1/systemone', jevBody(), {
      headers: { 'content-encoding': 'br' },
    });
    expect(res.status).toBe(415);
  });
});

describe('auth and entitlement', () => {
  it('rejects a missing key with 401', async () => {
    const s = setup();
    await s.seed();
    const res = await s.send('/v1/voyage/embeddings', embedBody(), { key: null });
    expect(res.status).toBe(401);
    expect(s.calls).toHaveLength(0);
  });

  it('rejects a key without the oort_sk_ prefix with 401', async () => {
    const s = setup();
    await s.seed();
    const res = await s.send('/v1/voyage/embeddings', embedBody(), { key: 'pa-some-voyage-key' });
    expect(res.status).toBe(401);
    expect(s.calls).toHaveLength(0);
  });

  it('rejects an unknown key with 401', async () => {
    const s = setup();
    await s.seed();
    const res = await s.send('/v1/voyage/embeddings', embedBody(), {
      key: 'oort_sk_unknownBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    });
    expect(res.status).toBe(401);
    expect(s.calls).toHaveLength(0);
  });

  it('rejects a revoked key with 401', async () => {
    const s = setup({ revoked: true });
    await s.seed();
    const res = await s.send('/v1/voyage/embeddings', embedBody());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/revoked/i);
    expect(s.calls).toHaveLength(0);
  });

  for (const status of ['canceled', 'past_due', 'unpaid', 'incomplete', 'none']) {
    it(`returns 402 with the account link when the subscription is ${status}`, async () => {
      const s = setup({ status });
      await s.seed();
      const res = await s.send('/v1/voyage/embeddings', embedBody());
      expect(res.status).toBe(402);
      const j = (await res.json()) as { error: string };
      expect(j.error).toContain('https://oortcloud.dev/account');
      expect(s.calls).toHaveLength(0);
    });
  }

  it('lets a trialing subscription through', async () => {
    const s = setup({ status: 'trialing' });
    await s.seed();
    expect((await s.send('/v1/voyage/embeddings', embedBody())).status).toBe(200);
  });

  it('returns 402 when the plan has no relay limits (free)', async () => {
    const s = setup({ plan: 'free' });
    await s.seed();
    expect((await s.send('/v1/voyage/embeddings', embedBody())).status).toBe(402);
  });

  it('rate limits per key with 429 and a plain message', async () => {
    const s = setup({ limit: false });
    await s.seed();
    const res = await s.send('/v1/voyage/embeddings', embedBody());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('10');
    expect(((await res.json()) as { error: string }).error).toMatch(/60 requests every 10 seconds/);
    expect(s.calls).toHaveLength(0);
    // The limiter key is the key hash, never the raw key.
    expect(s.rateKeys[0]).toBe(await hashKey(CALLER_KEY));
  });
});

describe('metering', () => {
  it('counts one Anthropic call as one save', async () => {
    const s = setup();
    await s.seed();
    await s.send('/v1/anthropic/v1/messages', messagesBody());
    await s.send('/v1/anthropic/v1/messages', messagesBody());
    expect(await s.usage()).toEqual({ saves: 2, recalls: 0 });
  });

  it('counts one engine recall once: the query embedding is the recall, the rerank is not', async () => {
    const s = setup();
    await s.seed();
    await s.send('/v1/voyage/embeddings', embedBody(1, 'query'));
    await s.send('/v1/voyage/rerank', rerankBody());
    expect(await s.usage()).toEqual({ saves: 0, recalls: 1 });
  });

  it('does not count a rerank call on its own', async () => {
    const s = setup();
    await s.seed();
    await s.send('/v1/voyage/rerank', rerankBody());
    expect(await s.usage()).toBeNull();
  });

  it('does not count document embeddings or Jev calls', async () => {
    const s = setup();
    await s.seed();
    await s.send('/v1/voyage/embeddings', embedBody(5, 'document'));
    await s.send('/v1/typesafe/v1/systemone', jevBody());
    expect(await s.usage()).toBeNull();
  });

  it('does not count a failed upstream call', async () => {
    const s = setup();
    await s.seed();
    s.respond(() => new Response('{"error":"x"}', { status: 500 }));
    await s.send('/v1/anthropic/v1/messages', messagesBody());
    expect(await s.usage()).toBeNull();
  });

  it('records last_used_at on the key', async () => {
    const s = setup();
    await s.seed();
    await s.send('/v1/voyage/rerank', rerankBody());
    const row = await s.db
      .prepare('SELECT last_used_at FROM api_keys WHERE id = ?')
      .bind('key_1')
      .first<{ last_used_at: string }>();
    expect(row?.last_used_at).toBe(NOW.toISOString());
  });

  it('stops saves at the Pro cap with 429 and a clear message', async () => {
    const s = setup();
    await s.seed();
    await s.db
      .prepare('INSERT INTO usage (account_id, month, saves, recalls) VALUES (?, ?, ?, ?)')
      .bind('acc_1', '2026-11', PLAN_LIMITS.pro.saves, 0)
      .run();
    const res = await s.send('/v1/anthropic/v1/messages', messagesBody());
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/25,000 saves/);
    expect(s.calls).toHaveLength(0);
    // The save pipeline's other calls stop too, but recalls still work.
    expect((await s.send('/v1/typesafe/v1/systemone', jevBody())).status).toBe(429);
    expect((await s.send('/v1/voyage/embeddings', embedBody(1, 'document'))).status).toBe(429);
    expect((await s.send('/v1/voyage/rerank', rerankBody())).status).toBe(200);
  });

  it('stops recalls at the Pro cap with 429, and saves still work', async () => {
    const s = setup();
    await s.seed();
    await s.db
      .prepare('INSERT INTO usage (account_id, month, saves, recalls) VALUES (?, ?, ?, ?)')
      .bind('acc_1', '2026-11', 0, PLAN_LIMITS.pro.recalls)
      .run();
    const res = await s.send('/v1/voyage/rerank', rerankBody());
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/50,000 recalls/);
    expect((await s.send('/v1/voyage/embeddings', embedBody(1, 'query'))).status).toBe(429);
    expect((await s.send('/v1/anthropic/v1/messages', messagesBody())).status).toBe(200);
  });

  it('uses the same Pro included amounts as the site pricing (Structure A)', () => {
    expect(PLAN_LIMITS.pro).toEqual({
      saves: rates.managed.Pro.saves,
      recalls: rates.managed.Pro.recalls,
    });
    expect(PLAN_LIMITS.pro).toEqual({ saves: 25_000, recalls: 50_000 });
  });
});

describe('no content in logs or responses', () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  let spies: ReturnType<typeof vi.spyOn>[] = [];
  beforeEach(() => {
    spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
  });

  it('never logs a request or response body, on success or on any error path', async () => {
    const s = setup();
    await s.seed();
    s.respond(() => Response.json({ data: [SECRET_TEXT] }));
    await s.send('/v1/voyage/embeddings', embedBody());
    await s.send('/v1/voyage/rerank', rerankBody());
    await s.send('/v1/anthropic/v1/messages', messagesBody());
    await s.send('/v1/typesafe/v1/systemone', jevBody());
    await s.send('/v1/anthropic/v1/messages', messagesBody({ model: 'nope' }));
    await s.send('/v1/voyage/embeddings', `{${SECRET_TEXT}`);
    await s.send('/v1/voyage/embeddings', embedBody(), { key: 'oort_sk_unknown' });
    s.respond(() => {
      throw new Error(`network down while sending ${SECRET_TEXT}`);
    });
    await s.send('/v1/voyage/embeddings', embedBody());
    s.respond(() => new Response(SECRET_TEXT, { status: 500 }));
    await s.send('/v1/voyage/embeddings', embedBody());
    // Metering failure path.
    s.db.raw.exec('DROP TABLE usage');
    s.respond(() => Response.json({ ok: true }));
    await s.send('/v1/voyage/rerank', rerankBody());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('returns a plain 502 without upstream details when the upstream is unreachable', async () => {
    const s = setup();
    await s.seed();
    s.respond(() => {
      throw new Error(`boom ${OUR.VOYAGE_API_KEY} ${SECRET_TEXT}`);
    });
    const res = await s.send('/v1/voyage/embeddings', embedBody());
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(SECRET_TEXT);
    expect(body).not.toContain(OUR.VOYAGE_API_KEY);
  });

  it('never returns our upstream keys or upstream ids in any response', async () => {
    const s = setup();
    await s.seed();
    const responses: Response[] = [];
    responses.push(await s.send('/v1/voyage/embeddings', embedBody()));
    responses.push(await s.send('/v1/voyage/rerank', rerankBody()));
    responses.push(await s.send('/v1/typesafe/v1/systemone', jevBody()));
    responses.push(await s.send('/v1/anthropic/v1/messages', messagesBody()));
    responses.push(await s.send('/v1/anthropic/v1/messages', messagesBody({ model: 'x' })));
    responses.push(await s.send('/v1/voyage/embeddings', embedBody(), { key: null }));
    responses.push(await s.send('/nope', {}));
    s.respond(() => {
      throw new Error(`fail ${OUR.ANTHROPIC_API_KEY}`);
    });
    responses.push(await s.send('/v1/anthropic/v1/messages', messagesBody()));
    for (const r of responses) {
      const all = [...r.headers.entries()].flat().join('\n') + (await r.text());
      for (const k of Object.values(OUR)) expect(all).not.toContain(k);
      expect(all).not.toContain('req_upstream_123');
      expect(all).not.toContain('xreq_456');
      expect(all).not.toContain('org_789');
    }
  });

  it('maps an upstream 401 (our key) to a plain 502, so the caller never blames its own key', async () => {
    const s = setup();
    await s.seed();
    s.respond(() => new Response(`bad key ${OUR.VOYAGE_API_KEY}`, { status: 401 }));
    const res = await s.send('/v1/voyage/rerank', rerankBody());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(OUR.VOYAGE_API_KEY);
  });

  it('passes other upstream errors through without our keys or the upstream request id', async () => {
    const s = setup();
    await s.seed();
    s.respond(() =>
      Response.json(
        {
          type: 'error',
          error: { type: 'invalid_request_error', message: `x-api-key ${OUR.ANTHROPIC_API_KEY}` },
          request_id: 'req_upstream_123',
        },
        { status: 400, headers: { 'request-id': 'req_upstream_123' } },
      ),
    );
    const res = await s.send('/v1/anthropic/v1/messages', messagesBody());
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('invalid_request_error');
    expect(body).not.toContain(OUR.ANTHROPIC_API_KEY);
    expect(body).not.toContain('req_upstream_123');
    expect(res.headers.get('request-id')).toBeNull();
  });

  it('keeps only content-type and retry-after from upstream response headers', async () => {
    const s = setup();
    await s.seed();
    const res = await s.send('/v1/voyage/embeddings', embedBody());
    const names = [...res.headers.keys()].sort();
    expect(names).toEqual(['cache-control', 'content-type', 'retry-after']);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
