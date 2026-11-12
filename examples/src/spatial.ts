import { createOort, type Place } from 'oortmem';

// A robot's memory of a site: each fact is remembered with where it was seen. Places are kept by
// the local engine (0.9.0 or newer); Oort Cloud refuses them until it holds places too.
await using oort = await createOort({ mode: 'local' });

const room = (r: string, x: number, y: number, at?: string): Place => ({
  nodeId: `site:hq/room:${r}${at === undefined ? '' : `/${at}`}`,
  mapId: 'hq',
  pose: { x, y },
});
const seen: [string, Place][] = [
  ['The red toolbox is on shelf A1.', room('A', 1, 1, 'shelf:A1')],
  ['The aluminium ladder leans on the north wall.', room('A', 3, 4)],
  ['The cordless drill charges on bench A.', room('A', 2, 2, 'bench:A')],
  ['The blue toolbox is on shelf B3.', room('B', 11, 1, 'shelf:B3')],
  ['The torque wrench is in drawer 4.', room('B', 12, 3, 'drawer:4')],
  ['Spare fuses are in the grey cabinet.', room('B', 14, 1)],
  ['The green toolbox sits under the window.', room('B', 13, 4)],
  ['The first aid kit hangs by the door.', room('C', 21, 1)],
  ['The fire extinguisher is in the corner.', room('C', 24, 4)],
  ['The forklift charger is on the east wall.', room('C', 22, 3)],
];
for (const [fact, place] of seen) await oort.remember(fact, { place });

// Which toolboxes are in room B? `within` matches whole path segments: room:B, never room:B2.
const inB = await oort.recall('toolbox', { within: 'room:B' });
for (const m of inB.memories) console.log(m.why.placePath, '|', m.text);

// What is within 1.5 m of the robot? Distance is measured on the same map and frame only.
const here = { mapId: 'hq', pose: { x: 13, y: 3 }, radius: 1.5 };
const near = await oort.recall('toolbox', { near: here });
for (const m of near.memories) console.log(m.why.distanceM?.toFixed(2), '|', m.text);
