import * as fs from 'node:fs';
import * as path from 'node:path';
import * as util from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  MissingCredentialError,
  JudgmentInputError,
  ScopeDeniedError,
  setAgentStar,
} from '@oortmem/core';
import { tmpdir } from '../../test/helpers.js';
import { FAKE_DIMENSION, fakeAdapters } from '../../test/helpers/sdk-fakes.js';
import { OortCloudError } from '../cloud.js';
import { OortRelayError } from '../relay.js';
import { Refusal } from '../util.js';
import { createOort, createOortWith } from './create.js';
import {
  OortError,
  OortInternalError,
  OortNeedsKeyError,
  OortRefusedError,
  OortUsageError,
  toOortError,
} from './errors.js';
import * as sdk from './index.js';
import type { OortOptions } from './types.js';

const NOW = new Date('2026-11-06T12:00:00.000Z');

/** Assembled at runtime so no key-shaped literal sits in source. */
const fakeKey = (p: string): string => [p, 'TESTKEY', 'x'.repeat(40)].join('-');

function home(): { home: string; env: Record<string, string> } {
  const root = tmpdir('oort-sdk-');
  return { home: path.join(root, 'home'), env: { HOME: root, OORT_NO_KEYCHAIN: '1' } };
}

async function local(over: OortOptions = {}) {
  const h = home();
  const oort = await createOortWith(
    { mode: 'local', home: h.home, env: h.env, project: null, ...over },
    { adapters: fakeAdapters(), now: () => NOW },
  );
  return { oort, ...h };
}

