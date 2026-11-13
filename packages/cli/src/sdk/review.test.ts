import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../../test/helpers.js';
import { fakeAdapters } from '../../test/helpers/sdk-fakes.js';
import { createOort, createOortWith } from './create.js';

/** Hardening of the SDK's inputs, errors and files (CON-108). */

function home(): { home: string; env: Record<string, string>; root: string } {
  const root = tmpdir('oort-sdk-review-');
  return { root, home: path.join(root, 'home'), env: { HOME: root, OORT_NO_KEYCHAIN: '1' } };
}

describe('a dropped end-user id never falls back to the operator', () => {
  it('scoped({ user: undefined | null | "" }) is user-missing; leaving the key out acts as the person', async () => {
    const h = home();
    const oort = await createOortWith(
      { mode: 'local', home: h.home, env: h.env, org: 'acme' },
      { adapters: fakeAdapters() },
    );
    const req: { user?: { id?: string } } = {};
    for (const user of [req.user?.id, null, '', '  ']) {
      expect(() => oort.scoped({ user, agent: 'support-bot' } as never)).toThrow(
        expect.objectContaining({ code: 'usage', reason: 'user-missing' }),
      );
    }
    expect((await oort.scoped({ agent: 'support-bot' }).whoami()).user).toBeNull();
    await oort.close();
  });

  it('a getter or proxy cannot pass the user check and then hand the parser undefined', async () => {
    const h = home();
    const oort = await createOortWith(
      { mode: 'local', home: h.home, env: h.env, org: 'acme' },
      { adapters: fakeAdapters() },
    );
    // Reads 'alice' once, undefined afterwards: the options are read once, so it stays alice.
    let reads = 0;
    const flaky = {
      agent: 'support-bot',
      get user() {
        return reads++ === 0 ? 'alice' : undefined;
      },
    };
    expect((await oort.scoped(flaky as never).whoami()).user).toBe('alice');
    // A proxy that says it has `user` but hands back undefined is user-missing, not the operator.
    const sneaky = new Proxy({ agent: 'support-bot' } as Record<string, unknown>, {
      has: (t, k) => k === 'user' || k in t,
    });
    expect(() => oort.scoped(sneaky as never)).toThrow(
      expect.objectContaining({ code: 'usage', reason: 'user-missing' }),
    );
    await oort.close();
  });

  it('createOort({ org, user: undefined }) is user-missing too', async () => {
    const h = home();
    for (const user of [undefined, null, '']) {
      await expect(
        createOort({ mode: 'local', home: h.home, env: h.env, org: 'acme', user } as never),
      ).rejects.toMatchObject({ code: 'usage', reason: 'user-missing' });
    }
    expect(fs.existsSync(h.home)).toBe(false);
  });
});

describe('explicit keys are never silently ignored', () => {
  it("keys with keySources leaving out 'explicit' is a usage error", async () => {
    const h = home();
    const key = ['oort', 'sk', 'given'.padEnd(43, 'G')].join('_');
    const env = { ...h.env, OORT_API_KEY: ['oort', 'sk', 'env'.padEnd(43, 'E')].join('_') };
    await expect(
      createOort({ mode: 'cloud', env, keys: { oort: key }, keySources: ['env'] }),
    ).rejects.toMatchObject({
      code: 'usage',
      reason: 'invalid-argument',
      message: expect.stringContaining('keySources'),
    });
    const fine = await createOort({
      mode: 'cloud',
      env,
      keys: { oort: key },
      keySources: ['explicit', 'env'],
    });
    await fine.close();
  });
});

describe('cloud mode and the repository config', () => {
  it('projectConfig: false lets a cloud handle in a checkout skip a broken oort.config.json', async () => {
    const h = home();
    const cwd = path.join(h.root, 'checkout');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'oort.config.json'), '{ not json');
    const env = { ...h.env, OORT_API_KEY: ['oort', 'sk', 'cfg'.padEnd(43, 'C')].join('_') };
    const fetch = (async () =>
      Response.json({ account: 'a1', plan: 'pro', via: 'key' })) as typeof globalThis.fetch;
    await expect(createOort({ mode: 'cloud', cwd, env, fetch })).rejects.toMatchObject({
      code: 'usage',
      fix: 'oort doctor',
    });
    const oort = await createOort({ mode: 'cloud', cwd, env, fetch, projectConfig: false });
    expect((await oort.whoami()).mode).toBe('cloud');
    await oort.close();
    expect(fs.existsSync(h.home)).toBe(false);
  });
});

