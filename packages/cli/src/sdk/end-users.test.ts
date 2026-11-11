import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../../test/helpers.js';
import { fakeCloud, type FakeCloud } from '../../test/helpers/fake-cloud.js';
import { fakeAdapters } from '../../test/helpers/sdk-fakes.js';
import {
  END_USERS_NOT_OFFERED,
  END_USERS_UNSUPPORTED,
  OortCloudError,
  cloudErrorKind,
} from '../cloud.js';
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

async function cloud(
  setup: (c: FakeCloud) => void = () => {},
  over: OortOptions = {},
  c: FakeCloud = fakeCloud(KEY),
) {
  const root = tmpdir('oort-sdk-endusers-');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
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
    // The account's end-user routes ask no whoami (security review, L-b): the older cloud has no
    // such route, and its 404 is the same refusal.
    c.seen.length = 0;
    for (const call of [() => oort.endUsers.count(), () => oort.endUsers.erase('ada')]) {
      await expect(call()).rejects.toMatchObject({
        name: 'OortRefusedError',
        code: 'refused',
        reason: 'end-users-unsupported',
        status: 404,
        retryable: false,
        message: END_USERS_NOT_OFFERED,
      });
    }
    expect(c.seen).toEqual(['GET /v1/end-users/count', 'DELETE /v1/end-users/ada']);
    expect(c.endUsers.headers.every((h) => h === null)).toBe(true);
    expect(c.memories.size).toBe(0);
    await oort.close();
  });

  it('sdk.end-users-erase-and-count-hold-while-the-account-is-blocked-or-lapsed', async () => {
    // Oort Cloud keeps end-user erasure (and export) open when Pro has lapsed or the account is
    // blocked, so a deletion request can always be honoured; whoami is a Pro route there.
    for (const state of ['lapsed', 'blocked'] as const) {
      const { oort: seeding, c } = await cloud((c) => (c.endUsers.serverKey = true));
      await seeding.scoped({ user: 'ada' }).remember(['Ada likes tea.', 'Ada lives in Lund.']);
      await seeding.close();
      const { oort } = await cloud(
        (c) => {
          c.seen.length = 0;
          if (state === 'lapsed') c.lapsed = true;
          else c.fail = { 'GET /v1/whoami': { status: 403, code: 'cloud_blocked' } };
        },
        {},
        c,
      );
      if (state === 'lapsed') {
        expect(await oort.endUsers.count()).toEqual({ endUsers: 1, limit: 100 });
      }
      expect(await oort.endUsers.export('ada')).toMatchObject({ exported: 'ada', memories: 2 });
      expect(await oort.endUsers.erase('ada')).toMatchObject({ erased: 'ada', memories: 2 });
      expect(c.seen.filter((r) => r === 'GET /v1/whoami')).toEqual([]);
      // An end user's own memory calls still check whoami first, and so are refused.
      await expect(oort.scoped({ user: 'ada' }).recall('tea')).rejects.toMatchObject({
        code: 'refused',
        status: state === 'lapsed' ? 402 : 403,
      });
      await oort.close();
    }
  });

  it('sdk.end-users-refused-for-a-key-without-the-capability', async () => {
    const { oort, c } = await cloud();
    await expect(oort.scoped({ user: 'ada' }).remember('x is y')).rejects.toMatchObject({
      reason: 'end-users-unsupported',
    });
    expect(c.seen).toEqual(['GET /v1/whoami']);
    // The account's routes go out, and Oort Cloud refuses a key that is not a server key.
    await expect(oort.endUsers.erase('ada')).rejects.toMatchObject({
      code: 'refused',
      reason: 'end-users-not-allowed',
      status: 403,
    });
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
      reason: 'bad-user',
    });
    await oort.close();
  });

  it('sdk.end-users-export', async () => {
    // CON-137: an access or portability request answered with one end user's memories.
    const { oort, c } = await cloud((c) => (c.endUsers.serverKey = true));
    await oort.scoped({ user: 'ada' }).remember(['Ada likes tea.', 'Ada lives in Lund.']);
    await oort.scoped({ user: 'bob' }).remember('Bob likes coffee.');
    const ada = await oort.endUsers.export('ada');
    expect(ada).toMatchObject({ exported: 'ada', memories: 2 });
    expect(ada.jsonl.endsWith('\n')).toBe(true);
    const [head, ...lines] = ada.jsonl.trimEnd().split('\n');
    expect(JSON.parse(head!)).toMatchObject({ oort: 'export', memories: 2 });
    const texts = lines.map((l) => (JSON.parse(l) as { text: string }).text).sort();
    expect(texts).toEqual([expect.stringContaining('tea'), expect.stringContaining('Lund')]);
    expect(ada.jsonl).not.toContain('coffee');
    // Erased, or never there: an empty export, not an error, and the same either way.
    await oort.endUsers.erase('ada');
    const erased = await oort.endUsers.export('ada');
    const never = await oort.endUsers.export('carol');
    expect(erased).toMatchObject({ exported: 'ada', memories: 0 });
    expect(never).toMatchObject({ exported: 'carol', memories: 0 });
    expect(erased.jsonl).toBe(never.jsonl);
    // The account's route, never with Oort-User; the id URL-encoded.
    await oort.endUsers.export('a1:b_c.d-e@f');
    expect(sent(c).filter(([r]) => r.endsWith('/export'))).toEqual([
      ['GET /v1/end-users/ada/export', null],
      ['GET /v1/end-users/ada/export', null],
      ['GET /v1/end-users/carol/export', null],
      ['GET /v1/end-users/a1%3Ab_c.d-e%40f/export', null],
    ]);
    // The same id rules as erase: refused before anything is sent.
    const before = c.seen.length;
    for (const [id, reason] of [
      ['self', 'self-not-derivable'],
      ['', 'user-missing'],
      ['alice\n', 'bad-user'],
      ['Root', 'bad-user'],
      ['a b', 'bad-user'],
    ] as const) {
      await expect(oort.endUsers.export(id), id).rejects.toMatchObject({ code: 'usage', reason });
    }
    expect(c.seen.length).toBe(before);
    // From an end user's own handle: refused, as erase and count are.
    await expect(oort.scoped({ user: 'bob' }).endUsers.export('bob')).rejects.toMatchObject({
      code: 'usage',
      reason: 'user-not-supported',
    });
    await oort.close();
  });

  it('sdk.end-users-export-needs-a-server-key-and-a-readable-export', async () => {
    // A key without the capability: no whoami first; Oort Cloud refuses it (security review, L-b).
    const { oort, c } = await cloud();
    await expect(oort.endUsers.export('ada')).rejects.toMatchObject({
      code: 'refused',
      reason: 'end-users-not-allowed',
      status: 403,
    });
    expect(c.seen).toEqual(['GET /v1/end-users/ada/export']);
    await oort.close();
    // An Oort Cloud from before per-user memory: its 404 is end-users-unsupported.
    const { oort: old } = await cloud((c) => (c.endUsers.server = 'legacy'));
    await expect(old.endUsers.export('ada')).rejects.toMatchObject({
      reason: 'end-users-unsupported',
      status: 404,
      message: END_USERS_NOT_OFFERED,
    });
    await old.close();
    // The API's own refusal maps like erase's.
    const { oort: o2, c: c2 } = await cloud((c) => (c.endUsers.serverKey = true));
    c2.fail = { 'GET /v1/end-users/:id/export': { status: 403, code: 'end_users_not_allowed' } };
    await expect(o2.endUsers.export('ada')).rejects.toMatchObject({
      code: 'refused',
      reason: 'end-users-not-allowed',
    });
    // An answer that is not an export is never handed on as one.
    c2.fail = { 'GET /v1/end-users/:id/export': 'garbage' };
    await expect(o2.endUsers.export('ada')).rejects.toMatchObject({ code: 'internal' });
    await o2.close();
  });

  it('sdk.end-users-export-holds-only-that-end-users-memories-in-version-1', async () => {
    // A server-side mix-up must never reach the person as their data (security review): a line
    // of another end user, of the account, or a format this SDK does not check is refused.
    const line = (customerId: string) =>
      JSON.stringify({ id: 'm1', text: 't', scope: { orgId: 'acct:a1', customerId } });
    const answers: Record<string, string> = {
      ok: [{ oort: 'export', version: 1, memories: 1, scopes: [] }, null]
        .map((h) => (h === null ? line('u:ada') : JSON.stringify(h)))
        .join('\n'),
      v2: [
        JSON.stringify({ oort: 'export', version: 2, memories: 1, scopes: [] }),
        line('u:ada'),
      ].join('\n'),
      bob: [
        JSON.stringify({ oort: 'export', version: 1, memories: 1, scopes: [] }),
        line('u:bob'),
      ].join('\n'),
      account: [
        JSON.stringify({ oort: 'export', version: 1, memories: 1, scopes: [] }),
        line('self'),
      ].join('\n'),
      noScope: [
        JSON.stringify({ oort: 'export', version: 1, memories: 1, scopes: [] }),
        JSON.stringify({ id: 'm1', text: 't' }),
      ].join('\n'),
    };
    let answer = 'ok';
    const c = fakeCloud(KEY);
    c.endUsers.serverKey = true;
    const fetch: typeof globalThis.fetch = async (input, init) =>
      new URL(new Request(input, init).url).pathname.endsWith('/export')
        ? new Response(`${answers[answer]}\n`, {
            headers: { 'content-type': 'application/x-ndjson' },
          })
        : c.fetch(input, init);
    const { oort } = await cloud(() => {}, { fetch }, c);
    expect(await oort.endUsers.export('ada')).toMatchObject({ exported: 'ada', memories: 1 });
    for (const bad of ['v2', 'bob', 'account', 'noScope']) {
      answer = bad;
      await expect(oort.endUsers.export('ada'), bad).rejects.toMatchObject({
        name: 'OortInternalError',
        code: 'internal',
      });
    }
    await oort.close();
  });

  it('sdk.end-users-erase-needs-what-was-erased-in-the-answer', async () => {
    // Re-review info: a 2xx without the `erased` object is no proof anything was erased.
    const c = fakeCloud(KEY);
    let body: unknown = {};
    const fetch: typeof c.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url);
      if (init?.method === 'DELETE' && url.pathname.startsWith('/v1/end-users/')) {
        return Response.json(body);
      }
      return c.fetch(input, init);
    };
    const { oort } = await cloud((c) => (c.endUsers.serverKey = true), { fetch }, c);
    for (const b of [{}, { erased: null }, { erased: 'yes' }, { erased: [1] }, ['erased']]) {
      body = b;
      await expect(oort.endUsers.erase('ada'), JSON.stringify(b)).rejects.toMatchObject({
        code: 'internal',
        name: 'OortInternalError',
      });
    }
    body = { erased: {} };
    expect(await oort.endUsers.erase('ada')).toMatchObject({ erased: 'ada', memories: 0 });
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

  it('sdk.end-users-a-user-handle-never-switches-users', async () => {
    const { oort, c } = await cloud((c) => (c.endUsers.serverKey = true));
    const ada = oort.scoped({ user: 'ada' });
    expect(() => ada.scoped({ user: 'bob' })).toThrow(
      expect.objectContaining({ code: 'usage', reason: 'user-hop' }),
    );
    expect(() => ada.scoped({ user: 'ada' }).scoped({ agent: 'bot', project: null })).not.toThrow();
    // A root handle made for an end user is held to it too.
    const { oort: forAda } = await cloud((c) => (c.endUsers.serverKey = true), { user: 'ada' });
    expect(() => forAda.scoped({ user: 'bob' })).toThrow(
      expect.objectContaining({ reason: 'user-hop' }),
    );
    expect(c.seen).toEqual([]);
    await forAda.close();
    await oort.close();
  });

  it('sdk.end-users-ids-are-never-trimmed-and-reserved-names-are-refused', async () => {
    const { oort, c } = await cloud((c) => (c.endUsers.serverKey = true));
    for (const id of ['alice\n', ' alice', 'COUNT', 'Root', '-x', '_x', 'a'.repeat(129)]) {
      expect(() => oort.scoped({ user: id }), id).toThrow(
        expect.objectContaining({ reason: 'bad-user' }),
      );
      await expect(oort.endUsers.erase(id), id).rejects.toMatchObject({ reason: 'bad-user' });
    }
    expect(c.seen).toEqual([]);
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
      [400, 'bad_user', { code: 'usage', reason: 'bad-user' }],
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
    await expect(oort.endUsers.export('ada')).rejects.toMatchObject({
      code: 'cloud-only',
      reason: 'end-users',
    });
    await oort.close();
  });
});
