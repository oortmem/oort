import type { Memory } from './model.js';

/**
 * Spatial memory, slice 1 (CON-84; docs/design/2026-11-11-spatial-memory.md). A memory may carry
 * a `place`: a path in a place tree, and optionally coordinates in a named map and frame. Recall
 * may keep to memories `within` a place or `near` a point. Oort is a layer on a robot's or a
 * device's own map, never a map: coordinates from different maps or frames are never compared.
 */
export interface Place {
  /** A place path, root first: `site:hq/floor:2/room:B/shelf:B3`. */
  nodeId?: string;
  /** The map the coordinates are in. Required with `pose`. */
  mapId?: string;
  /** Bumped by the robot stack when the map is re-optimised. Recorded, not filtered on. */
  mapVersion?: number;
  /** The coordinate frame; default `map` (`frameOf`). `odom` is refused: it drifts. */
  frame?: string;
  /** Metres (x forward, y left, z up). Without z, compared in two dimensions. */
  pose?: Pose;
  /** The region around `pose`: a box (full sizes, centred on it) or a sphere. Default: the point. */
  extent?: BoxExtent | RadiusExtent;
  /** WGS84, outdoors. Stored and returned; not searchable in slice 1. */
  geo?: { lat: number; lon: number; alt?: number };
  /** Pose uncertainty in metres (1 sigma), when the source knows it. Not searched on; a re-sighting
   * within the two places' combined sigma is the same place (observe). */
  sigma?: number;
}

export interface Pose {
  x: number;
  y: number;
  z?: number;
  /** Radians. Recorded only. */
  yaw?: number;
}

export interface BoxExtent {
  dx: number;
  dy: number;
  /** Needs `pose.z`. Without it the box spans all of z (a floor-plan region). */
  dz?: number;
}

export interface RadiusExtent {
  radius: number;
}

/** A point query: memories whose region lies within `radius` metres, on the same map and frame. */
export interface NearQuery {
  mapId: string;
  /** Default `map`. */
  frame?: string;
  pose: { x: number; y: number; z?: number };
  radius: number;
}

/**
 * What a spatial recall keeps: memories `within` a place path (whole segments, and everything
 * below), and `near` a point. Both set: both must hold. Neither: everything (no filter).
 */
export interface SpatialFilter {
  within?: string;
  near?: NearQuery;
}

/** Raised by recall for a spatial query against a store that cannot filter by place. */
export class SpatialUnsupportedError extends Error {
  constructor() {
    super(
      'this memory store cannot filter by place: near and within need a store with spatial memory',
    );
    this.name = 'SpatialUnsupportedError';
  }
}

/** The default frame. */
export const DEFAULT_FRAME = 'map';
/** The largest coordinate, extent or radius: 10,000 km, in metres. */
export const MAX_METRES = 1e7;
/** How R*Tree rows and queries span "all of z". */
export const ALL_Z = 1e30;

/**
 * A segment starts with a letter, digit or symbol, then may carry marks (Devanagari, Thai vowel
 * signs) and the joiners ZWNJ and ZWJ (where `CONTEXT_J` allows them).
 */
const SEGMENT = /^[\p{L}\p{N}._:@-][\p{L}\p{M}\p{N}._:@\u200c\u200d-]{0,63}$/u;
/**
 * Invisible characters a segment may not hold: every Unicode Default_Ignorable_Code_Point, such as
 * the variation selectors (U+FE00 to U+FE0F, U+E0100 to U+E01EF), the combining grapheme joiner
 * (U+034F), Mongolian free variation selectors, Khmer's inherent vowels (U+17B4, U+17B5) and the
 * Hangul fillers. `room:B` followed by one looks exactly like `room:B` but never matches it. The
 * one exception is `CONTEXT_J`.
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;
/**
 * Every virama: the code points with Canonical_Combining_Class 9 (Virama) in Unicode 17.0.0
 * (UnicodeData.txt field 3). JavaScript has no property for it.
 */
const VIRAMA =
  '\u094d\u09cd\u0a4d\u0acd\u0b4d\u0bcd\u0c4d\u0ccd\u0d3b-\u0d3c\u0d4d\u0dca\u0e3a' +
  '\u0eba\u0f84\u1039-\u103a\u1714-\u1715\u1734\u17d2\u1a60\u1b44\u1baa-\u1bab' +
  '\u1bf2-\u1bf3\u2d7f\ua806\ua82c\ua8c4\ua953\ua9c0\uaaf6\uabed\u{10a3f}\u{11046}' +
  '\u{11070}\u{1107f}\u{110b9}\u{11133}-\u{11134}\u{111c0}\u{11235}\u{112ea}\u{1134d}' +
  '\u{113ce}-\u{113d0}\u{11442}\u{114c2}\u{115bf}\u{1163f}\u{116b6}\u{1172b}\u{11839}' +
  '\u{1193d}-\u{1193e}\u{119e0}\u{11a34}\u{11a47}\u{11a99}\u{11c3f}\u{11d44}-\u{11d45}' +
  '\u{11d97}\u{11f41}-\u{11f42}\u{1612f}';
