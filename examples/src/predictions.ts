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
