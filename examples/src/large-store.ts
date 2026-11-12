import { createOort } from 'oortmem';

// A large local store (0.9.0 or newer). `vectorIndex: 'binary'` searches a 1-bit code per memory
// and rescores the best 10 × k with their int8 vectors; the default, `auto`, does so from 100,000
// memories on. `adaptiveStop: 'rule'` (the default) leaves archived matches out, unread, when the
// hot and warm memories already answer.
await using oort = await createOort({
  mode: 'local',
  config: {
    store: { vectorIndex: 'binary' },
    recall: { adaptiveStop: 'rule' },
  },
});

await oort.remember('The auth service listens on port 8080 in staging.');
const { memories } = await oort.recall('which port does the auth service use?');
console.log(memories.map((m) => m.text).join('\n'));
