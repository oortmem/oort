import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createKeychain } from './keychain.js';
import { cloudBackend } from './mcp.js';
import { runCli } from './program.js';
import { rememberTurnRef } from './remember.js';
import { createOortWith } from './sdk/create.js';
import { OortUsageError } from './sdk/errors.js';
import { wire as realWire, type WireFn } from './wire.js';
import { writeCloudSettings } from './cloud.js';
import { data, fakeIo, tmpdir } from '../test/helpers.js';
import {
  NEAR_LIMIT_MESSAGE,
  fakeCloud,
  fakeMemory,
  type FakeCloud,
} from '../test/helpers/fake-cloud.js';
import CONTRACT from '../test/cloud-contract.json' with { type: 'json' };

/**
 * Places in Oort Cloud: the CLI, the SDK and the MCP server send a place on observe and remember,
 * and within and near on recall, as local mode takes them. Oort Cloud checks them with core's
 * rules (`400 bad_place`), and a near over its limit is refused with its own message.
 */

function setup() {
  const root = tmpdir('oort-cloud-places-');
  const home = path.join(root, 'oort-home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const key = ['oort', 'sk', 'places'.padEnd(43, 'P')].join('_');
  const cloud: FakeCloud = fakeCloud(key);
  writeCloudSettings(home, { store: 'cloud' });
  const env = { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: key };
  const wire: WireFn = (dir, o = {}) =>
    realWire(dir, { ...o, keychain: async () => undefined, fetch: cloud.fetch });
  const run = async (args: string[]) => {
    const io = fakeIo({ cwd, env });
    const code = await runCli(args, io, wire, createKeychain({ platform: 'none' }), {
      fetch: cloud.fetch,
    });
    return { code, io };
  };
  const sdk = () =>
    createOortWith(
      { mode: 'cloud', cwd, env, fetch: cloud.fetch, keySources: ['env'], project: null },
      {},
    );
  return { root, home, cwd, key, cloud, env, run, sdk };
}

/** The place the `i`th observe sent, if any. */
const placeSent = (c: FakeCloud, i: number): unknown =>
  (c.observed[i]?.['observation'] as Record<string, unknown> | undefined)?.['place'];

const B3 = { nodeId: 'site:hq/room:B/shelf:B3', mapId: 'hq', pose: { x: 10, y: 0 } };

/** Placed memories, `n` of them, all at the origin of map hq, under site:hq/bulk. */
function seedPlaced(c: FakeCloud, n: number): void {
  for (let i = 0; i < n; i++) {
    const m = fakeMemory({
      text: `bulk crate number ${i}`,
      place: { nodeId: `site:hq/bulk/crate:${i}`, mapId: 'hq', pose: { x: 0, y: 0 } },
    });
    c.memories.set(m.id, m);
  }
}

describe('oort remember and recall with places in Oort Cloud', () => {
  it('cloud-places.cli-remembers-a-place-and-recalls-within-and-near-it', async () => {
    const e = setup();
    const saved = await e.run([
      'remember',
      'The torque wrench is in drawer 4.',
      '--place',
      'site:hq/room:B/drawer:4',
      '--pose',
      '3,4',
      '--map',
      'hq',
      '--json',
    ]);
    expect(saved.code, saved.io.stderr).toBe(0);
    const observation = e.cloud.observed[0]?.['observation'] as Record<string, unknown>;
    expect(observation['place']).toEqual({
      nodeId: 'site:hq/room:B/drawer:4',
      mapId: 'hq',
      pose: { x: 3, y: 4 },
    });
    const within = await e.run(['recall', 'torque wrench', '--within', 'room:B', '--json']);
    expect(within.code, within.io.stderr).toBe(0);
    expect(e.cloud.recalls.at(-1)).toMatchObject({ within: 'room:B' });
    const w = data<{ memories: { place: unknown; explanation: Record<string, unknown> }[] }>(
      within.io.stdout,
    );
    expect(w.memories).toHaveLength(1);
    expect(w.memories[0]?.explanation['placePath']).toBe('site:hq/room:B/drawer:4');
    const near = await e.run([
      'recall',
      'torque wrench',
      '--near',
      '3,5',
      '--radius',
      '2',
      '--map',
      'hq',
      '--json',
    ]);
    expect(near.code, near.io.stderr).toBe(0);
    expect(e.cloud.recalls.at(-1)?.['near']).toEqual({
      mapId: 'hq',
      pose: { x: 3, y: 5 },
      radius: 2,
    });
    const n = data<{ memories: { explanation: { distanceM: number } }[] }>(near.io.stdout);
    expect(n.memories[0]?.explanation.distanceM).toBe(1);
    const elsewhere = await e.run(['recall', 'torque wrench', '--within', 'room:C', '--json']);
    expect(data<{ memories: unknown[] }>(elsewhere.io.stdout).memories).toEqual([]);
  });

  it('cloud-places.cli-bad-flags-are-refused-before-anything-is-sent', async () => {
    const e = setup();
    const r = await e.run(['recall', 'toolbox', '--within', 'room B']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toMatch(/--within must be/);
    const p = await e.run(['remember', 'The toolbox is here.', '--place', 'a//b']);
    expect(p.code).toBe(2);
    expect(e.cloud.seen.filter((s) => s.startsWith('POST'))).toEqual([]);
  });

  it('cloud-places.cli-near-over-the-limit-shows-the-message-oort-cloud-gives', async () => {
    const e = setup();
    seedPlaced(e.cloud, CONTRACT.places.limits.nearCandidates + 1);
    const r = await e.run(['recall', 'crate', '--near', '0,0', '--radius', '1', '--map', 'hq']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain(NEAR_LIMIT_MESSAGE);
    // The limit counts the placed memories after within: a narrower within is answered.
    const ok = await e.run([
      'recall',
      'crate',
      '--near',
      '0,0',
      '--radius',
      '1',
      '--map',
      'hq',
      '--within',
      'crate:7',
      '--json',
    ]);
    expect(ok.code, ok.io.stderr).toBe(0);
    expect(data<{ memories: unknown[] }>(ok.io.stdout).memories).toHaveLength(1);
  });

  it('cloud-places.the-same-fact-at-another-place-the-same-day-is-not-a-duplicate', async () => {
    const e = setup();
    const at = (place: string) =>
      e.run(['remember', 'The forklift charger is here.', '--place', place, '--json']);
    expect((await at('site:hq/dock:1')).code).toBe(0);
    expect((await at('site:hq/dock:2')).code).toBe(0);
    expect((await at('site:hq/dock:1')).code).toBe(0);
    const refs = e.cloud.observed.map((b) => b['turnRef']);
    expect(refs[0]).not.toBe(refs[1]);
    expect(refs[2]).toBe(refs[0]);
    // Two memories: the repeat at dock 1 is the same turn, answered as a duplicate.
    expect(e.cloud.memories.size).toBe(2);
  });
});

describe('rememberTurnRef and places', () => {
  const at = '2026-11-17T09:00:00.000Z';
  const ref = (place?: Parameters<typeof rememberTurnRef>[4]) =>
    rememberTurnRef('The wrench is here.', undefined, 'p1', at, place);

  it('cloud-places.turn-ref-without-a-place-is-unchanged', () => {
    const h = createHash('sha256').update('p1\n\nThe wrench is here.').digest('hex');
    expect(ref()).toBe(`remember:${h}:2026-11-17`);
  });

  it('cloud-places.turn-ref-follows-what-core-compares-in-a-place', () => {
    const base = { nodeId: 'site:hq/room:B', mapId: 'hq', pose: { x: 1, y: 2 } };
    expect(ref(base)).not.toBe(ref());
    // Another path, map, frame or pose is another place.
    expect(ref({ ...base, nodeId: 'site:hq/room:C' })).not.toBe(ref(base));
    expect(ref({ ...base, mapId: 'lab' })).not.toBe(ref(base));
    expect(ref({ ...base, frame: 'utm' })).not.toBe(ref(base));
    expect(ref({ ...base, pose: { x: 1, y: 3 } })).not.toBe(ref(base));
    expect(ref({ ...base, pose: { x: 1, y: 2, z: 1 } })).not.toBe(ref(base));
    expect(ref({ nodeId: 'site:hq/room:B' })).not.toBe(ref(base));
    // What core only records is not: the default frame named, the map's version, yaw, extent, sigma.
    expect(ref({ ...base, frame: 'map' })).toBe(ref(base));
    expect(ref({ ...base, mapVersion: 3 })).toBe(ref(base));
    expect(ref({ ...base, pose: { x: 1, y: 2, yaw: 0.5 } })).toBe(ref(base));
    expect(ref({ ...base, extent: { radius: 2 } })).toBe(ref(base));
    expect(ref({ ...base, sigma: 0.1 })).toBe(ref(base));
    expect(ref({ ...base, geo: { lat: 59, lon: 18 } })).toBe(ref(base));
    // A place with only geo is told apart by it.
    expect(ref({ geo: { lat: 59, lon: 18 } })).not.toBe(ref({ geo: { lat: 59, lon: 19 } }));
    expect(ref({ geo: { lat: 59, lon: 18 } })).not.toBe(ref());
  });
});

describe('the SDK with places in Oort Cloud', () => {
  it('cloud-places.sdk-sends-the-place-and-the-filter-and-reads-them-back', async () => {
    const e = setup();
    const oort = await e.sdk();
    const r = await oort.remember('The blue toolbox is on shelf B3.', { place: B3 });
    expect(r.results[0]?.outcome).toBe('added');
    expect(placeSent(e.cloud, 0)).toEqual(B3);
    await oort.observe({
      user: 'The forklift charger is by the loading dock.',
      assistant: 'Noted.',
      place: { nodeId: 'site:hq/dock:1' },
    });
    expect(placeSent(e.cloud, 1)).toEqual({
      nodeId: 'site:hq/dock:1',
    });
    const within = await oort.recall('toolbox', { within: 'room:B' });
    expect(within.memories).toHaveLength(1);
    expect(within.memories[0]).toMatchObject({
      place: B3,
      why: { placePath: 'site:hq/room:B/shelf:B3' },
    });
    const near = await oort.recall('toolbox', {
      near: { mapId: 'hq', pose: { x: 12, y: 0 }, radius: 3 },
    });
    expect(near.memories[0]?.why.distanceM).toBe(2);
    expect(e.cloud.recalls.at(-1)).toMatchObject({
      near: { mapId: 'hq', pose: { x: 12, y: 0 }, radius: 3 },
    });
    const recent = await oort.recent();
    expect(recent.memories.find((m) => m.id === r.results[0]?.id)?.place).toEqual(B3);
    await oort.close();
  });

  it('cloud-places.sdk-checks-a-place-before-anything-is-sent-as-local-mode-does', async () => {
    const e = setup();
    const oort = await e.sdk();
    await expect(oort.recall('q', { within: 'room B' })).rejects.toMatchObject({
      code: 'usage',
      reason: 'invalid-argument',
      message: 'recall options: invalid field within.',
    });
    await expect(oort.remember('x', { place: { nodeId: 'a//b' } })).rejects.toBeInstanceOf(
      OortUsageError,
    );
    expect(e.cloud.seen.filter((s) => s.startsWith('POST'))).toEqual([]);
    await oort.close();
  });

  it('cloud-places.sdk-bad-place-from-oort-cloud-is-a-usage-error-with-its-message', async () => {
    const e = setup();
    e.cloud.fail = { 'POST /v1/observe': { status: 400, code: 'bad_place' } };
    const oort = await e.sdk();
    const err = await oort.remember('x', { place: B3 }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(OortUsageError);
    expect(err).toMatchObject({ reason: 'invalid-argument', status: 400, message: 'forced 400' });
    await oort.close();
  });

  it('cloud-places.sdk-near-over-the-limit-surfaces-the-message-unchanged', async () => {
    const e = setup();
    seedPlaced(e.cloud, CONTRACT.places.limits.nearCandidates + 1);
    const oort = await e.sdk();
    const err = await oort
      .recall('crate', { near: { mapId: 'hq', pose: { x: 0, y: 0 }, radius: 1 } })
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(OortUsageError);
    expect(err).toMatchObject({ reason: 'invalid-argument', message: NEAR_LIMIT_MESSAGE });
    // Exactly at the limit is answered.
    e.cloud.memories.delete([...e.cloud.memories.keys()][0]!);
    const ok = await oort.recall('crate', {
      near: { mapId: 'hq', pose: { x: 0, y: 0 }, radius: 1 },
      limit: 3,
    });
    expect(ok.memories).toHaveLength(3);
    await oort.close();
  });

  it('cloud-places.a-place-oort-cloud-sends-that-core-refuses-is-left-out', async () => {
    const e = setup();
    const bad = fakeMemory({ text: 'The odd toolbox.', place: { nodeId: 'a//b' } });
    const good = fakeMemory({ text: 'The good toolbox.', place: B3 });
    e.cloud.memories.set(bad.id, bad);
    e.cloud.memories.set(good.id, good);
    const oort = await e.sdk();
    const r = await oort.recall('toolbox');
    expect(r.memories.find((m) => m.id === bad.id)).not.toHaveProperty('place');
    expect(r.memories.find((m) => m.id === good.id)?.place).toEqual(B3);
    const recent = await oort.recent();
    expect(recent.memories.find((m) => m.id === bad.id)).not.toHaveProperty('place');
    const one = await oort.explain(bad.id);
    expect(one.memory).not.toHaveProperty('place');
    await oort.close();
  });
});

describe('the MCP server with places in Oort Cloud', () => {
  it('cloud-places.mcp-remembers-a-place-and-recalls-within-and-near-it', async () => {
    const e = setup();
    const w = await realWire(e.cwd, {
      env: e.env,
      keychain: async () => undefined,
      fetch: e.cloud.fetch,
    });
    const backend = cloudBackend({ wired: w, client: w.cloud! });
    expect(backend.spatial).toBe(true);
    const saved = await backend.remember({
      facts: ['The torque wrench is in drawer 4.'],
      visibility: 'private',
      place: { node_id: 'site:hq/room:B/drawer:4', map_id: 'hq', pose: { x: 3, y: 4 } },
    });
    expect(saved.results[0]?.outcome).toBe('added');
    expect(placeSent(e.cloud, 0)).toEqual({
      nodeId: 'site:hq/room:B/drawer:4',
      mapId: 'hq',
      pose: { x: 3, y: 4 },
    });
    const within = await backend.recall({ query: 'torque wrench', within: 'room:B', limit: 5 });
    expect(within.memories[0]).toMatchObject({ place: 'site:hq/room:B/drawer:4' });
    const near = await backend.recall({
      query: 'torque wrench',
      near: { map_id: 'hq', pose: { x: 3, y: 5 }, radius: 2 },
      limit: 5,
    });
    expect(near.memories[0]).toMatchObject({ distance_m: 1 });
    await expect(
      backend.recall({ query: 'torque wrench', within: 'room B', limit: 5 }),
    ).rejects.toThrow(/within/);
    await w.close();
  });
});
