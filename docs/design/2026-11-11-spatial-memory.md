# Spatial memory, slice 1: place-tagged memories and `near`/`within` recall

Date: 2026-11-11. Status: proposed design, built in the same change. Issues: CON-84 (this slice),
CON-83 (the exploration), CON-85 to CON-89 (the later slices). Release: **0.9.0** (local engine
only). Oort Cloud refuses every spatial option until Spatial 4 (CON-87).

Oort already knows *when* a fact held: valid time, transaction time, supersede and correct. This
slice adds *where*. A memory can carry an optional `place`, and recall can keep to memories
**within** a named place or **near** a point. It is a semantic layer on top of a robot's or a
device's own map, never a map: localisation, mapping and frame alignment stay in the robot stack
(ROS 2 and the like). Oort stores, versions and explains what is where.

## 0. Decisions in brief

1. **A place is a path, plus optional coordinates.** `nodeId` names a node in a place tree as a
   path, root first: `site:hq/floor:2/room:B/shelf:B3`. Coordinates (`pose`, with `extent`) are in
   a named map (`mapId`, `mapVersion`) and frame (`frame`, default `map`). The tree is implicit in
   the paths: slice 1 has no place registry.
2. **`within` is topological, `near` is geometric.** `within: "room:B"` keeps memories whose path
   contains that run of whole segments, and everything below it. `near` keeps memories whose
   region lies within `radius` metres of a point on the same map and frame. Both together mean
   both.
3. **Coordinates from different maps are never compared.** A `near` on map `hq` sees nothing
   tagged on map `lab`, and nothing without coordinates. There is no transform registry (Spatial
   5 adds one).
4. **The filter runs inside the store, before k.** Like scope, it is enforced by `lexical` and
   `dense` themselves, so a global top-k can never crowd out the memories in the region, and
   callers never post-filter. A store says it can (`spatial: true`); recall refuses a spatial
   query against one that cannot, rather than return unfiltered rows.
5. **Ranking does not change.** The filter selects candidates; fusion, activation, rerank and the
   relevance gate run as before. The explanation adds `placePath` and `distanceM`.
6. **Time composes unchanged.** The temporal view (`current`, `as-of`, `known-at`, `history`)
   applies to what the filter found. Moving objects as supersessions, and a `changes` view, are
   Spatial 2 (CON-85).
7. **Local only in 0.9.0.** The local engine, `oort serve`, the CLI, the local MCP server and both
   SDKs (Python through `oort serve`). Cloud mode refuses with `refused` / `local-only`.
8. **The export format stays at version 2.** `place` is an optional field, added the way
   `judgment` was. Version 1 cannot hold it.

## 1. The place model

```ts
interface Place {
  /** A place path, root first: "site:hq/floor:2/room:B/shelf:B3". */
  nodeId?: string;
  /** The map the coordinates are in. Required with `pose`. */
  mapId?: string;
  /** Bumped by the robot stack when the map is re-optimised. Recorded, not filtered on. */
  mapVersion?: number;
  /** The coordinate frame; default "map". "odom" is refused: it drifts without bound. */
  frame?: string;
  /** Metres (x forward, y left, z up). z unknown: compared in two dimensions. */
  pose?: { x: number; y: number; z?: number; yaw?: number };
  /** The region around `pose`: a box (full sizes, centred) or a sphere. Default: the point. */
  extent?: { dx: number; dy: number; dz?: number } | { radius: number };
  /** WGS84, outdoors. Stored and returned; not searchable in slice 1. */
  geo?: { lat: number; lon: number; alt?: number };
  /** Pose uncertainty, metres (1 sigma), when the source knows it. Not searched on; observe
   *  treats two sightings within their combined sigma as the same place (section 2). */
  sigma?: number;
}
```

