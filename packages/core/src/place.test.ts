import { describe, expect, it } from 'vitest';
import {
  checkNear,
  checkPlace,
  checkPlacePath,
  checkSpatialFilter,
  matchesSpatial,
  placeBox,
  placeDistance,
  withinPath,
  type NearQuery,
  type Place,
} from './place.js';
import { makeMemory } from './store-conformance.js';

const near = (x: number, y: number, radius: number, extra: Partial<NearQuery> = {}): NearQuery => ({
  mapId: 'hq',
  pose: { x, y },
  radius,
  ...extra,
});

describe('place', () => {
  it('place.check-accepts-a-path-a-pose-or-geo', () => {
    expect(checkPlace({ nodeId: 'site:hq/floor:2/room:B' })).toEqual({
      nodeId: 'site:hq/floor:2/room:B',
    });
    expect(checkPlace({ mapId: 'hq', pose: { x: 1, y: 2, z: 0.5, yaw: 1.2 } })).toEqual({
      mapId: 'hq',
      pose: { x: 1, y: 2, z: 0.5, yaw: 1.2 },
    });
    expect(checkPlace({ geo: { lat: 59.3, lon: 18.07 } })).toEqual({
      geo: { lat: 59.3, lon: 18.07 },
    });
    const full: Place = {
      nodeId: 'room:B/shelf:B3',
      mapId: 'hq-map',
      mapVersion: 3,
      frame: 'map',
      pose: { x: -4.25, y: 10, z: 1 },
      extent: { dx: 1, dy: 0.5, dz: 2 },
      geo: { lat: -33.9, lon: 151.2, alt: 20 },
      sigma: 0.05,
    };
    expect(checkPlace(full)).toEqual(full);
  });

  it('place.check-refuses-what-a-store-cannot-index', () => {
    const bad: [unknown, string][] = [
      [{}, 'place'],
      [null, 'place'],
      ['room:B', 'place'],
      [{ nodeId: '' }, 'place.nodeId'],
      [{ nodeId: 'room B' }, 'place.nodeId'],
      [{ nodeId: '/room:B' }, 'place.nodeId'],
      [{ nodeId: 'room:B/' }, 'place.nodeId'],
      [{ nodeId: 'a//b' }, 'place.nodeId'],
      [{ nodeId: 'x'.repeat(65) }, 'place.nodeId'],
      [{ nodeId: Array.from({ length: 17 }, () => 'a').join('/') }, 'place.nodeId'],
      [{ pose: { x: 1, y: 2 } }, 'place.mapId'],
      [{ mapId: 'hq', pose: { x: Number.NaN, y: 2 } }, 'place.pose.x'],
      [{ mapId: 'hq', pose: { x: 1, y: Infinity } }, 'place.pose.y'],
      [{ mapId: 'hq', pose: { x: 2e7, y: 0 } }, 'place.pose.x'],
      [{ mapId: 'hq', pose: { x: 1 } }, 'place.pose.y'],
      [{ mapId: 'hq', frame: 'odom', pose: { x: 1, y: 2 } }, 'place.frame'],
      [{ mapId: 'hq', frame: 'ODOM', pose: { x: 1, y: 2 } }, 'place.frame'],
      [{ mapId: 'h q', pose: { x: 1, y: 2 } }, 'place.mapId'],
      [{ mapId: 'hq', mapVersion: 1.5, pose: { x: 1, y: 2 } }, 'place.mapVersion'],
      [{ mapId: 'hq', mapVersion: -1, pose: { x: 1, y: 2 } }, 'place.mapVersion'],
      [{ nodeId: 'a', extent: { radius: 1 } }, 'place.extent'],
      [{ mapId: 'hq', pose: { x: 1, y: 2 }, extent: { radius: 0 } }, 'place.extent.radius'],
      [{ mapId: 'hq', pose: { x: 1, y: 2 }, extent: { dx: 1, dy: 1, dz: 1 } }, 'place.extent.dz'],
      [{ mapId: 'hq', pose: { x: 1, y: 2 }, extent: { dx: 1 } }, 'place.extent.dy'],
      [{ mapId: 'hq', pose: { x: 1, y: 2 }, extent: { dx: 1, dy: 1, radius: 1 } }, 'place.extent'],
      [{ geo: { lat: 91, lon: 0 } }, 'place.geo.lat'],
      [{ geo: { lat: 0, lon: -181 } }, 'place.geo.lon'],
      [{ nodeId: 'a', sigma: -1 }, 'place.sigma'],
      [{ nodeId: 'a', nodeID: 'b' }, 'place.nodeID'],
      [{ mapId: 'hq', pose: { x: 1, y: 2, w: 3 } }, 'place.pose.w'],
    ];
    for (const [p, field] of bad) {
      expect(() => checkPlace(p), JSON.stringify(p)).toThrow(RangeError);
      expect(() => checkPlace(p), JSON.stringify(p)).toThrow(field);
    }
  });

  it('place.check-never-echoes-a-value', () => {
    try {
      checkPlace({ nodeId: 'secret value here' });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain('secret');
    }
  });

  it('place.within-matches-whole-segments-and-everything-below', () => {
    const path = 'site:hq/floor:2/room:B/shelf:B3';
    expect(withinPath(path, 'room:B')).toBe(true);
    expect(withinPath(path, 'floor:2/room:B')).toBe(true);
    expect(withinPath(path, 'site:hq')).toBe(true);
    expect(withinPath(path, path)).toBe(true);
    expect(withinPath(path, 'shelf:B3')).toBe(true);
    expect(withinPath(path, 'room:B2')).toBe(false);
    expect(withinPath(path, 'room')).toBe(false);
    expect(withinPath(path, 'floor:2/shelf:B3')).toBe(false);
    expect(withinPath(path, 'room:b')).toBe(false);
    expect(withinPath('site:hq/room:B2', 'room:B')).toBe(false);
    expect(withinPath(undefined, 'room:B')).toBe(false);
  });

  it('place.near-is-the-distance-to-the-region', () => {
    const point: Place = { mapId: 'hq', pose: { x: 3, y: 4 } };
    expect(placeDistance(point, near(0, 0, 10))).toBeCloseTo(5);
    const box: Place = { mapId: 'hq', pose: { x: 0, y: 0 }, extent: { dx: 4, dy: 2 } };
    expect(placeDistance(box, near(1, 0.5, 1))).toBe(0);
    expect(placeDistance(box, near(5, 0, 1))).toBeCloseTo(3);
    const sphere: Place = { mapId: 'hq', pose: { x: 0, y: 0, z: 0 }, extent: { radius: 2 } };
    expect(placeDistance(sphere, near(5, 0, 1))).toBeCloseTo(3);
    expect(placeDistance(sphere, near(0, 0, 1, { pose: { x: 0, y: 0, z: 3 } }))).toBeCloseTo(1);
  });

  it('place.z-counts-only-when-both-sides-have-it', () => {
    const flat: Place = { mapId: 'hq', pose: { x: 0, y: 0 } };
    const high: Place = { mapId: 'hq', pose: { x: 0, y: 0, z: 10 } };
    expect(placeDistance(flat, near(0, 0, 1, { pose: { x: 0, y: 0, z: 10 } }))).toBe(0);
    expect(placeDistance(high, near(0, 0, 1))).toBe(0);
    expect(placeDistance(high, near(0, 0, 1, { pose: { x: 0, y: 0, z: 4 } }))).toBeCloseTo(6);
    // A box without dz is a floor-plan region: all of z.
    const room: Place = { mapId: 'hq', pose: { x: 0, y: 0, z: 0 }, extent: { dx: 2, dy: 2 } };
    expect(placeDistance(room, near(0, 0, 1, { pose: { x: 0, y: 0, z: 50 } }))).toBe(0);
  });

  it('place.coordinates-from-another-map-or-frame-are-never-compared', () => {
    const p: Place = { mapId: 'hq', pose: { x: 0, y: 0 } };
    expect(placeDistance(p, near(0, 0, 100, { mapId: 'lab' }))).toBeUndefined();
    expect(placeDistance(p, near(0, 0, 100, { frame: 'utm' }))).toBeUndefined();
    expect(placeDistance({ ...p, frame: 'map' }, near(0, 0, 1, { frame: 'map' }))).toBe(0);
    expect(placeDistance({ nodeId: 'room:B' }, near(0, 0, 100))).toBeUndefined();
    expect(placeDistance(undefined, near(0, 0, 100))).toBeUndefined();
  });

  it('place.matches-spatial-needs-both-filters', () => {
    const m = makeMemory({
      id: 'm',
      place: { nodeId: 'site:hq/room:B', mapId: 'hq', pose: { x: 1, y: 1 } },
    });
    const bare = makeMemory({ id: 'bare' });
    expect(matchesSpatial(m, { within: 'room:B' })).toBe(true);
    expect(matchesSpatial(m, { near: near(0, 0, 2) })).toBe(true);
    expect(matchesSpatial(m, { within: 'room:B', near: near(0, 0, 1) })).toBe(false);
    expect(matchesSpatial(m, { within: 'room:A', near: near(0, 0, 2) })).toBe(false);
    expect(matchesSpatial(m, {})).toBe(true);
    expect(matchesSpatial(bare, {})).toBe(true);
    expect(matchesSpatial(bare, { within: 'room:B' })).toBe(false);
  });

  it('place.box-spans-the-region-and-all-of-z-when-z-is-unknown', () => {
    expect(placeBox({ nodeId: 'a' })).toBeUndefined();
    const b = placeBox({ mapId: 'hq', pose: { x: 1, y: 2 }, extent: { radius: 0.5 } })!;
    expect(b).toMatchObject({ minX: 0.5, maxX: 1.5, minY: 1.5, maxY: 2.5, mapKey: '["hq","map"]' });
    expect(b.minZ).toBeLessThan(-1e20);
    expect(b.maxZ).toBeGreaterThan(1e20);
    const z = placeBox({
      mapId: 'hq',
      frame: 'f',
      pose: { x: 0, y: 0, z: 1 },
      extent: { dx: 2, dy: 4, dz: 2 },
    })!;
    expect(z).toMatchObject({
      minX: -1,
      maxX: 1,
      minY: -2,
      maxY: 2,
      minZ: 0,
      maxZ: 2,
      mapKey: '["hq","f"]',
    });
  });

  it('place.near-and-within-are-checked', () => {
    expect(checkPlacePath('room:B', 'within')).toBe('room:B');
    expect(() => checkPlacePath('room B', 'within')).toThrow('within');
    expect(checkNear({ mapId: 'hq', pose: { x: 1, y: 2 }, radius: 3 })).toEqual({
      mapId: 'hq',
      pose: { x: 1, y: 2 },
      radius: 3,
    });
    expect(() => checkNear({ mapId: 'hq', pose: { x: 1, y: 2 } })).toThrow('near.radius');
    expect(() => checkNear({ mapId: 'hq', pose: { x: 1, y: 2 }, radius: -1 })).toThrow(
      'near.radius',
    );
    expect(() => checkNear({ pose: { x: 1, y: 2 }, radius: 1 })).toThrow('near.mapId');
    expect(() =>
      checkNear({ mapId: 'hq', frame: 'odom', pose: { x: 1, y: 2 }, radius: 1 }),
    ).toThrow('near.frame');
    expect(() => checkNear({ mapId: 'hq', pose: { x: 1, y: 2 }, radius: 1, k: 3 })).toThrow(
      'near.k',
    );
    expect(checkSpatialFilter({})).toEqual({});
    expect(checkSpatialFilter({ within: 'a/b' })).toEqual({ within: 'a/b' });
  });

  it('place.paths-in-any-script-are-normalised-to-nfc', () => {
    // Devanagari and Thai names need their combining vowel signs (\p{M}).
    expect(checkPlacePath('site:hq/कमरा')).toBe('site:hq/कमरा');
    expect(checkPlacePath('ห้อง:B')).toBe('ห้อง:B');
    // A decomposed é (e + U+0301) is stored and filtered as the composed one.
    const nfd = 'room:cafe\u0301';
    const nfc = 'room:caf\u00e9';
    expect(checkPlacePath(nfd)).toBe(nfc);
    expect(checkPlace({ nodeId: `site:hq/${nfd}` }).nodeId).toBe(`site:hq/${nfc}`);
    expect(checkSpatialFilter({ within: nfd })).toEqual({ within: nfc });
    expect(withinPath(checkPlace({ nodeId: `site:hq/${nfc}` }).nodeId, checkPlacePath(nfd))).toBe(
      true,
    );
    // A mark alone, or one leading a segment, is still not a name.
    expect(() => checkPlacePath('\u0301')).toThrow(RangeError);
    expect(() => checkPlacePath('a/\u0301b')).toThrow(RangeError);
  });

  it('place.paths-refuse-invisible-default-ignorable-code-points', () => {
    // `room:B` plus a variation selector looks exactly like `room:B` but never matches it, so
    // `within` would quietly find less. Every Default_Ignorable_Code_Point is refused, by its own
    // check (`invisible`), before the segment pattern would refuse the format characters among them.
    for (const c of [
      '\ufe0f', // VARIATION SELECTOR-16
      '\ufe00', // VARIATION SELECTOR-1
      '\u034f', // COMBINING GRAPHEME JOINER
      '\u{e0100}', // VARIATION SELECTOR-17 (ideographic variation sequences)
      '\u180b', // MONGOLIAN FREE VARIATION SELECTOR ONE
      '\u17b4', // KHMER VOWEL INHERENT AQ
      '\u3164', // HANGUL FILLER (a letter, and invisible)
      '\u200d', // ZERO WIDTH JOINER, here at the end of a segment
      '\u200c', // ZERO WIDTH NON-JOINER, likewise
      '\u00ad', // SOFT HYPHEN
      '\u2060', // WORD JOINER
    ]) {
      const hex = `U+${c.codePointAt(0)!.toString(16)}`;
      expect(() => checkPlacePath(`room:B${c}`), hex).toThrow(/^place\.nodeId .*invisible/);
      expect(() => checkPlace({ nodeId: `site:hq/room:B${c}/shelf:1` }), hex).toThrow(
        /^place\.nodeId .*invisible/,
      );
      expect(() => checkSpatialFilter({ within: `room:B${c}` }), hex).toThrow(
        /^within .*invisible/,
      );
    }
    // Visible marks that only look like the refused ones still work.
    expect(checkPlacePath('ห้อง:B/कमरा')).toBe('ห้อง:B/कमरा');
  });

  it('place.paths-keep-joiners-only-where-idna-contextj-allows-them', () => {
    // RFC 5892 Appendix A.1 and A.2: ZWJ only right after a virama; ZWNJ after a virama or
    // between letters of a joining script (Persian). Anything else would be an invisible
    // look-alike of a path without it.
    for (const p of [
      'خانه\u200cی:B', // Persian: خانه + ZWNJ + ی
      '\u0628\u064e\u200c\u06cc:1', // Arabic letter + fatha + ZWNJ + letter: marks may sit between
      '\u0915\u094d\u200d\u0937:1', // Devanagari: क् + ZWJ + ष
      '\u0915\u094d\u200c\u0937:1', // Devanagari: क् + ZWNJ + ष (no conjunct)
      '\u0d28\u0d4d\u200d:1', // Malayalam chillu: ന് + ZWJ, before a symbol
      'room:\u0d05\u0d35\u0d28\u0d4d\u200d', // room:അവന് + ZWJ, ending the path
      '\u0d28\u0d4d\u200d/x', // ന് + ZWJ, ending a segment
      'site:hq/\u0dc1\u0dca\u200d\u0dbb\u0dd3', // Sinhala: ශ් + ZWJ + රී
    ]) {
      expect(checkPlacePath(p), JSON.stringify(p)).toBe(p.normalize('NFC'));
      expect(checkSpatialFilter({ within: p })).toEqual({ within: p.normalize('NFC') });
    }
    for (const p of [
      // Look-alikes in scripts that never need a joiner there.
      'room:B\u200dX',
      'site:h\u200cq',
      '\u6771\u200d\u4eac', // 東 + ZWJ + 京
      '\u0412\u200dB', // Cyrillic В + ZWJ + B
      'x\u0301\u200d1', // a mark, not a virama, before the ZWJ
      'B\u20dd\u200d:1',
      'a\u200d\u0301',
      // Leading, trailing (but after a virama), doubled, and next to a digit or symbol.
      '\u200cخانه:B',
      '\u200dक्ष:1',
      'خانه\u200c',
      'خانه\u200c/x',
      'خانه\u200c\u200cی:B',
      '\u0915\u094d\u200d\u200d\u0937:1',
      'room:B\u200c\u200d1',
      'room\u200d:B',
      '1\u200c2',
      'خانه\u200c1', // ZWNJ after a joining letter but before a digit
    ]) {
      expect(() => checkPlacePath(p), JSON.stringify(p)).toThrow(/^place\.nodeId .*invisible/);
    }
  });
});
