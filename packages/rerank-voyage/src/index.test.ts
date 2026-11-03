import { describe, expect, it, vi } from 'vitest';
import { MissingCredentialError } from '@oortmem/core';
import { VoyageError, voyageReranker } from './index.js';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function stub(respond: (n: number) => Response) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return respond(calls.length);
  }) as typeof fetch;
  return { fn, calls };
}

const docs = [
  { id: 'a', text: 'alpha' },
  { id: 'b', text: 'beta' },
  { id: 'c', text: 'gamma' },
];

describe('voyageReranker', () => {
  it('rerank.maps-scores-to-ids', async () => {
    const s = stub(() =>
      json({
        data: [
          { index: 0, relevance_score: 0.2 },
          { index: 2, relevance_score: 0.9 },
        ],
        usage: { total_tokens: 3 },
      }),
    );
    const r = voyageReranker({ apiKey: 'k', model: 'rerank-3-lite', fetch: s.fn });
    const out = await r.rerank('q', docs, 2);
    expect(out).toEqual([
      { id: 'c', score: 0.9 },
      { id: 'a', score: 0.2 },
    ]);
    expect(s.calls[0]!.url).toBe('https://api.voyageai.com/v1/rerank');
    expect(s.calls[0]!.body).toEqual({
      query: 'q',
      documents: ['alpha', 'beta', 'gamma'],
      model: 'rerank-3-lite',
      top_k: 2,
      truncation: true,
    });
    expect((s.calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer k');
  });

  it('rerank.empty-docs-no-request', async () => {
    const s = stub(() => json({ data: [] }));
    const r = voyageReranker({ apiKey: 'k', model: 'm', fetch: s.fn });
    expect(await r.rerank('q', [], 3)).toEqual([]);
    expect(s.calls).toHaveLength(0);
  });

  it('rerank.missing-key-names-fix', () => {
    const prev = process.env['VOYAGE_API_KEY'];
    delete process.env['VOYAGE_API_KEY'];
    try {
      expect(() => voyageReranker({ model: 'm' })).toThrow(MissingCredentialError);
      expect(() => voyageReranker({ model: 'm' })).toThrow(
        /^Missing VOYAGE_API_KEY\. Set it with: export VOYAGE_API_KEY=\.\.\.$/,
      );
    } finally {
      if (prev !== undefined) process.env['VOYAGE_API_KEY'] = prev;
    }
  });

  it('rerank.errors-are-voyage-errors-without-leaks', async () => {
    const key = 'pa-super-secret-key';
    const text = 'private-query-text';
    const s = stub(() => json({ detail: `${key} ${text}` }, 401));
    const err = await voyageReranker({ apiKey: key, model: 'm', fetch: s.fn })
      .rerank(text, [{ id: 'a', text }], 1)
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(VoyageError);
    expect((err as VoyageError).kind).toBe('auth');
    expect((err as Error).message).not.toContain(key);
    expect((err as Error).message).not.toContain(text);
    expect(s.calls).toHaveLength(1);
  });

  it('rerank.retries-once-on-429', async () => {
    const ok = { data: [{ index: 1, relevance_score: 0.5 }] };
    const s = stub((n) => (n === 1 ? json({}, 429, { 'retry-after': '0' }) : json(ok)));
    const r = voyageReranker({ apiKey: 'k', model: 'm', fetch: s.fn });
    expect(await r.rerank('q', docs, 1)).toEqual([{ id: 'b', score: 0.5 }]);
    expect(s.calls).toHaveLength(2);
    const always = stub(() => json({}, 503, { 'retry-after': '0' }));
    await expect(
      voyageReranker({ apiKey: 'k', model: 'm', fetch: always.fn }).rerank('q', docs, 1),
    ).rejects.toMatchObject({ kind: 'server', status: 503 });
    expect(always.calls).toHaveLength(2);
  });

  it('rerank.no-retry-on-401', async () => {
    const s = stub(() => json({}, 401));
    await expect(
      voyageReranker({ apiKey: 'k', model: 'm', fetch: s.fn }).rerank('q', docs, 1),
    ).rejects.toMatchObject({ kind: 'auth', status: 401 });
    expect(s.calls).toHaveLength(1);
  });

  it('rerank.timeout-is-voyage-error', async () => {
    const t = stub(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const err = await voyageReranker({ apiKey: 'k', model: 'm', fetch: t.fn })
      .rerank('q', docs, 1)
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(VoyageError);
    expect((err as VoyageError).kind).toBe('timeout');
    expect(t.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const net = stub(() => {
      throw new TypeError('fetch failed');
    });
    await expect(
      voyageReranker({ apiKey: 'k', model: 'm', fetch: net.fn }).rerank('q', docs, 1),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('rerank.caps-retry-after-at-5s', async () => {
    vi.useFakeTimers();
    try {
      const s = stub((n) =>
        n === 1
          ? json({}, 429, { 'retry-after': '30' })
          : json({ data: [{ index: 0, relevance_score: 1 }] }),
      );
      const p = voyageReranker({ apiKey: 'k', model: 'm', fetch: s.fn }).rerank('q', docs, 1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(s.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rerank.rejects-out-of-range-index', async () => {
    const s = stub(() => json({ data: [{ index: 9, relevance_score: 1 }] }));
    await expect(
      voyageReranker({ apiKey: 'k', model: 'm', fetch: s.fn }).rerank('q', docs, 1),
    ).rejects.toMatchObject({ kind: 'bad-response' });
  });

  it('network.import-makes-no-call', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('network call at import');
    }) as typeof fetch;
    try {
      vi.resetModules();
      await import('./index.js');
    } finally {
      globalThis.fetch = orig;
    }
  });
});
