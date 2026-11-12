import { createOort } from 'oortmem';

// The RaBitQ index (0.10.0 or newer, opt-in). Each memory gets a 1-bit code with an error bound;
// a recall rescores, with their int8 vectors, only the memories whose bound can still reach the
// top k. A native engine ships for macOS arm64 and Linux x64 and arm64; elsewhere the same index
// runs in TypeScript, and `oort doctor` says which one this machine uses.
await using oort = await createOort({
  mode: 'local',
  config: { store: { vectorIndex: 'rabitq' } },
});

await oort.remember('The billing service deploys on Fridays after the change freeze.');
const { memories } = await oort.recall('when does the billing service deploy?');
console.log(memories.map((m) => m.text).join('\n'));