describe('createOort, local mode', () => {
  it('remembers, recalls, renders, pins, explains and forgets', async () => {
    const { oort } = await local();
    const saved = await oort.remember('We deploy the billing service on Fridays.');
    expect(saved.results).toEqual([{ fact: 0, outcome: 'added', id: expect.any(String) }]);
    const id = saved.results[0]!.id!;
    const r = await oort.recall('when do we deploy billing?');
    expect(r.memories.map((m) => m.id)).toContain(id);
    expect(r.memories[0]).toMatchObject({ status: 'current', type: 'semantic', pinned: false });
    expect(sdk.formatForPrompt(r)).toMatch(/^<oort-memory>\n- \[semantic, today\] We deploy/);
    expect(await oort.pin(id.slice(0, 8))).toEqual({ id, pinned: true, changed: true });
    expect(await oort.pin(id)).toEqual({ id, pinned: true, changed: false });
    expect(await oort.unpin(id)).toEqual({ id, pinned: false, changed: true });
    const ex = await oort.explain(id);
    expect(ex.memory).toMatchObject({ id, source: 'sdk', status: 'current' });
    expect(ex.chain.map((c) => c.id)).toEqual([id]);
    expect((await oort.recent()).memories.map((m) => m.id)).toEqual([id]);
    expect(await oort.forget(id)).toEqual({ forgotten: id });
    await expect(oort.explain(id)).rejects.toMatchObject({ code: 'not-found' });
    await oort.close();
  });

  it('unlink leaves a link confirmed at a terminal in place (CON-148)', async () => {
    const { oort, home: dir, env } = await local();
    const saved = await oort.remember(['The cache is redis.', 'The queue is sqs.']);
    const [a, b] = saved.results.map((r) => r.id!) as [string, string];
    await oort.link(a, b);
    await oort.close();
    // As `oort link` confirmed at a terminal records it.
    const { openSqliteStore } = await import('@oortmem/store-sqlite');
    const { localGrant } = await import('@oortmem/core');
    const store = await openSqliteStore({
      path: path.join(dir, 'oort.sqlite'),
      coldDir: path.join(dir, 'cold'),
      dimension: FAKE_DIMENSION,
    });
    const g = localGrant({ orgId: 'local', customerId: 'self', agentId: 'x', projectIds: [null] });
    expect(await store.link!(g, a, b, { assertedBy: 'user' })).toMatchObject({
      assertedBy: 'user',
    });
    await store.close();
    const again = await createOortWith(
      { mode: 'local', home: dir, env, project: null },
      { adapters: fakeAdapters(), now: () => NOW },
    );
    await expect(again.unlink(a, b)).rejects.toMatchObject({
      code: 'refused',
      reason: 'asserted-by-user',
    });
    expect((await again.explain(a)).links).toMatchObject([{ id: b, assertedBy: 'user' }]);
    await again.close();
  });

  it('observes a turn through the write path, harness sdk', async () => {
    const { oort } = await local();
    const r = await oort.observe({ user: 'Our staging DB is on port 6543.', assistant: 'Noted.' });
    expect(r).toMatchObject({ outcome: 'added', counts: { added: 1 } });
    const skipped = await oort.observe({ user: 'hello there', assistant: 'Hi!' });
    expect(skipped.outcome).toBe('skipped');
    await oort.close();
  });

  it('reports lexical-only without models, and needs-key for a write', async () => {
    const h = home();
    const oort = await createOort({ mode: 'local', home: h.home, env: h.env, keySources: [] });
    const r = await oort.recall('anything');
    expect(r.warnings.map((w) => w.code)).toContain('lexical-only');
    const err = await oort.observe({ user: 'a', assistant: 'b' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OortNeedsKeyError);
    expect(err).toMatchObject({
      code: 'needs-key',
      reason: 'missing-key',
      role: 'embed',
      envVar: 'VOYAGE_API_KEY',
      fix: 'oort models pull',
    });
    expect((await oort.whoami()).routes).toEqual({
      embed: 'missing',
      rerank: 'missing',
      decide: 'missing',
      write: 'missing',
    });
    await oort.close();
  });

  it('a closed handle refuses every call; close is idempotent; a child close does nothing', async () => {
    const { oort } = await local();
    const child = oort.scoped({ agent: 'bot' });
    await child.close();
    await expect(child.recall('x')).resolves.toBeDefined();
    await oort.close();
    await oort.close();
    for (const call of [() => oort.recall('x'), () => child.whoami(), () => oort.judge.list()]) {
      await expect(call()).rejects.toMatchObject({ code: 'usage', reason: 'closed' });
    }
    expect(() => oort.scoped({ agent: 'x' })).toThrow(OortUsageError);
  });

  it('an aborted signal rejects with its own reason, before any I/O', async () => {
    const { oort } = await local();
    const why = new Error('stop');
    const ac = new AbortController();
    ac.abort(why);
    await expect(oort.recall('x', { signal: ac.signal })).rejects.toBe(why);
    await expect(oort.observe({ user: 'a', assistant: 'b' }, { signal: ac.signal })).rejects.toBe(
      why,
    );
    await oort.close();
  });

  it('await using closes the handle', async () => {
    const h = home();
    let handle: Awaited<ReturnType<typeof createOort>> | undefined;
    {
      await using oort = await createOortWith(
        { mode: 'local', home: h.home, env: h.env },
        { adapters: fakeAdapters() },
      );
      handle = oort;
    }
    await expect(handle.recall('x')).rejects.toMatchObject({ reason: 'closed' });
  });
});

describe('key handling (§6.6)', () => {
  it('never shows an explicit key: inspect, JSON and errors', async () => {
    const h = home();
    const keys = { voyage: fakeKey('pa'), oort: fakeKey('oort_sk') };
    const oort = await createOort({
      mode: 'local',
      home: h.home,
      env: h.env,
      keys,
      keySources: ['explicit'],
    });
    const shown = [
      util.inspect(oort, { showHidden: true, depth: Infinity }),
      JSON.stringify(oort),
      String(oort),
      util.inspect(oort.judge, { showHidden: true, depth: Infinity }),
      util.inspect(oort.scoped({ agent: 'bot' }), { showHidden: true, depth: Infinity }),
    ].join('\n');
    expect(shown).not.toContain('TESTKEY');
    expect(util.inspect(oort)).toMatch(/^Oort \{"mode":"local"/);
    expect(Object.keys(oort)).toEqual([]);
    expect((await oort.whoami()).routes.embed).toBe('own-key');
    await oort.close();
  });

  it('wraps a vendor error by its class name only', () => {
    const e = new TypeError(`401 invalid x-api-key ${fakeKey('sk-ant')}`);
    const mapped = toOortError(e);
    expect(mapped).toBeInstanceOf(OortInternalError);
    expect(mapped.message).toBe('An internal error stopped this call (TypeError).');
    expect(JSON.stringify(mapped) + mapped.message + String(mapped.cause)).not.toContain('TESTKEY');
  });
});

describe('principal rules (§6.4)', () => {
  it('user needs an explicit org that is not local; self is never derivable', async () => {
    const h = home();
    const base = { mode: 'local' as const, home: h.home, env: h.env };
    await expect(createOort({ ...base, user: 'u1' })).rejects.toMatchObject({
      code: 'usage',
      reason: 'principal-required',
    });
    await expect(createOort({ ...base, user: 'u1', org: 'local' })).rejects.toMatchObject({
      reason: 'principal-required',
    });
    await expect(createOort({ ...base, user: 'self', org: 'acme' })).rejects.toMatchObject({
      reason: 'self-not-derivable',
    });
    const root = await createOortWith({ ...base, org: 'acme' }, { adapters: fakeAdapters() });
    expect(() => root.scoped({ user: 'self' })).toThrow(
      expect.objectContaining({ code: 'usage', reason: 'self-not-derivable' }),
    );
    const person = await createOortWith(base, { adapters: fakeAdapters() });
    expect(() => person.scoped({ user: 'u1' })).toThrow(
      expect.objectContaining({ reason: 'principal-required' }),
    );
    expect(() => root.scoped({ judgeRole: 'expert' as 'agent' })).toThrow(OortUsageError);
    await root.close();
    await person.close();
  });

  it('an agent configured as a Star is refused with a user', async () => {
    const h = home();
    fs.mkdirSync(h.home, { recursive: true });
    setAgentStar(h.home, 'cursor', true);
    const base = { mode: 'local' as const, home: h.home, env: h.env, org: 'acme' };
    await expect(createOort({ ...base, agent: 'cursor', user: 'u1' })).rejects.toMatchObject({
      code: 'refused',
      reason: 'star-with-user',
    });
    const root = await createOortWith(base, { adapters: fakeAdapters() });
    expect(() => root.scoped({ agent: 'cursor', user: 'u1' })).toThrow(OortRefusedError);
    expect(() => root.scoped({ user: 'u1' }).scoped({ agent: 'cursor' })).toThrow(
      expect.objectContaining({ reason: 'star-with-user' }),
    );
    await root.close();
  });

  it('an end user handle has no Star: include star is refused, and whoami says Planet only', async () => {
    const { oort } = await local({ org: 'acme' });
    const u1 = oort.scoped({ user: 'u1', agent: 'bot' });
    await expect(u1.recall('x', { include: ['star'] })).rejects.toMatchObject({
      code: 'refused',
      reason: 'scope-denied',
    });
    expect(await u1.whoami()).toMatchObject({
      user: 'u1',
      agent: 'bot',
      reads: ['Planet u1'],
      writesTo: 'Planet u1',
    });
    await oort.close();
  });

  it('rejects invalid ids before any I/O', async () => {
    const h = home();
    const base = { mode: 'local' as const, home: h.home, env: h.env };
    await expect(createOort({ ...base, agent: 'Not An Agent' })).rejects.toMatchObject({
      code: 'usage',
    });
    await expect(createOort({ ...base, agent: 'anonymous' })).rejects.toMatchObject({
      code: 'usage',
    });
    await expect(createOort({ ...base, org: 'a b', user: 'u' })).rejects.toMatchObject({
      code: 'usage',
    });
    expect(fs.existsSync(h.home)).toBe(false);
  });
});

describe('options are checked strictly (§4.1)', () => {
  it('refuses an unknown option, and one the mode does not take', async () => {
    const h = home();
    const base = { home: h.home, env: { ...h.env, OORT_API_KEY: fakeKey('oort_sk') } };
    await expect(createOort({ ...base, mode: 'local', place: {} } as never)).rejects.toMatchObject({
      code: 'usage',
      reason: 'invalid-argument',
      message: expect.stringContaining('place'),
    });
    await expect(
      createOort({ env: base.env, mode: 'cloud', keys: { voyage: fakeKey('pa') } }),
    ).rejects.toMatchObject({ code: 'usage', message: expect.stringContaining('keys.voyage') });
    // Cloud mode takes user (CON-132) under the same rules: an explicit org, never `local`.
    await expect(createOort({ env: base.env, mode: 'cloud', user: 'u' })).rejects.toMatchObject({
      code: 'usage',
      reason: 'principal-required',
    });
    await expect(
      createOort({ ...base, mode: 'local', url: 'https://x.test' }),
    ).rejects.toMatchObject({ code: 'usage', message: expect.stringContaining('url') });
    await expect(
      createOort({ ...base, mode: 'local', config: { serve: { autostart: true } } as never }),
    ).rejects.toMatchObject({ code: 'usage' });
    await expect(
      createOort({ ...base, mode: 'local', config: { recall: { nope: 1 } } }),
    ).rejects.toMatchObject({ code: 'usage', message: expect.stringContaining('config.recall') });
  });

  it('cloud mode without an Oort key is needs-login', async () => {
    const h = home();
    await expect(createOort({ mode: 'cloud', env: h.env })).rejects.toMatchObject({
      code: 'needs-login',
      reason: 'no-key',
      fix: 'oort login',
    });
  });
});

describe('toOortError (§5): every source maps to its code and reason', () => {
  const cases: [unknown, string, string | undefined][] = [
    [new OortCloudError('unauthorized', 401), 'needs-login', 'key-rejected'],
    [new OortCloudError('payment-required', 402), 'refused', 'payment-required'],
    [new OortCloudError('not-enabled', 403), 'refused', 'not-enabled'],
    [new OortCloudError('hive-not-enabled', 403), 'refused', 'hive-not-enabled'],
    [new OortCloudError('rate-limit', 429), 'refused', 'rate-limit'],
    [new OortCloudError('too-large', 413), 'usage', 'too-large'],
    [new OortCloudError('bad-request', 400), 'usage', 'bad-request'],
    [new OortCloudError('bad-request', 400, 'x', 'scope_denied'), 'refused', 'scope-denied'],
    [new OortCloudError('not-found', 404), 'not-found', undefined],
    [new OortCloudError('ambiguous-prefix', 409), 'ambiguous-id', undefined],
    [
      new OortCloudError('bad-request', 409, 'x', 'preview_required'),
      'needs-confirmation',
      'preview-required',
    ],
    [
      new OortCloudError('bad-request', 409, 'x', 'findings_unacknowledged'),
      'needs-confirmation',
      'findings-unacknowledged',
    ],
    [new OortCloudError('end-user-limit', 402, 'x', 'end_user_limit'), 'refused', 'end-user-limit'],
    [new OortCloudError('end-users-unsupported', 0), 'refused', 'end-users-unsupported'],
    [
      new OortCloudError('refused', 403, 'x', 'end_users_not_allowed'),
      'refused',
      'end-users-not-allowed',
    ],
    [new OortCloudError('bad-request', 400, 'x', 'user_missing'), 'usage', 'user-missing'],
    [
      new OortCloudError('bad-request', 400, 'x', 'self_not_derivable'),
      'usage',
      'self-not-derivable',
    ],
    [new OortCloudError('bad-request', 400, 'x', 'bad_user'), 'usage', 'bad-user'],
    [new OortCloudError('bad-request', 400, 'x', 'star_with_user'), 'refused', 'star-with-user'],
    [
      new OortCloudError('bad-request', 400, 'x', 'user_not_supported'),
      'usage',
      'user-not-supported',
    ],
    [new OortCloudError('bad-request', 409, 'x', 'end_user_erased'), 'refused', 'end-user-erased'],
    [new OortCloudError('busy', 503), 'network', 'busy'],
    [new OortCloudError('network', 0), 'network', 'unreachable'],
    [new OortCloudError('network', 0, undefined, 'timeout'), 'network', 'timeout'],
    [new OortRelayError('unauthorized', 401), 'needs-login', 'key-rejected'],
    [new OortRelayError('rate-limit', 429), 'refused', 'rate-limit'],
    [new MissingCredentialError('TYPESAFE_API_KEY', 'decide.apiKey'), 'needs-key', 'missing-key'],
    [new JudgmentInputError('bad'), 'usage', 'invalid-argument'],
    [new ScopeDeniedError(['star']), 'refused', 'scope-denied'],
    [
      Object.assign(new Error('m'), { name: 'StoreMigrationRequiredError' }),
      'refused',
      'migration-required',
    ],
    [Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }), 'internal', 'store-busy'],
    [
      Object.assign(new Error('x'), { name: 'EmbedderMismatchError' }),
      'usage',
      'embedder-mismatch',
    ],
    [
      new Refusal('scope_denied: bot cannot read star', { code: 'refused' }),
      'refused',
      'scope-denied',
    ],
    [new Refusal('No such memory.', { code: 'not-found' }), 'not-found', undefined],
    [Object.assign(new TypeError('fetch failed')), 'network', 'unreachable'],
    [new Error('boom'), 'internal', undefined],
  ];
  it.each(cases)('%s', (e, code, reason) => {
    const m = toOortError(e);
    expect(m).toBeInstanceOf(OortError);
    expect(m.code).toBe(code);
    expect(m.reason).toBe(reason);
    expect(m.retryable).toBe(
      code === 'network' || reason === 'store-busy' || reason === 'rate-limit',
    );
  });

  it('drops the CLI-only fixes', () => {
    const m = toOortError(new Refusal('needs a confirmation', { code: 'needs-confirmation' }));
    expect(m.fix).toBeNull();
    const k = toOortError(new MissingCredentialError('TYPESAFE_API_KEY', 'decide.apiKey'));
    expect(k).toMatchObject({ fix: 'oort keys set typesafe', role: 'decide' });
  });

  it('every class is exported from the root with its name', () => {
    for (const name of [
      'OortError',
      'OortUsageError',
      'OortNotFoundError',
      'OortAmbiguousIdError',
      'OortNeedsKeyError',
      'OortNeedsLoginError',
      'OortNeedsConfirmationError',
      'OortCloudOnlyError',
      'OortNetworkError',
      'OortRefusedError',
      'OortInternalError',
    ] as const) {
      expect(typeof sdk[name]).toBe('function');
    }
    expect(new sdk.OortRefusedError('x').name).toBe('OortRefusedError');
  });
});
