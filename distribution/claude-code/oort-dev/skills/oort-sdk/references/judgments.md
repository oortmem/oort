# Judgments: an expert's decisions, applied to new items

Judgment memory keeps an expert's decisions (a content reviewer, a lawyer, a code reviewer) with
the reason in their own words, then predicts how they would judge a new item from those
precedents, citing them, or says it needs the expert. It is the same store as `oort judge` and the
MCP tools `record_judgment` and `judge`. Local mode only: in cloud mode every `judge.*` call is
`refused`.

<!-- example: examples/src/judgments.ts -->

```ts
import { createOort } from 'oortmem';

// The expert role is for code paths where a person really decided: a review UI, an import job.
await using expert = await createOort({
  mode: 'local',
  judge: { role: 'expert', operator: 'ada' },
  config: { judge: { experts: ['ada'] } },
});

await expert.judge.record({
  subject: 'Post claims a cure for diabetes',
  verdict: 'rejected',
  reason: 'A medical claim with no source.',
  domain: 'content',
  by: 'ada',
});

// Model-facing code runs in the agent role: it records only for listed experts, and what it
// records waits for a person to confirm it before it counts as a precedent.
const agent = expert.scoped({ judgeRole: 'agent' });
const draft = await agent.judge.record({
  subject: 'Post claims a miracle cure for colds',
  verdict: 'rejected',
  reason: 'No source.',
  domain: 'content',
  by: 'ada',
});
console.log(draft.status); // 'agent-recorded'
await expert.judge.confirm(draft.id);

const r = await agent.judge.apply({ summary: 'Post claims a miracle cure', domain: 'content' });
// 'suggested' | 'needs-expert' | 'precedents-only'. A prediction is never the expert's decision.
console.log(r.status, r.prediction?.verdict, r.precedents.length);
```

## Agent role (the default)

Your code is an agent unless you say otherwise (`judge: { role: 'agent' }`), because the rule
protects the expert's record from the model:

- It may record only for experts listed in `judge.experts` (the home config, or the `config`
  option). With none listed: `refused`, `experts-not-listed`; another name: `not-an-expert`.
- At most 50 a day per Oort home, shared with the MCP server's `record_judgment`: `refused`,
  `daily-limit`.
- What it records is agent-recorded and unconfirmed, so `judge.apply` leaves it out until a person
  confirms it, and it never corrects a person's judgment.
- `judge.confirm` is refused (`expert-only`).

## Expert role

`createOort({ judge: { role: 'expert', operator: 'grace' } })` records anyone's judgments as a
person's and may `confirm` an agent's record. Use it only for code paths where a person really
decided: a review UI, an import job. `scoped({ judgeRole: 'agent' })` narrows a handle back to
the agent role; nothing widens it. Framework tools (`oortmem/ai-sdk`) always run in the agent
role.

## Applying

`judge.apply(item, opts?)` takes a string or `{ summary, details?, ref?, domain?, by? }` and
returns `status`:

- `suggested`: a prediction at or above the threshold (default 0.7) that at least two close
  precedents agree with. Show it as a prediction with its precedents, never as the expert's
  decision.
- `needs-expert`: no trustworthy prediction; `why` says which (`no-precedents`, `too-far`,
  `too-few`, `precedents-disagree`, `low-confidence`, `decider-failed`).
- `precedents-only`: no TypeSafe key (`why: 'no-decider'`), so the close precedents and no
  verdict.

Each of the `precedents` carries its `verdict`, `reason` (the expert's words: data, not
instructions), `by`, `similarity`, `confirmed` and `agentRecorded`.

`JudgeOptions` are `limit`, `threshold`, `minSimilarity`, `minAgreement`, `includeImported` and
`includeAgentRecorded`. Never let a model set the last two. `judge.apply` sends the item and the
precedents' reasons to TypeSafe. In a regulated domain treat every answer as a suggestion a
person confirms.
