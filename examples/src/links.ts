import { createOort } from 'oortmem';

await using oort = await createOort({ mode: 'local' });

const saved = await oort.remember([
  'The billing service deploys on Fridays.',
  'Friday deploys wait for the change freeze to end.',
]);
const [deploys, freeze] = saved.results.map((r) => r.id!);

// A link holds no text: two ids, who asserted it and when. From the SDK that is always `agent`.
const linked = await oort.link(deploys!, freeze!);
console.log(linked.linked, linked.assertedBy); // true agent

// `explain` lists the links whose other end this handle can read; `hiddenLinks` counts the rest.
const { links, hiddenLinks } = await oort.explain(deploys!);
console.log(links.map((l) => `${l.kind} ${l.assertedBy}`).join(', '), hiddenLinks); // explicit agent 0

// Unlinking removes the link. A pair that could be related again is blocked until it is linked.
const removed = await oort.unlink(deploys!, freeze!);
console.log(removed.removed); // true