/** A letter of a script whose letters join (IDNA's joining-letter case, in practical form). */
const JOINING_LETTER =
  '(?=\\p{L})[\\p{sc=Arabic}\\p{sc=Syriac}\\p{sc=Nko}\\p{sc=Mandaic}\\p{sc=Mongolian}' +
  '\\p{sc=Adlam}\\p{sc=Hanifi_Rohingya}\\p{sc=Manichaean}\\p{sc=Psalter_Pahlavi}]';
/**
 * The joiners IDNA's ContextJ rules allow (RFC 5892, Appendix A.1 and A.2), which `INVISIBLE`
 * then does not see. ZWJ only right after a virama (Devanagari `क्` + ZWJ + `ष`, Sinhala `ශ්` + ZWJ
 * + `රී`, and Malayalam's older chillu `ന്` + ZWJ, which may end a segment). ZWNJ after a virama,
 * or between two letters of a joining script with only nonspacing marks around it (Persian
 * `خانه` + ZWNJ + `ی`). Anywhere else a joiner is an invisible look-alike and is refused.
 */
const CONTEXT_J = new RegExp(
  `(?<=[${VIRAMA}])[\\u200c\\u200d]` +
    `|(?<=${JOINING_LETTER}\\p{Mn}*)\\u200c(?=\\p{Mn}*${JOINING_LETTER})`,
  'gu',
);
const WORD = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const MAX_SEGMENTS = 16;
const MAX_PATH = 256;

/** A field name as an error may show it: never a value. */
const field = (k: string): string => k.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);

function fail(at: string, why: string): never {
  throw new RangeError(`${at} ${why}`);
}

function object(v: unknown, at: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(at, 'must be an object');
  return v as Record<string, unknown>;
}

function only(o: Record<string, unknown>, at: string, keys: readonly string[]): void {
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) fail(`${at}.${field(k)}`, 'is not a known field');
  }
}

function num(v: unknown, at: string, lo: number, hi: number, open = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v > hi || (open ? v <= lo : v < lo)) {
    fail(at, `must be a number ${open ? 'above' : 'from'} ${lo} to ${hi}`);
  }
  return v;
}

function word(v: unknown, at: string): string {
  if (typeof v !== 'string' || !WORD.test(v)) {
    fail(at, 'must be one word of 1 to 128 letters, digits and . _ : @ / -');
  }
  return v;
}

function frame(v: unknown, at: string): string {
  const f = word(v, at);
  if (f.toLowerCase() === 'odom') fail(at, 'cannot be odom: odometry drifts, use the map frame');
  return f;
}

/**
 * A place path, checked and in Unicode NFC (so a decomposed `é` is stored and filtered as the
 * composed one): 1 to 16 segments of 1 to 64 letters (with their combining marks), digits and
 * `. _ : @ -`, with no invisible (default-ignorable) characters but the joiners IDNA's ContextJ rules allow.
 */
export function checkPlacePath(raw: unknown, at = 'place.nodeId'): string {
  const v = typeof raw === 'string' ? raw.normalize('NFC') : raw;
  if (typeof v !== 'string' || v.length > MAX_PATH) {
    fail(at, `must be a place path of at most ${MAX_PATH} characters`);
  }
  const segments = v.split('/');
  // Before the segment pattern, so a soft hyphen or a stray joiner is named for what it is.
  if (segments.some((s) => INVISIBLE.test(s.replace(CONTEXT_J, '')))) {
    fail(
      at,
      'cannot hold invisible characters such as variation selectors, or a joiner outside a word',
    );
  }
  if (segments.length > MAX_SEGMENTS || !segments.every((s) => SEGMENT.test(s))) {
    fail(
      at,
      `must be 1 to ${MAX_SEGMENTS} segments joined by /, each 1 to 64 letters, digits and . _ : @ -`,
    );
  }
  return v;
}

