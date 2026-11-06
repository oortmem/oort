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