describe('a rate limit is retryable, with Retry-After when the service sends it', () => {
  it('cloud and relay 429s', async () => {
    const { OortCloudError } = await import('../cloud.js');
    const { relayErrorOf, parseRetryAfter } = await import('../relay.js');
    const { toOortError } = await import('./errors.js');
    const cloud = toOortError(new OortCloudError('rate-limit', 429, 'cap', 'rate_limit', 30));
    expect(cloud).toMatchObject({
      code: 'refused',
      reason: 'rate-limit',
      retryable: true,
      retryAfter: 30,
    });
    const relay = toOortError(
      relayErrorOf({ status: 429, headers: new Headers({ 'retry-after': '12' }) }),
    );
    expect(relay).toMatchObject({
      code: 'refused',
      reason: 'rate-limit',
      retryable: true,
      retryAfter: 12,
    });
    expect(toOortError(relayErrorOf({ status: 429 })).retryAfter).toBeUndefined();
    const now = Date.parse('2026-11-06T12:00:00Z');
    expect(parseRetryAfter('Fri, 06 Nov 2026 12:01:00 GMT', now)).toBe(60);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    // Hostile or broken headers: never "retry now", never past an hour, never a loose date.
    expect(parseRetryAfter('9'.repeat(400), now)).toBeUndefined();
    expect(parseRetryAfter('99999999999', now)).toBeUndefined();
    expect(parseRetryAfter('86400', now)).toBe(3600);
    expect(parseRetryAfter('Fri, 31 Dec 9999 23:59:59 GMT', now)).toBe(3600);
    expect(parseRetryAfter('+275760-09-13T00:00:00Z', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
    expect(parseRetryAfter('foo 2', now)).toBeUndefined();
    expect(parseRetryAfter('1.5', now)).toBeUndefined();
    expect(parseRetryAfter('0', now)).toBe(1);
    expect(parseRetryAfter('Thu, 05 Nov 2026 12:00:00 GMT', now)).toBe(1);
  });
});

describe('error wording', () => {
  it("a user handle's scope-denied names what it reads, not a Star it does not have", async () => {
    const h = home();
    const oort = await createOortWith(
      { mode: 'local', home: h.home, env: h.env, org: 'acme' },
      { adapters: fakeAdapters() },
    );
    const err = (await oort
      .scoped({ user: 'u1', agent: 'bot' })
      .recall('x', { include: ['star'] })
      .catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: 'refused', reason: 'scope-denied' });
    expect(err.message).not.toMatch(/its own Star/);
    expect(err.message).toMatch(/reads only its Planet/);
    await oort.close();
  });
});

describe('every text field is scrubbed on read', () => {
  it("entities and a judgment's verdict, criteria, domain and by", async () => {
    const { memoryView, judgmentView } = await import('./views.js');
    const secret = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const m = {
      id: 'm1',
      scope: { orgId: 'local', customerId: 'self', agentId: 'anonymous' },
      type: 'judgment' as const,
      text: 'judgment',
      stub: '',
      entities: [`key ${secret}`],
      salience: 0.5,
      pinned: false,
      tier: 'warm' as const,
      accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: null,
      expiredAt: null,
      endReason: null,
      lastConfirmedAt: null,
      supersedes: null,
      supersededBy: null,
      source: { harness: 'cli', decisions: [] },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      judgment: {
        subject: { summary: 's' },
        verdict: `v ${secret}`,
        verdicts: ['approved', `v ${secret}`],
        reason: 'r',
        criteria: [`c ${secret}`],
        domain: `d ${secret}`,
        by: `b ${secret}`,
        decidedAt: '2026-01-01T00:00:00.000Z',
        via: 'cli' as const,
      },
    };
    const now = new Date('2026-11-05T00:00:00Z');
    const shown = JSON.stringify([memoryView(m, now), judgmentView(m.judgment, m, now)]);
    expect(shown).not.toContain(secret);
    expect(shown).toContain('REDACTED');
  });
});