function pose(v: unknown, at: string, withYaw: boolean): Pose {
  const o = object(v, at);
  only(o, at, withYaw ? ['x', 'y', 'z', 'yaw'] : ['x', 'y', 'z']);
  const p: Pose = {
    x: num(o['x'], `${at}.x`, -MAX_METRES, MAX_METRES),
    y: num(o['y'], `${at}.y`, -MAX_METRES, MAX_METRES),
  };
  if (o['z'] !== undefined) p.z = num(o['z'], `${at}.z`, -MAX_METRES, MAX_METRES);
  if (withYaw && o['yaw'] !== undefined) p.yaw = num(o['yaw'], `${at}.yaw`, -1e3, 1e3);
  return p;
}

function extent(v: unknown, at: string, p: Pose): BoxExtent | RadiusExtent {
  const o = object(v, at);
  if ('radius' in o) {
    if (Object.keys(o).length !== 1)
      fail(at, 'is a box (dx, dy, dz) or a sphere (radius), not both');
    return { radius: num(o['radius'], `${at}.radius`, 0, MAX_METRES, true) };
  }
  only(o, at, ['dx', 'dy', 'dz']);
  const b: BoxExtent = {
    dx: num(o['dx'], `${at}.dx`, 0, MAX_METRES, true),
    dy: num(o['dy'], `${at}.dy`, 0, MAX_METRES, true),
  };
  if (o['dz'] !== undefined) {
    if (p.z === undefined) fail(`${at}.dz`, 'needs place.pose.z');
    b.dz = num(o['dz'], `${at}.dz`, 0, MAX_METRES, true);
  }
  return b;
}

const PLACE_KEYS = [
  'nodeId',
  'mapId',
  'mapVersion',
  'frame',
  'pose',
  'extent',
  'geo',
  'sigma',
] as const;

/**
 * `v` as a place, checked, with only the known fields (in a fixed order). Throws a `RangeError`
 * naming the field (`place.pose.x`), never its value.
 */
export function checkPlace(v: unknown, at = 'place'): Place {
  const o = object(v, at);
  only(o, at, PLACE_KEYS);
  const p: Place = {};
  if (o['nodeId'] !== undefined) p.nodeId = checkPlacePath(o['nodeId'], `${at}.nodeId`);
  if (o['mapId'] !== undefined) p.mapId = word(o['mapId'], `${at}.mapId`);
  if (o['mapVersion'] !== undefined) {
    const mv = o['mapVersion'];
    if (typeof mv !== 'number' || !Number.isSafeInteger(mv) || mv < 0) {
      fail(`${at}.mapVersion`, 'must be a whole number from 0');
    }
    p.mapVersion = mv;
  }
  if (o['frame'] !== undefined) p.frame = frame(o['frame'], `${at}.frame`);
  if (o['pose'] !== undefined) {
    if (p.mapId === undefined) fail(`${at}.mapId`, 'is required with a pose');
    p.pose = pose(o['pose'], `${at}.pose`, true);
  }
  if (o['extent'] !== undefined) {
    if (p.pose === undefined) fail(`${at}.extent`, 'needs a pose');
    p.extent = extent(o['extent'], `${at}.extent`, p.pose);
  }
  if (o['geo'] !== undefined) {
    const g = object(o['geo'], `${at}.geo`);
    only(g, `${at}.geo`, ['lat', 'lon', 'alt']);
    p.geo = {
      lat: num(g['lat'], `${at}.geo.lat`, -90, 90),
      lon: num(g['lon'], `${at}.geo.lon`, -180, 180),
      ...(g['alt'] !== undefined && {
        alt: num(g['alt'], `${at}.geo.alt`, -MAX_METRES, MAX_METRES),
      }),
    };
  }
  if (o['sigma'] !== undefined) p.sigma = num(o['sigma'], `${at}.sigma`, 0, MAX_METRES);
  if (p.nodeId === undefined && p.pose === undefined && p.geo === undefined) {
    fail(at, 'needs a nodeId, a pose or geo');
  }
  return p;
}

/** A `near` query, checked (as `checkPlace`). */
export function checkNear(v: unknown, at = 'near'): NearQuery {
  const o = object(v, at);
  only(o, at, ['mapId', 'frame', 'pose', 'radius']);
  const n: NearQuery = {
    mapId:
      o['mapId'] === undefined
        ? fail(`${at}.mapId`, 'is required')
        : word(o['mapId'], `${at}.mapId`),
    pose: { x: 0, y: 0 },
    radius: 0,
  };
  if (o['frame'] !== undefined) n.frame = frame(o['frame'], `${at}.frame`);
  n.pose = pose(o['pose'], `${at}.pose`, false);
  n.radius = num(o['radius'], `${at}.radius`, 0, MAX_METRES, true);
  return n;
}

