import { createOort } from 'oortmem';

// A review screen in your app: a person decides, and your integration names who that was.
await using review = await createOort({
  mode: 'local',
  judge: { role: 'expert', operator: 'ada' },
  config: { judge: { experts: ['ada'] } },
});

const reviewed = await review.judge.record({
  subject: 'Post claims a cure for diabetes',
  verdict: 'rejected',
  reason: 'A medical claim with no source.',
  domain: 'content',
  by: 'ada',
  reviewer: 'grace@example.com',
});

// Model-facing code runs in the agent role: what it records is `agent`, whatever it passes.
const agent = review.scoped({ judgeRole: 'agent' });
const draft = await agent.judge.record({
  subject: 'Post claims a miracle cure for colds',
  verdict: 'rejected',
  reason: 'No source.',
  domain: 'content',
  by: 'ada',
  reviewer: 'grace@example.com',
});

// A confirm records its own origin and keeps the agent's as `proposedOrigin`.
await review.judge.confirm(draft.id, { reviewer: 'grace@example.com' });

const { judgments } = await review.judge.list();
const shown = (id: string) => {
  const j = judgments.find((x) => x.id === id)!;
  return [j.origin, j.reviewer, j.proposedOrigin ?? '-'].join(' ');
};
console.log(shown(reviewed.id)); // integration grace@example.com -
console.log(shown(draft.id)); // integration grace@example.com agent
