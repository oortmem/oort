import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index.js';
import type { RelayEnv } from './relay.js';
import { sqliteD1 } from './test/d1-sqlite.js';

const env = (): RelayEnv => ({
  DB: sqliteD1(),
  RATE_LIMITER: { limit: async () => ({ success: true }) },
  AUTH_LIMITER: { limit: async () => ({ success: true }) },
  VOYAGE_API_KEY: 'v',
  TYPESAFE_API_KEY: 't',
  ANTHROPIC_API_KEY: 'a',
});

afterEach(() => vi.restoreAllMocks());

describe('the Worker entry', () => {
  it('logs one line per request with the status and duration only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const secret = 'oort_sk_' + 'S'.repeat(43);
    const res = await worker.fetch(
      new Request('https://relay.oortcloud.dev/v1/voyage/embeddings?q=private', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'cf-connecting-ip': '203.0.113.1' },
        body: '{"input":"my private memory"}',
      }),
      env(),
      { waitUntil: () => undefined },
    );
    expect(res.status).toBe(401);
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(log.mock.calls[0]![0])) as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(['ms', 'status']);
    expect(line['status']).toBe(401);
    expect(typeof line['ms']).toBe('number');
  });
});