/** A spatial filter, checked; an empty one is no filter. */
export function checkSpatialFilter(v: unknown): SpatialFilter {
  const o = object(v, 'spatial');
  only(o, 'spatial', ['within', 'near']);
  return {
    ...(o['within'] !== undefined && { within: checkPlacePath(o['within'], 'within') }),
    ...(o['near'] !== undefined && { near: checkNear(o['near']) }),
  };
}

/** True when `f` filters anything. */
export function hasSpatialFilter(f: SpatialFilter | undefined): f is SpatialFilter {
  return f !== undefined && (f.within !== undefined || f.near !== undefined);
}

export const frameOf = (p: { frame?: string }): string => p.frame ?? DEFAULT_FRAME;

/** The key coordinates are comparable under: the map and the frame. */
export const mapKeyOf = (mapId: string, f: string): string => JSON.stringify([mapId, f]);

/**
 * True when the place path `nodeId` contains `path`'s segments as a contiguous run of whole
 * segments: `room:B` is within `site:hq/room:B` and `site:hq/room:B/shelf:B3`, never `room:B2`.
 */
export function withinPath(nodeId: string | undefined, path: string): boolean {
  if (nodeId === undefined) return false;
  return `/${nodeId}/`.includes(`/${path}/`);
}

/** Half-sizes of a place's region per axis; `z` undefined: all of z. */
function halfSizes(p: Place & { pose: Pose }): { x: number; y: number; z: number | undefined } {
  const e = p.extent;
  if (e === undefined) return { x: 0, y: 0, z: p.pose.z === undefined ? undefined : 0 };
  if ('radius' in e) {
    return { x: e.radius, y: e.radius, z: p.pose.z === undefined ? undefined : e.radius };
  }
  return { x: e.dx / 2, y: e.dy / 2, z: e.dz === undefined ? undefined : e.dz / 2 };
}

/**
 * The distance in metres from `q`'s point to the place's region (0 inside it), or undefined when
 * they cannot be compared: no coordinates, or another map or frame. `z` counts only when both have
 * one (and a box without `dz` spans all of z).
 */
export function placeDistance(p: Place | undefined, q: NearQuery): number | undefined {
  if (p?.pose === undefined || p.mapId !== q.mapId || frameOf(p) !== frameOf(q)) return undefined;
  const c = p.pose;
  const h = halfSizes({ ...p, pose: c });
  const useZ = h.z !== undefined && c.z !== undefined && q.pose.z !== undefined;
  const dx = q.pose.x - c.x;
  const dy = q.pose.y - c.y;
  const dz = useZ ? q.pose.z! - c.z! : 0;
  const e = p.extent;
  if (e !== undefined && 'radius' in e) {
    return Math.max(Math.hypot(dx, dy, dz) - e.radius, 0);
  }
  const ax = Math.max(Math.abs(dx) - h.x, 0);
  const ay = Math.max(Math.abs(dy) - h.y, 0);
  const az = useZ ? Math.max(Math.abs(dz) - h.z!, 0) : 0;
  return Math.hypot(ax, ay, az);
}

/** True when `m` passes `f` (every filter it sets). */
export function matchesSpatial(m: Pick<Memory, 'place'>, f: SpatialFilter): boolean {
  if (f.within !== undefined && !withinPath(m.place?.nodeId, f.within)) return false;
  if (f.near !== undefined) {
    const d = placeDistance(m.place, f.near);
    if (d === undefined || d > f.near.radius) return false;
  }
  return true;
}

/** The axis-aligned box a spatial index holds for `p`, or undefined when it has no coordinates. */
export interface PlaceBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  mapKey: string;
}

export function placeBox(p: Place | undefined): PlaceBox | undefined {
  if (p?.pose === undefined || p.mapId === undefined) return undefined;
  const c = p.pose;
  const h = halfSizes({ ...p, pose: c });
  const zAll = h.z === undefined || c.z === undefined;
  return {
    minX: c.x - h.x,
    maxX: c.x + h.x,
    minY: c.y - h.y,
    maxY: c.y + h.y,
    minZ: zAll ? -ALL_Z : c.z! - h.z!,
    maxZ: zAll ? ALL_Z : c.z! + h.z!,
    mapKey: mapKeyOf(p.mapId, frameOf(p)),
  };
}

/** The box a `near` query looks in: its point, `radius` around it (all of z without one). */
export function nearBox(q: NearQuery): PlaceBox {
  const r = q.radius;
  const { x, y, z } = q.pose;
  return {
    minX: x - r,
    maxX: x + r,
    minY: y - r,
    maxY: y + r,
    minZ: z === undefined ? -ALL_Z : z - r,
    maxZ: z === undefined ? ALL_Z : z + r,
    mapKey: mapKeyOf(q.mapId, frameOf(q)),
  };
}
