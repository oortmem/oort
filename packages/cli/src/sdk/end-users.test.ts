import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../../test/helpers.js';
import { fakeCloud, type FakeCloud } from '../../test/helpers/fake-cloud.js';
import { fakeAdapters } from '../../test/helpers/sdk-fakes.js';
import { END_USERS_UNSUPPORTED, OortCloudError, cloudErrorKind } from '../cloud.js';
import { createOortWith } from './create.js';
import { toOortError } from './errors.js';
import type { OortOptions } from './types.js';

/**
 * Per-user memory in Oort Cloud (CON-132): a server key sends `Oort-User` from an end user's
 * handle, and only once whoami lists the key's `end-users` capability. An Oort Cloud from before
 * CON-132 ignores the header and would write the account's own Planet, so the SDK never sends it
 * to one.
 */

const KEY = ['oort', 'sk', 'endusers'.padEnd(43, 'E')].join('_');

async function cloud(setup: (c: FakeCloud) => void = () => {}, over: OortOptions = {}) {
  const root = tmpdir('oort-sdk-endusers-');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const c = fakeCloud(KEY);
  setup(c);
  const env = { HOME: root, OORT_HOME: path.join(root, 'home'), OORT_NO_KEYCHAIN: '1' };
  const oort = await createOortWith(
    {
      mode: 'cloud',
      cwd,
      env: { ...env, OORT_API_KEY: KEY },
      fetch: c.fetch,
      keySources: ['env'],
      project: null,
      org: 'acme',
      ...over,
    },
    {},
  );
  return { oort, c };
}

/** The `Oort-User` each request carried, with its route. */
const sent = (c: FakeCloud): [string, string | null][] =>
  c.seen.map((r, i) => [r, c.endUsers.headers[i] ?? null]);

