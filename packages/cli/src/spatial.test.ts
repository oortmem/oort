import { describe, expect, it } from 'vitest';
import { TG } from '@oortmem/core/store-conformance';
import { data, harness, memory } from '../test/helpers.js';
import { placeOfFlags, spatialFilter } from './engine/recall.js';

/** Spatial memory in the CLI (CON-84): `--within`, `--near`, `--place` and `--pose`. */

describe('spatial flags', () => {
  it('spatial.flags-build-a-checked-filter-and-place', () => {
    expect(spatialFilter({})).toBeUndefined();
    expect(spatialFilter({ within: 'room:B' })).toEqual({ within: 'room:B' });
    expect(spatialFilter({ near: '1,2.5,0.5', radius: '3', map: 'hq', frame: 'utm' })).toEqual({
      near: { mapId: 'hq', frame: 'utm', pose: { x: 1, y: 2.5, z: 0.5 }, radius: 3 },
    });
    expect(placeOfFlags({})).toBeUndefined();
    expect(
      placeOfFlags({ place: 'site:hq/room:B', pose: '1,2', map: 'hq', radius: '0.5' }),
    ).toEqual({
      nodeId: 'site:hq/room:B',
      mapId: 'hq',
      pose: { x: 1, y: 2 },
      extent: { radius: 0.5 },
    });
  });

  it('spatial.bad-flags-are-refused-by-flag-never-echoing-the-value', () => {
    const refused: [() => unknown, RegExp][] = [
      [() => spatialFilter({ within: 'room B' }), /^--within must be/],
      [() => spatialFilter({ near: '1,2', map: 'hq' }), /--near needs --radius/],
      [() => spatialFilter({ radius: '2' }), /go with --near/],
      [() => spatialFilter({ near: '1;2', radius: '2', map: 'hq' }), /--near takes x,y/],
      [() => spatialFilter({ near: '1,2', radius: '-2', map: 'hq' }), /^--radius must be/],
      [() => spatialFilter({ near: '1,2', radius: '2', map: 'hq', frame: 'odom' }), /^--frame/],
      [() => placeOfFlags({ pose: '1,2' }), /^--map is required/],
      [() => placeOfFlags({ map: 'hq' }), /go with --pose/],
      [() => placeOfFlags({ place: 'a//b' }), /^--place must be/],
    ];
    for (const [f, re] of refused) {
      expect(f).toThrow(re);
      try {
        f();
      } catch (e) {
        expect((e as Error).message).not.toMatch(/room B|a\/\/b|1;2/);
      }
    }
  });
});

describe('oort recall, explain and remember with places', () => {
  it('spatial.recall-within-and-near-and-explain-shows-the-place', async () => {
    const h = harness();
    const at = (id: string, nodeId: string, x: number) =>
      memory({
        id,
        text: `The ${id} toolbox is here.`,
        stub: `${id} toolbox`,
        place: { nodeId, mapId: 'hq', pose: { x, y: 0 } },
      });
    await h.store.upsert(TG, at('11111111-1111-4111-8111-111111111111', 'site:hq/room:A', 0));
    await h.store.upsert(TG, at('22222222-2222-4222-8222-222222222222', 'site:hq/room:B', 10));
    await h.store.upsert(TG, at('33333333-3333-4333-8333-333333333333', 'site:hq/room:B2', 20));
    const within = await h.run(['recall', 'toolbox', '--within', 'room:B', '--json']);
    expect(within.code).toBe(0);
    const w = data<{ memories: { id: string; place: unknown }[]; spatial: unknown }>(
      within.io.stdout,
    );
    expect(w.memories.map((m) => m.id)).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(w.spatial).toEqual({ within: 'room:B' });
    const near = await h.run([
      'recall',
      'toolbox',
      '--near',
      '19,0',
      '--radius',
      '2',
      '--map',
      'hq',
      '--json',
    ]);
    const n = data<{ memories: { id: string; explanation: { distanceM: number } }[] }>(
      near.io.stdout,
    );
    expect(n.memories.map((m) => [m.id, m.explanation.distanceM])).toEqual([
      ['33333333-3333-4333-8333-333333333333', 1],
    ]);
    const table = await h.run(['explain', 'toolbox', '--within', 'site:hq']);
    expect(table.code).toBe(0);
    expect(table.io.stdout).toContain('place: within site:hq');
    expect(table.io.stdout).toContain('site:hq/room:B2');
    const bad = await h.run(['recall', 'toolbox', '--near', '1,2']);
    expect(bad.code).toBe(2);
    expect(bad.io.stderr).toContain('--near needs --radius');
  });

  it('spatial.remember-tags-the-fact-with-its-place', async () => {
    const h = harness();
    const r = await h.run([
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
    expect(r.code).toBe(0);
    const id = data<{ results: { id: string }[] }>(r.io.stdout).results[0]!.id;
    expect((await h.store.get(TG, id))?.place).toEqual({
      nodeId: 'site:hq/room:B/drawer:4',
      mapId: 'hq',
      pose: { x: 3, y: 4 },
    });
  });
});
