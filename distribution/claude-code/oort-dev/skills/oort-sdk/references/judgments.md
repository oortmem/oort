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

## Resolving predictions (after 0.10.0)

`judge.apply` keeps each answer as a prediction and returns its `predictionId`. When the person
decides, `judge.resolve` records it, and `judge.evalLive` reports how often the predictions
matched.

<!-- example: examples/src/predictions.ts -->

```ts
import { createOort } from 'oortmem';

// A review screen where a person decides runs in the expert role.
await using oort = await createOort({
  mode: 'local',
  judge: { role: 'expert', operator: 'ada' },
});

for (const subject of [
  'Post claims a miracle cure for colds',
  'Post claims a herbal cure for colds',
]) {
  await oort.judge.record({
    subject,
    verdict: 'rejected',
    reason: 'A medical claim with no source.',
    domain: 'content',
    by: 'ada',
  });
}

// judge.apply keeps each answer as a prediction and returns its id.
const r = await oort.judge.apply({
  summary: 'Satire post about a miracle cure for colds',
  domain: 'content',
});

// Later, the person decides. A different verdict with a reason becomes a judgment, word for word,
// so the next judge.apply on a similar item cites it.
const { agrees, judgment } = await oort.judge.resolve(r.predictionId!, {
  verdict: 'approved',
  reason: 'Satire, clearly labelled as parody.',
  by: 'ada',
});
console.log(agrees, judgment?.outcome); // false 'added' (agrees is null when there was no prediction)

// Agreement and calibration over every resolved prediction.
const live = await oort.judge.evalLive();
console.log(live.resolved, live.bands.length);
```

- `agrees` is `null` when judging needed the expert. The verdict must be one of the prediction's
  verdicts.
- A reason makes a new judgment, word for word, unless the person agreed. The next
  `judge.apply` on a similar item cites it.
- An unknown id is `not-found`. An already resolved, expired (30 days) or purged prediction is
  `refused` with reason `already-resolved`, `expired` or `purged`. None of them writes anything.
- In the agent role, `resolve` follows the rules for `record`, needs the whole prediction id,
  and stays unconfirmed until an expert role calls `judge.confirm(predictionId)`. `evalLive`
  leaves it out until then. An expert role's own `resolve` replaces it.
- A resolve that loses a race to another is `refused`, `conflict` (retryable); the judgment it
  recorded is taken back.
- Withdrawing or forgetting a judgment removes the text of the predictions that cited it.
  Forgetting a prediction leaves the judgment its resolve recorded.

## Where a label came from (after 0.10.0)

Each judgment, prediction resolution and feedback row records an `origin`: how the label
arrived. It is not proof that a person made it.

| Origin        | Recorded when                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interactive` | A person answered the CLI's prompt for this label on the controlling terminal. Code calling `@oortmem/core` directly can also record it, outside an agent harness; the CLI's question is the only path Oort itself offers |
| `dashboard`   | Reserved for the Oort Cloud dashboard. The public API cannot set it (it records `integration`); code that edits the store or loads Oort's internal files can write anything, as it could edit the database                |
| `connector`   | Reserved for upstream connectors (`upstream: { system, actor }`), kept only as `dashboard`                                                                                                                                |
| `integration` | An expert-role handle, `oort serve`, or a CLI call that is piped or uses `--yes` or `--json`                                                                                                                              |
| `agent`       | MCP or an agent-role handle                                                                                                                                                                                               |

<!-- example: examples/src/label-origin.ts -->

```ts
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
```

- An expert-role handle can pass `reviewer` (one line, at most 120 characters) to `record`,
  `resolve`, `feedback`, `judge.confirm` and `feedback.confirm`. It is the person your
  integration says decided; Oort stores it but cannot check it.
- Agents over MCP and agent-role handles always record `agent`. A `reviewer` an agent-role
  handle passes is ignored, and MCP has no field for either.
- The CLI never records `interactive` while one of `AGENT_ENV_MARKERS` is set (`AI_AGENT`,
  `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`,
  `CURSOR_AGENT`, `GEMINI_CLI`). An agent that can run commands can still drive a terminal, so
  `interactive` is only as trustworthy as the shells on that machine. For labels you will
  fine-tune on, prefer the dashboard and connectors; the training export will let you exclude
  `interactive`.
- A confirm records the confirmer's origin and keeps the agent's as `proposedOrigin`.
- Origin does not change authority. A row written before it existed reads `agent` when an agent
  recorded it and no person has confirmed it, and `integration` otherwise.
- An export of training data will trust only `interactive`, `dashboard` and `connector` labels
  by default, and will let you exclude `interactive`.
