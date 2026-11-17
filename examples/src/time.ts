import { createOort } from 'oortmem';

// A support agent's memory of one customer. Each turn carries when it was said (`at`), and a date
// in the fact ("until", "starting") sets when the fact holds.
await using oort = await createOort({ mode: 'local' });

await oort.observe({
  user: 'Acme is on the Starter plan until 31 March 2026.',
  assistant: 'Noted.',
  at: '2026-03-02T09:00:00Z',
});
await oort.observe({
  user: 'Acme is on the Business plan starting 1 April 2026.',
  assistant: 'Noted.',
  at: '2026-03-30T09:00:00Z',
});

const question = 'Which plan is Acme on?';

// What is true now: the Starter fact has ended, so only the Business plan comes back.
const now = await oort.recall(question);
console.log(now.memories.map((m) => m.text));

// What was true on a date: `asOf` reads the facts that held then.
const march = await oort.recall(question, { asOf: '2026-03-15' });
console.log(march.memories.map((m) => m.text));

// Every version, each with the dates it held. The ended fact is kept as history.
const history = await oort.recall(question, { mode: 'history' });
for (const m of history.memories) console.log(m.validFrom, m.validTo, m.text);