A place needs `nodeId`, `pose` or `geo`. The rules, checked in code (core's `checkPlace`) and
reported by field name:

- **`nodeId`:** 1 to 16 segments joined by `/`, at most 256 characters. A segment is 1 to 64
  letters (in any script, with their combining marks, so `कमरा` and `ห้อง` work), digits and
  `. _ : @ -`, starting with a letter, digit or one of those symbols (no spaces, no `/`). Paths
  are normalised to Unicode NFC when checked, so a decomposed `é` is stored and filtered as the
  composed one. Invisible characters are refused: every Unicode Default_Ignorable_Code_Point, such
  as the variation selectors (U+FE00 to U+FE0F) and the combining grapheme joiner (U+034F), since
  `room:B` followed by one looks exactly like `room:B` but would never match it. The exception is
  the joiners IDNA's ContextJ rules allow (RFC 5892, Appendix A.1 and A.2):
  - ZWJ (U+200D) only right after a virama, a character with Canonical_Combining_Class 9
    (Devanagari `क्` + ZWJ + `ष`, Sinhala `ශ්` + ZWJ + `රී`). It may end a segment, as Malayalam's
    older chillu spelling does (`ന്` + ZWJ).
  - ZWNJ (U+200C) right after a virama, or between two letters of a joining script (Arabic,
    Syriac, N'Ko, Mandaic, Mongolian, Adlam, Hanifi Rohingya, Manichaean, Psalter Pahlavi), with
    only nonspacing marks around it (Persian `خانه` + ZWNJ + `ی`).

  Any other joiner (`room:B` + ZWJ + `X`, one at the start of a segment, two in a row) is refused.
  The trade-off: Mongolian free variation selectors (U+180B to U+180F), ideographic variation
  sequences (U+E0100 to U+E01EF) and Khmer's inherent vowels (U+17B4, U+17B5) cannot appear in a
  place name; write the name without them. `kind:name` is the convention (`room:B`), not a rule.
  Comparison is otherwise exact and case-sensitive. Joiners are not folded out: a Persian name
  typed with and without its ZWNJ is two different places to `within`. Text search treats
  joiners its own way (it drops a ZWJ inside a word and splits words at a ZWNJ); place paths do
  not.
- **Before 0.9.0:** stores written by unreleased builds of `main` may hold place paths with
  characters refused since. Those places read back as none and should be tagged again. A memory
  whose stored place now fails the check loses that place, pose included, the next time the
  memory is rewritten. Spatial memory was never released, so there is no migration.
- **`mapId`, `frame`:** one word of 1 to 128 characters (letters, digits, `. _ : @ / -`). `frame`
  `odom` is refused, in any case: odometry drifts, so its coordinates mean nothing a day later.
- **Numbers** are finite. Coordinates are within ±10,000 km of the origin, `radius`, `dx`, `dy`,
  `dz` are above 0 and at most 10,000 km, `sigma` is at least 0, `mapVersion` is a whole number
  from 0. `lat` is −90 to 90 and `lon` −180 to 180.
- **Dependencies:** `pose` needs `mapId`; `extent` needs `pose`; `dz` needs `pose.z`.

**Why a path, not a registry.** A registered tree (`places` table, CRUD, ownership by a scope node)
is where the fleet slice (Spatial 5) is heading, with a Constellation owning a site's tree. In slice
1 a path costs nothing to adopt: a bridge writes `site:hq/room:B` without creating anything first,
it exports as a string, and a later registry can adopt the paths in use. What a registry would add
now (node anchors, re-anchoring after a loop closure, a box per room) is listed in §8.

## 2. Tagging a memory

- **SDK:** `remember(facts, { place })` tags every fact of the call; `observe({ ..., place })`
  tags the memories that turn writes. MCP: `remember` takes `place`. CLI: `oort remember "…"
  --place room:B [--map hq --pose 4.2,1.0[,0.9] --radius 0.5 --frame map]`.
- **The write path decides as before; the place rides along.** An ADD, SUPERSEDE or CORRECT writes
  a new memory carrying the observation's place (or none). A REFINE rewrites a memory in place: it
  keeps its own place unless the observation gives one. Nothing is inherited from a prior across a
  supersede or a correction: a fact about something that moved must not keep the old place.
- **A re-observation elsewhere is not a reinforcement.** When reconcile says REINFORCE but the
  observation's place differs from the memory's, the observation becomes a new memory (decision
  `place` / `elsewhere` / `add-instead`) instead of silently dropping where it was seen. The
  places differ when their paths differ; when both have poses and those are on different maps
  or frames, or further apart than the sum of their `sigma` (with no `sigma`, any distance); or
  when nothing could be compared (one has only a path, the other only coordinates). A matching
  path where only one side has a pose is the same place: a missing pose is no evidence of being
  elsewhere. An observation without a place reinforces as before. A low-gate turn (not worth a
  memory of its own) that strongly matches a memory seen elsewhere is skipped rather than
  reinforcing it. Deciding that this is a *move* (SUPERSEDE, with `lastObservedAt`) is Spatial
  2's job.
- **No person-location gate yet.** The bridge slice (CON-86) adds the default refusal of facts that
  place a person. Until then, `place` is written only by code that passes one explicitly; nothing
  infers a place from text.

## 3. What `within` and `near` mean

```ts
recall(query, {
  within?: string;                       // a place path, or a run of segments inside one
  near?: { mapId: string; frame?: string; pose: { x: number; y: number; z?: number }; radius: number };
})
```

- **`within: P`** keeps a memory whose `nodeId` contains `P`'s segments as a contiguous run of
  whole segments: `room:B` matches `site:hq/floor:2/room:B` and `site:hq/floor:2/room:B/shelf:B3`,
  never `room:B2`. Give more segments to disambiguate (`floor:2/room:B`). Memories without a
  `nodeId` never match.
- **`near`** keeps a memory with coordinates on the same `mapId` and `frame` whose region is within
  `radius` metres of the point. The region is the pose, or its box or sphere. Distance is to the
  nearest point of the region (0 inside). `z` counts only when both sides have one. `distanceM`
  reports it.
- **Both:** a memory must pass both. Neither: recall is exactly what it was.
- **Memories without a place** are invisible to spatial filters and unaffected otherwise.

**Composition with time.** The filter selects candidates in the first stage; the temporal view is
applied by fusion as before. `as-of Tuesday within shelf:B3` finds the facts tagged B3 that held on
Tuesday. `known-at` likewise. `history` returns the found facts with their whole supersede chain:
a chain version tagged elsewhere is still shown (marked `chain`), which is how a move from A to B
reads. A place belongs to one version of a fact, not to the fact across versions.

**Ranking.** Unchanged: lexical and dense first stage (now filtered), reciprocal rank fusion,
activation, specificity, rerank and the relevance gate. No proximity bonus in slice 1: being near
is a filter, not a score, so a spatial query never reorders what a plain query would rank. A bonus
for `near`, bounded like the activation boost, is a later option once there is an eval for it.

**Explanation.** `RecalledMemory.explanation` gains `placePath` (the memory's `nodeId`) and
`distanceM` (with `near`). The SDK's `why` has the same two fields, and every view has `place`.

## 4. Storage

**Contract.** `MemoryStore` gains `spatial?: true` and an optional fourth argument on `lexical`
and `dense`: `{ spatial?: SpatialFilter }`. A store that sets `spatial` stores `Memory.place`
exactly, checks it on write (`RangeError` naming the field), and applies the filter inside both
searches before taking k. The suite `spatialConformance` (in `@oortmem/core/store-conformance`)
proves it: a filter never returns rows outside the region, memories without a place are
unaffected, another map id returns nothing, and k is taken after the filter. The base
`storeConformance` is unchanged, so a store without spatial support (Oort Cloud's today) still
passes it.

**SQLite: schema version 5.**

- `memories` gains `place` (the JSON) and `place_node` (its `nodeId`).
- `memories_place USING rtree(rid, min_x, max_x, min_y, max_y, min_z, max_z, +map_key)` holds one
  row per memory with coordinates, keyed by the same `rid` as `memories` and the FTS index.
  `map_key` is `[mapId, frame]`. A pose without `z` spans all of z.
- `within` is `instr('/' || place_node || '/', '/' || P || '/') > 0`: whole segments, no wildcards.
- `near` is an R\*Tree box query (the query point ± radius), then an exact distance check in a
  registered function that reads the stored JSON. R\*Tree coordinates are 32-bit floats rounded
  outward, so the box query never misses a match; the exact check removes what it adds.
- Lexical: the predicate joins the FTS query. Dense: vec0's KNN takes `id IN (<spatial
  subquery>)`, so k is taken after the filter, inside sqlite-vec.
- Place-less queries use the same statements as before: no new cost when no filter is given.
- A stored place that does not parse or does not pass `checkPlace` (a crafted or damaged copy)
  is never returned by `near` (the exact check checks it first and gives it no distance) and
  reads back as no place. `within` reads the `place_node` column, not the JSON, so it can still
  return such a memory when that column matches, without its place. A missing R\*Tree is rebuilt
  on open from the checked places; those that fail are left out and counted in one log line.
- **Migration 4 → 5:** two `ALTER TABLE … ADD COLUMN`s and the empty R\*Tree, after the usual
  `pre-v5` backup. No rebuild. **Downgrade 5 → 4** (`downgradeSqliteStore({ to: 4 })`) drops them,
  and refuses while any memory has a place. An older Oort refuses a version 5 store, as before.

**In-memory store.** The reference implementation filters the same way in JS.

## 5. Surfaces

| Surface | Write | Read |
| --- | --- | --- |
| Core | `Memory.place`, `Observation.place` | `RecallQuery.near` / `within`; `SpatialUnsupportedError` |
| TS SDK | `remember(facts, { place })`, `observe({ place })` | `recall(q, { near, within })`; `place` on views, `why.placePath` / `why.distanceM` |
| Python | `remember(facts, place=…)`, `observe(place=…)` | `recall(q, near=…, within=…)`; `place`, `why.place_path` / `why.distance_m` |
| CLI | `oort remember --place --map --pose --radius --frame` | `oort recall` / `oort explain` with `--within`, `--near x,y[,z] --radius r --map m [--frame f]` |
| MCP (local) | `remember.place` | `recall.within`, `recall.near`; facts carry `place` (the path) and `distance_m` |
| `oort serve` | passes `place` through | passes `near` / `within` through |

- The SDK checks every spatial argument before any I/O (`usage` / `invalid-argument`, naming the
  field). The `oort.v1` contract cases cover both transports.
- **Cloud mode** refuses `place`, `near` and `within` with `OortRefusedError` (`refused`,
  `local-only`, fix `oort cloud use --local`) before anything is sent, in both SDKs and the CLI.
- **MCP:** the shared tool definitions offer `place`, `near` and `within` only when the backend
  says it has spatial memory (`MemoryBackend.spatial`), as with judgment tools. On any other
  backend (Oort Cloud's included) one sent anyway is refused as a tool error naming `local-only`,
  never stripped, so the model never believes its recall was filtered or its place stored. The remote
  connector's tool set is unchanged until Spatial 4.
- The `<oort-memory>` block is unchanged: no prompt format change in this slice.

## 6. Export format

`place` is an optional field of a version 2 line, written only when set. **Bump rules:** a field
that an older reader can ignore without misreading the rest is added within a version (as `judgment`
was, and now `place`). A change that would make an older reader misread a line (a field changing
meaning, a required field, a different encoding) bumps the version. A 0.8 reader of a 0.9 export
imports the memory without its place. `oort import` keeps a place that passes `checkPlace`; a
place that does not makes the whole file unreadable, naming its line (as any malformed line in
`parseExport` does), so nothing is imported half-checked. Version 1 cannot hold a place: `oort export --format 1`
refuses a place-tagged memory, and `oort cloud import` uploads it without its place and says how
many it stripped.

## 7. Tests

- Core: `checkPlace`, `placeDistance`, `withinPath`; the spatial conformance suite on both stores;
  recall with `within`, `near`, both, with time views and with a store that cannot; observe's place
  rules (ADD, SUPERSEDE, REFINE, reinforce-elsewhere).
- SQLite: migration 4 → 5 and back, refusal with places, orphan R\*Tree rows ignored.
- SDK contract cases (local and cloud, TS and Python), CLI, MCP, export and import.
- The example `examples/src/spatial.ts` and `examples/python/spatial.py` seed three rooms and ten
  objects and recall `toolbox` within room B; the examples suite runs both.
- Benchmarks: place-less recall runs the same statements as before (§4); `pnpm bench` is the check.

## 8. Not in slice 1

- A place registry: named nodes with anchors and boxes, re-anchoring memories after a loop closure,
  `within` answered geometrically from a node's box, `stalePose` from a current map version.
- Map transforms and cross-map queries (Spatial 5); geo search (`near` on latitude and longitude,
  H3 cells); a `within` box.
- Moving objects as SUPERSEDE with `lastObservedAt`, the `changes` view and observation coverage
  (Spatial 2); the ROS 2 bridge and the person-location gate (Spatial 3); Oort Cloud (Spatial 4);
  fleet sharing (Spatial 5); the dashboard map (Spatial 6).
- A proximity bonus in ranking; "here" or "in room B" read from the query text.
- Place in the `<oort-memory>` block.

## 9. Open questions

1. **Path or registry for the long run.** Paths are enough for one robot or one site. Is the
   registry (§8) Spatial 2's or Spatial 5's?
2. **`mapVersion` semantics.** Slice 1 records it. Should a `near` query name one, or should a
   newer version mark older poses as stale?
3. **Reinforce elsewhere.** Slice 1 adds a memory. Spatial 2 should turn it into a supersede when
   the entity is the same; is ADD the right interim behaviour, or should it supersede now?
