import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOort } from 'oortmem';

// A review screen in your app: a person decides, so the handle runs in the expert role.
await using review = await createOort({
  mode: 'local',
  judge: { role: 'expert', operator: 'ada' },
});

await review.judge.record({
  subject: 'Post claims a cure for diabetes',
  verdict: 'rejected',
  reason: 'A medical claim with no source.',
  domain: 'content',
  by: 'ada',
  reviewer: 'grace@example.com',
});

// Labels from code arrive as `integration`: add it to the default origins to export them.
const out = mkdtempSync(join(tmpdir(), 'oort-training-'));
const { manifest } = await review.exportTraining({ kind: 'sft', out, include: ['integration'] });

const rows = readFileSync(join(out, 'sft.jsonl'), 'utf8').trim().split('\n');
const row = JSON.parse(rows[0]!) as { messages: { content: string }[]; origin: string };
console.log(manifest.counts.sft?.rows, row.origin); // 1 integration
console.log(row.messages[1]!.content.split('\n')[0]); // Verdict: rejected

// Model-facing code runs in the agent role, and an agent never exports training data.
const agent = review.scoped({ judgeRole: 'agent' });
await agent.exportTraining({ kind: 'sft', out }).catch((e: { reason?: string }) => {
  console.log(e.reason); // expert-only
});