describe('cloud end users (CON-132)', () => {
  it('sdk.end-users-header-only-on-an-end-user-handle', async () => {
    const { oort, c } = await cloud((c) => (c.endUsers.serverKey = true));
    const ada = oort.scoped({ user: 'ada', agent: 'bot' });
    const saved = await ada.remember('My order number is 1042.');
    const id = saved.results[0]!.id!;
    await ada.recall('order number');
    await ada.recent();
    await ada.pin(id);
    await ada.unpin(id);
    await ada.explain(id);
    expect(await ada.whoami()).toMatchObject({
      mode: 'cloud',
      user: 'ada',
      reads: ['Planet ada'],
      writesTo: 'Planet ada',
    });
    await ada.forget(id);
    for (const [route, user] of sent(c)) {
      // whoami acts as the account; every memory route names the end user.
      expect([route, user]).toEqual([route, route === 'GET /v1/whoami' ? null : 'ada']);
    }
    expect(sent(c).filter(([r]) => r === 'GET /v1/whoami').length).toBe(2); // check + whoami()
    await oort.close();
  });

  it('sdk.end-users-never-from-an-unscoped-handle', async () => {
    const { oort, c } = await cloud();
    const bot = oort.scoped({ agent: 'bot', project: 'web' });
    const saved = await oort.remember('We deploy on Fridays.');
    const id = saved.results[0]!.id!;
    await oort.recall('deploy');
    await bot.recall('deploy');
    await oort.observe({ user: 'Lunch is at noon.', assistant: 'Noted.' });
    await oort.recent();
    await oort.pin(id);
    await oort.explain(id);
    await oort.whoami();
    await oort.forget(id);
    expect(c.endUsers.headers.length).toBeGreaterThan(8);
    expect(c.endUsers.headers.every((h) => h === null)).toBe(true);
    await oort.close();
  });

  it('sdk.end-users-refused-by-an-older-cloud-sends-nothing', async () => {
    const { oort, c } = await cloud((c) => (c.endUsers.server = 'legacy'));
    const ada = oort.scoped({ user: 'ada' });
    for (const call of [
      () => ada.remember('My order number is 1042.'),
      () => ada.observe({ user: 'My order number is 1042.', assistant: 'Noted.' }),
      () => ada.recall('order'),
      () => ada.recent(),
      () => ada.forget('11111111'),
      () => ada.pin('11111111'),
      () => ada.explain('11111111'),
      () => oort.endUsers.count(),
      () => oort.endUsers.erase('ada'),
    ]) {
      await expect(call()).rejects.toMatchObject({
        name: 'OortRefusedError',
        code: 'refused',
        reason: 'end-users-unsupported',
        retryable: false,
        fix: null,
        message: END_USERS_UNSUPPORTED,
      });
    }
    // Only whoami went out (a refusal is asked again, never kept), and nothing was written.
    expect(new Set(c.seen)).toEqual(new Set(['GET /v1/whoami']));
    expect(c.endUsers.headers.every((h) => h === null)).toBe(true);
    expect(c.memories.size).toBe(0);
    await oort.close();
  });

  it('sdk.end-users-refused-for-a-key-without-the-capability', async () => {
    const { oort, c } = await cloud();
    await expect(oort.scoped({ user: 'ada' }).remember('x is y')).rejects.toMatchObject({
      reason: 'end-users-unsupported',
    });
    expect(c.seen).toEqual(['GET /v1/whoami']);
    await oort.close();
  });

  it('sdk.end-users-capability-checked-once-per-root-and-again-after-a-refusal', async () => {
    const { oort, c } = await cloud((c) => (c.endUsers.server = 'legacy'));
    const ada = oort.scoped({ user: 'ada' });
    await expect(ada.recall('x')).rejects.toMatchObject({ reason: 'end-users-unsupported' });
    // The cloud is upgraded and the key made a server key: no restart needed.
    c.endUsers.server = 'current';
    c.endUsers.serverKey = true;
    await Promise.all([
      ada.remember('Ada likes tea.'),
      oort.scoped({ user: 'bob' }).remember('Bob likes coffee.'),
      ada.recall('tea'),
    ]);
    await oort.scoped({ user: 'cy' }).recent();
    await oort.endUsers.count();
    expect(c.seen.filter((r) => r === 'GET /v1/whoami').length).toBe(2);
    await oort.close();
  });

  it('sdk.end-users-a-root-handle-made-for-an-end-user', async () => {
    const { oort, c } = await cloud((c) => (c.endUsers.serverKey = true), { user: 'ada' });
    await oort.remember('Ada likes tea.');
    expect((await oort.whoami()).user).toBe('ada');
    expect(c.endUsers.users.get('ada')?.memories.size).toBe(1);
    expect(c.memories.size).toBe(0);
    await expect(oort.endUsers.count()).rejects.toMatchObject({
      code: 'usage',
      reason: 'user-not-supported',
    });
    await oort.close();
  });

  it('sdk.end-users-erase-and-count', async () => {
    const { oort, c } = await cloud((c) => (c.endUsers.serverKey = true));
    await oort.scoped({ user: 'ada' }).remember(['Ada likes tea.', 'Ada lives in Lund.']);
    await oort.scoped({ user: 'bob' }).remember('Bob likes coffee.');
    expect(await oort.endUsers.count()).toEqual({ endUsers: 2, limit: 100 });
    expect(await oort.endUsers.erase('ada')).toEqual({
      erased: 'ada',
      memories: 2,
      coldCopies: 0,
      turnRefs: 0,
      cursors: 0,
    });
    expect(await oort.endUsers.count()).toEqual({ endUsers: 1, limit: 100 });
    expect((await oort.scoped({ user: 'ada' }).recall('tea')).memories).toEqual([]);
    expect((await oort.scoped({ user: 'bob' }).recall('coffee')).memories).toHaveLength(1);
    // Account routes: never with Oort-User.
    const accountRoutes = sent(c).filter(([r]) => r.includes('/v1/end-users'));
    expect(accountRoutes).toEqual([
      ['GET /v1/end-users/count', null],
      ['DELETE /v1/end-users/ada', null],
      ['GET /v1/end-users/count', null],
    ]);
    await expect(oort.endUsers.erase('self')).rejects.toMatchObject({
      reason: 'self-not-derivable',
    });
    await expect(oort.endUsers.erase('')).rejects.toMatchObject({ reason: 'user-missing' });
    await expect(oort.endUsers.erase('bad id')).rejects.toMatchObject({
      reason: 'invalid-argument',
    });
    await oort.close();
  });

  it('sdk.end-users-the-same-client-side-rules-as-local', async () => {
    const { oort, c } = await cloud((c) => (c.endUsers.serverKey = true));
    expect(() => oort.scoped({ user: 'self' })).toThrow(
      expect.objectContaining({ reason: 'self-not-derivable' }),
    );
    expect(() => oort.scoped({ user: '' })).toThrow(
      expect.objectContaining({ reason: 'user-missing' }),
    );
    expect(() => oort.scoped({ user: undefined as unknown as string })).toThrow(
      expect.objectContaining({ reason: 'user-missing' }),
    );
    const ada = oort.scoped({ user: 'ada' });
    await expect(ada.recall('x', { include: ['star'] })).rejects.toMatchObject({
      code: 'refused',
      reason: 'scope-denied',
    });
    await expect(ada.recall('x', { include: ['constellation'] })).rejects.toMatchObject({
      reason: 'scope-denied',
    });
    await expect(ada.forget('11111111', { everywhere: true })).rejects.toMatchObject({
      code: 'usage',
      reason: 'user-not-supported',
    });
    expect(c.seen).toEqual([]);
    // `user` needs an explicit org other than `local`, in cloud mode too.
    const { oort: noOrg } = await cloud(() => {}, { org: undefined });
    expect(() => noOrg.scoped({ user: 'ada' })).toThrow(
      expect.objectContaining({ reason: 'principal-required' }),
    );
    await noOrg.close();
    await oort.close();
  });

  it('sdk.end-users-a-server-key-never-acts-as-the-account', async () => {
    const { oort } = await cloud((c) => (c.endUsers.serverKey = true));
    await expect(oort.recall('x')).rejects.toMatchObject({
      code: 'usage',
      reason: 'user-missing',
      status: 400,
    });
    await oort.close();
  });

  it('sdk.end-users-each-cloud-refusal-maps', async () => {
    const { oort, c } = await cloud((c) => (c.endUsers.serverKey = true));
    const ada = oort.scoped({ user: 'ada' });
    const table: [number, string, Record<string, unknown>][] = [
      [400, 'user_missing', { code: 'usage', reason: 'user-missing' }],
      [400, 'self_not_derivable', { code: 'usage', reason: 'self-not-derivable' }],
      [400, 'bad_user', { code: 'usage', reason: 'invalid-argument' }],
      [400, 'star_with_user', { code: 'refused', reason: 'star-with-user' }],
      [400, 'scope_denied', { code: 'refused', reason: 'scope-denied' }],
      [400, 'user_not_supported', { code: 'usage', reason: 'user-not-supported' }],
      [402, 'end_user_limit', { code: 'refused', reason: 'end-user-limit' }],
      [403, 'end_users_not_allowed', { code: 'refused', reason: 'end-users-not-allowed' }],
      [409, 'end_user_erased', { code: 'refused', reason: 'end-user-erased' }],
    ];
    for (const [status, code, want] of table) {
      c.fail = { 'POST /v1/observe': { status, code } };
      await expect(ada.remember('x is y')).rejects.toMatchObject({
        ...want,
        status,
        retryable: false,
        fix: null,
      });
      expect(
        toOortError(new OortCloudError(cloudErrorKind(status, code), status, 'm', code)),
      ).toMatchObject(want);
    }
    await oort.close();
  });

  it('sdk.end-users-is-cloud-only', async () => {
    const root = tmpdir('oort-sdk-endusers-local-');
    const oort = await createOortWith(
      {
        mode: 'local',
        home: path.join(root, 'home'),
        env: { HOME: root, OORT_NO_KEYCHAIN: '1' },
        org: 'acme',
        project: null,
      },
      { adapters: fakeAdapters() },
    );
    await expect(oort.endUsers.count()).rejects.toMatchObject({
      code: 'cloud-only',
      reason: 'end-users',
    });
    await expect(oort.endUsers.erase('ada')).rejects.toMatchObject({ code: 'cloud-only' });
    await oort.close();
  });
});
