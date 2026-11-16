import { createOort } from 'oortmem';

// A review screen where a person reads what was recalled runs in the expert role.
await using person = await createOort({
  mode: 'local',
  judge: { role: 'expert', operator: 'ada' },
});

const saved = await person.remember(['The staging database runs Postgres 15.']);
const memoryId = saved.results[0]!.id!;

// Model-facing code runs in the agent role: its feedback waits for a person.
const agent = person.scoped({ judgeRole: 'agent' });
const draft = await agent.feedback({ memoryId, signal: 'wrong', note: 'Upgraded to 16 in May.' });
console.log(draft.kept && draft.feedback.status); // pending

// Nothing changes until the person confirms it. Then recall labels the memory contested.
const pending = await person.feedback.list({ status: 'pending' });
await person.feedback.confirm(pending.feedback[0]!.id);
const r = await person.recall('staging database version');
console.log(r.memories.find((m) => m.id === memoryId)?.contested?.signal); // wrong

// The person resolves it: store the right fact, and the old memory ends superseded.
const done = await person.feedback.supersede(
  pending.feedback[0]!.id,
  'The staging database runs Postgres 16.',
);
console.log(done.supersedes === memoryId, done.feedback.status); // true superseded
