import { createOort, OortRefusedError } from 'oortmem';

// In Oort Cloud an Oort key acts in the agent role: it records for the experts your account lists
// in the dashboard, and what it records waits there for a person to confirm it.
await using oort = await createOort({ mode: 'cloud', keySources: ['env'] });

const { experts } = await oort.judge.experts.get();
const draft = await oort.judge.record({
  subject: 'Post claims a miracle cure for colds',
  verdict: 'rejected',
  reason: 'No source.',
  domain: 'content',
  by: experts[0]!,
});
console.log(draft.status); // 'agent-recorded'

// Unconfirmed agent records are left out of judging until a person confirms them.
const r = await oort.judge.apply({ summary: 'Post claims a miracle cure', domain: 'content' });
console.log(r.status, r.agentRecordedExcluded);

try {
  await oort.judge.confirm(draft.id);
} catch (e) {
  // A person's decision: made in the dashboard, not with a key.
  if (!(e instanceof OortRefusedError) || e.reason !== 'expert-only') throw e;
  console.log('confirm in the dashboard');
}
