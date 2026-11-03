import { describe, expect, it } from 'vitest';
import { MissingCredentialError } from '@oortmem/core';
import { VoyageError, voyageEmbedder } from './index.js';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** A fetch stub that records calls and answers from `respond`. */
function stub(respond: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    calls.push(call);
    return respond(call, calls.length);
  }) as typeof fetch;
  return { fn, calls };
}

/** Echoes one in-range embedding of `dim` values per input, tagged by position. */
function echo(dim: number) {
  return (call: Call): Response => {
    const input = call.body['input'] as string[];
    return json({
      data: input.map((_, index) => ({
        index,
        embedding: Array.from({ length: dim }, () => index % 100),
      })),
      usage: { total_tokens: 1 },
    });
  };
}

const base = { apiKey: 'pa-test-key', model: 'voyage-3.5-lite', dimension: 4 };

describe('voyageEmbedder', () => {
  it('embed.batches-128', async () => {
    const s = stub(echo(4));
    const e = voyageEmbedder({ ...base, fetch: s.fn });
    const out = await e.embed(
      Array.from({ length: 300 }, (_, i) => `t${i}`),
      'document',
    );
    expect(out).toHaveLength(300);
    expect(s.calls.map((c) => (c.body['input'] as string[]).length)).toEqual([128, 128, 44]);
  });

  it('embed.sends-int8-and-dimension', async () => {
    const s = stub(echo(4));
    const e = voyageEmbedder({ ...base, fetch: s.fn });
    const out = await e.embed(['hello'], 'query');
    expect(out[0]).toBeInstanceOf(Int8Array);
    const c = s.calls[0]!;
    expect(c.url).toBe('https://api.voyageai.com/v1/embeddings');
    expect(c.body).toMatchObject({
      input: ['hello'],
      model: 'voyage-3.5-lite',
      input_type: 'query',
      output_dimension: 4,
      output_dtype: 'int8',
      truncation: true,
    });
    expect((c.init.headers as Record<string, string>)['Authorization']).toBe('Bearer pa-test-key');
    await e.embed(['x'], 'document');
    expect(s.calls[1]!.body['input_type']).toBe('document');
    expect(e.dimension).toBe(4);
  });

  it('embed.missing-key-names-fix', () => {
    const prev = process.env['VOYAGE_API_KEY'];
    delete process.env['VOYAGE_API_KEY'];
    try {
      expect(() => voyageEmbedder({ model: 'm', dimension: 4 })).toThrow(MissingCredentialError);
      expect(() => voyageEmbedder({ model: 'm', dimension: 4 })).toThrow(
        'Missing VOYAGE_API_KEY. Set it with: export VOYAGE_API_KEY=... (or set embed.apiKey in ~/.oort/config.json).',
      );
    } finally {
      if (prev !== undefined) process.env['VOYAGE_API_KEY'] = prev;
    }
  });

  it('embed.sorts-by-index', async () => {
    const s = stub(() =>
      json({
        data: [
          { index: 1, embedding: [2, 2, 2, 2] },
          { index: 0, embedding: [1, 1, 1, 1] },
        ],
      }),
    );
    const out = await voyageEmbedder({ ...base, fetch: s.fn }).embed(['a', 'b'], 'document');
    expect(Array.from(out[0]!)).toEqual([1, 1, 1, 1]);
    expect(Array.from(out[1]!)).toEqual([2, 2, 2, 2]);
  });

  it('embed.rejects-wrong-dimension', async () => {
    const s = stub(() => json({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
    const e = voyageEmbedder({ ...base, fetch: s.fn });
    await expect(e.embed(['a'], 'query')).rejects.toMatchObject({ kind: 'bad-response' });
    const s2 = stub(() => json({ data: [{ index: 0, embedding: [1, 2, 3, 300] }] }));
    await expect(
      voyageEmbedder({ ...base, fetch: s2.fn }).embed(['a'], 'query'),
    ).rejects.toBeInstanceOf(VoyageError);
  });

  it('embed.retries-once-on-429', async () => {
    const s = stub((c, n) => (n === 1 ? json({}, 429, { 'retry-after': '0' }) : echo(4)(c)));
    const out = await voyageEmbedder({ ...base, fetch: s.fn }).embed(['a'], 'query');
    expect(out).toHaveLength(1);
    expect(s.calls).toHaveLength(2);
    const always = stub(() => json({}, 503));
    await expect(
      voyageEmbedder({ ...base, fetch: always.fn }).embed(['a'], 'query'),
    ).rejects.toMatchObject({
      kind: 'server',
      status: 503,
    });
    expect(always.calls).toHaveLength(2);
    const rl = stub(() => json({}, 429, { 'retry-after': '0' }));
    await expect(
      voyageEmbedder({ ...base, fetch: rl.fn }).embed(['a'], 'query'),
    ).rejects.toMatchObject({
      kind: 'rate-limit',
    });
  });

  it('embed.no-retry-on-401', async () => {
    const s = stub(() => json({ detail: 'bad key' }, 401));
    await expect(
      voyageEmbedder({ ...base, fetch: s.fn }).embed(['a'], 'query'),
    ).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
    });
    expect(s.calls).toHaveLength(1);
  });

  it('embed.timeout-is-voyage-error', async () => {
    const s = stub(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const e = voyageEmbedder({ ...base, fetch: s.fn });
    const err = await e.embed(['a'], 'query').catch((x: unknown) => x);
    expect(err).toBeInstanceOf(VoyageError);
    expect((err as VoyageError).kind).toBe('timeout');
    expect(s.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const net = stub(() => {
      throw new TypeError('fetch failed');
    });
    await expect(
      voyageEmbedder({ ...base, fetch: net.fn }).embed(['a'], 'query'),
    ).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('embed.empty-no-request', async () => {
    const s = stub(echo(4));
    expect(await voyageEmbedder({ ...base, fetch: s.fn }).embed([], 'query')).toEqual([]);
    expect(s.calls).toHaveLength(0);
  });

  it('errors.never-leak-key-or-text', async () => {
    const secretText = 'my-private-sentence-xyz';
    const key = 'pa-super-secret-key';
    const cases: Response[] = [
      json({ detail: `echo ${secretText} ${key}` }, 401),
      json({ detail: secretText }, 500),
      new Response('not json', { status: 200 }),
    ];
    for (const res of cases) {
      const s = stub(() => res.clone());
      const err = await voyageEmbedder({ apiKey: key, model: 'm', dimension: 4, fetch: s.fn })
        .embed([secretText], 'query')
        .catch((x: unknown) => x);
      expect(err).toBeInstanceOf(VoyageError);
      const msg = (err as Error).message;
      expect(msg).not.toContain(key);
      expect(msg).not.toContain(secretText);
    }
    const boom = stub(() => {
      throw new Error(`connect failed for ${key} ${secretText}`);
    });
    const err = (await voyageEmbedder({ apiKey: key, model: 'm', dimension: 4, fetch: boom.fn })
      .embed([secretText], 'query')
      .catch((x: unknown) => x)) as Error;
    expect(err.message).not.toContain(key);
    expect(err.message).not.toContain(secretText);
  });

  it('network.import-makes-no-call', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('network call at import');
    }) as typeof fetch;
    try {
      const { vi } = await import('vitest');
      vi.resetModules();
      await import('./index.js');
    } finally {
      globalThis.fetch = orig;
    }
  });
});
