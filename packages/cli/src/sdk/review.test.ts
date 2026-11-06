import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../../test/helpers.js';
import { fakeAdapters } from '../../test/helpers/sdk-fakes.js';
import { createOort, createOortWith } from './create.js';

/** Fixes from the independent security review of the SDK (CON-108). */

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
