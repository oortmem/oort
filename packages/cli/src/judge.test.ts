import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionController, Embedder, JudgeRequest } from '@oortmem/core';
import { fakeDecide, harness, type Harness } from '../test/helpers.js';
import { localBackend } from './mcp.js';
import type { Wired } from './wire.js';

/** Items about health claims are near each other; anything else is far. */
const topicEmbedder: Embedder = {
  dimension: 4,
  async embed(texts) {
    return texts.map((t) =>
      /\b(cure|cures|remedy|vitamin)\b/i.test(t)
        ? Int8Array.from([100, 0, 0, 0])
        : Int8Array.from([0, 0, 0, 100]),
    );
  },
};

/** A harness whose decider also judges (answering `verdict` at `p`) and whose embedder has topics. */
function judging(verdict = 'rejected', p = 0.9, opts: { adapters?: boolean } = {}) {
  const h = harness(opts);
  const asked: JudgeRequest[] = [];
  const decide: DecisionController = {
    ...fakeDecide,
    async judge(req) {
      asked.push(req);
      const probabilities = Object.fromEntries(
        req.verdicts.map((v) => [v, v === verdict ? p : (1 - p) / (req.verdicts.length - 1)]),
      );
      return { verdict, probability: p, probabilities, decisions: [] };
    },
  };
  const base = h.wire;
  if (opts.adapters !== false) {
    h.wire = async (dir, o) => ({ ...(await base(dir, o)), decide, embed: topicEmbedder });
  }
  return { h, asked };
}

const record = (h: Harness, over: Record<string, string> = {}) => {
  const flags = {
    subject: 'Post says a vitamin cures the flu',
    verdict: 'rejected',
    reason: 'Health claim with no cited source.',
    domain: 'content',
    by: 'ada',
    ...over,
  };
  return h.run([
    'judge',
    'record',
    ...Object.entries(flags).flatMap(([k, v]) => (v === '' ? [`--${k}`] : [`--${k}`, v])),
  ]);
};

const json = <T = Record<string, unknown>>(s: string): T => JSON.parse(s) as T;

describe('oort judge', () => {
  it('cli.judge-record-apply-list-withdraw', async () => {
    const { h, asked } = judging('rejected', 0.9);
    const a = await record(h, { criteria: 'no-source,health-claim', ref: 'post-1' });
    expect(a.code).toBe(0);
    expect(a.io.stdout).toMatch(
      /^Recorded [0-9a-f]{8}: rejected "Post says a vitamin cures the flu" \(content, by ada, /,
    );
    const b = await record(h, {
      subject: 'Ad says a miracle remedy cures back pain',
      reason: 'Medical claim, no study cited.',
      json: '',
    });
    expect(json(b.io.stdout)).toMatchObject({ outcome: 'added', judgment: { by: 'ada' } });

    const r = await h.run([
      'judge',
      'apply',
      'Story says a herbal remedy cures anxiety',
      '--domain',
      'content',
    ]);
    expect(r.code).toBe(0);
    expect(r.io.stdout).toContain('Prediction: rejected');
    expect(r.io.stdout).toContain("A prediction, not ada's decision.");
    expect(r.io.stdout).toContain('reason: Health claim with no cited source.');
    expect(r.io.stdout).toContain('reason: Medical claim, no study cited.');
    expect(asked).toHaveLength(1);

    const j = await h.run(['judge', 'apply', 'A vitamin cures colds', '--json']);
    const res = json<{
      status: string;
      prediction: { verdict: string };
      precedents: { id: string }[];
    }>(j.io.stdout);
    expect(res.status).toBe('suggested');
    expect(res.precedents).toHaveLength(2);

    const listed = json<{ judgments: { id: string; reason: string }[] }>(
      (await h.run(['judge', 'list', '--json'])).io.stdout,
    ).judgments;
    expect(listed).toHaveLength(2);
    const gone = listed.find((x) => x.reason === 'Medical claim, no study cited.')!;

    // Withdrawn: gone from judging and the list at once, still visible with --all.
    expect((await h.run(['judge', 'withdraw', gone.id.slice(0, 8)])).code).toBe(2); // not a TTY
    const w = await h.run(['judge', 'withdraw', gone.id.slice(0, 8), '--yes']);
    expect(w.code).toBe(0);
    expect(w.io.stdout).toContain('no longer counts');
    const after = json<{ precedents: { id: string }[] }>(
      (await h.run(['judge', 'apply', 'A vitamin cures colds', '--json'])).io.stdout,
    );
    expect(after.precedents.map((p) => p.id)).not.toContain(gone.id);
    expect(
      json<{ judgments: unknown[] }>((await h.run(['judge', 'list', '--json'])).io.stdout)
        .judgments,
    ).toHaveLength(1);
    const all = await h.run(['judge', 'list', '--all']);
    expect(all.io.stdout).toContain('[withdrawn]');

    // Far from everything recorded: the expert is needed.
    const far = await h.run(['judge', 'apply', 'Quarterly revenue table formatting']);
    expect(far.io.stdout).toContain('Needs the expert: no recorded judgment is close enough');
  });

  it('cli.judge-record-corrects-and-refuses-bad-input', async () => {
    const { h } = judging();
    const first = json<{ id: string; outcome: string }>(
      (await record(h, { ref: 'post-9', json: '' })).io.stdout,
    );
    expect(first.outcome).toBe('added');
    const again = await record(h, {
      ref: 'post-9',
      verdict: 'approved',
      reason: 'The source is in the caption.',
    });
    expect(again.io.stdout).toContain(`It corrects ${first.id.slice(0, 8)}`);
    const bad = await record(h, { verdict: 'maybe' });
    expect(bad.code).toBe(2);
    expect(bad.io.stderr).toContain('verdict must be one of: approved, rejected');
    const missing = await h.run(['judge', 'record', '--subject', 'x']);
    expect(missing.code).toBe(2);
    expect(missing.io.stderr).toContain('--verdict is required');
  });

  it('cli.judge-keyless-returns-precedents-only', async () => {
    const h = harness({ adapters: false });
    const r = await record(h);
    expect(r.code).toBe(0);
    expect(r.io.stderr).toContain('no embedder');
    const a = await h.run(['judge', 'apply', 'Video says a vitamin cures the flu overnight']);
    expect(a.code).toBe(0);
    expect(a.io.stdout).toContain('Precedents only: no TypeSafe key');
    expect(a.io.stdout).toContain('reason: Health claim with no cited source.');
    const j = json<{ status: string; prediction?: unknown; similarity: string }>(
      (await h.run(['judge', 'apply', 'Video says a vitamin cures the flu', '--json'])).io.stdout,
    );
    expect(j.status).toBe('precedents-only');
    expect(j.prediction).toBeUndefined();
    expect(j.similarity).toBe('lexical');
    // eval needs predictions.
    fs.writeFileSync(path.join(h.cwd, 'held.csv'), 'subject,verdict,reason\nx,rejected,y\n');
    const e = await h.run(['judge', 'eval', 'held.csv', '--domain', 'content', '--by', 'ada']);
    expect(e.code).toBe(2);
    expect(e.io.stderr).toContain('TYPESAFE_API_KEY');
  });

  it('cli.judge-import-and-eval', async () => {
    const { h } = judging('rejected', 0.85);
    const csv = [
      'subject,verdict,reason,criteria,ref',
      '"Post says a vitamin cures the flu",rejected,"No source.",no-source,p1',
      '"Ad says a remedy cures back pain",rejected,"No study cited.",no-source,p2',
      '"Quarterly revenue chart",approved,"Plain data, fine.",,p3',
    ].join('\n');
    fs.writeFileSync(path.join(h.cwd, 'past.csv'), csv);
    const imp = await h.run([
      'judge',
      'import',
      'past.csv',
      '--domain',
      'content',
      '--by',
      'ada',
      '--json',
    ]);
    expect(imp.code).toBe(0);
    expect(json(imp.io.stdout)).toEqual({ rows: 3, added: 3, corrected: 0, unchanged: 0 });
    const again = await h.run([
      'judge',
      'import',
      'past.csv',
      '--domain',
      'content',
      '--by',
      'ada',
    ]);
    expect(again.io.stdout).toContain('0 added, 0 corrected, 3 already recorded');

    fs.writeFileSync(
      path.join(h.cwd, 'held.jsonl'),
      [
        { subject: 'Reel says vitamin C cures colds', verdict: 'rejected', reason: 'r' },
        { subject: 'Story says a remedy cures acne', verdict: 'approved', reason: 'r' },
      ]
        .map((x) => JSON.stringify({ ...x, domain: 'content', by: 'ada' }))
        .join('\n'),
    );
    const e = await h.run(['judge', 'eval', 'held.jsonl', '--thresholds', '0.5,0.9', '--json']);
    expect(e.code).toBe(0);
    const report = json<{ domains: Record<string, { items: number; points: unknown[] }> }>(
      e.io.stdout,
    );
    expect(report.domains['content']!.points).toEqual([
      { threshold: 0.5, coverage: 1, agreement: 0.5, predicted: 2, agreed: 1 },
      { threshold: 0.9, coverage: 0, agreement: null, predicted: 0, agreed: 0 },
    ]);
    const human = await h.run(['judge', 'eval', 'held.jsonl']);
    expect(human.io.stdout).toContain('content');
    expect(human.io.stdout).toContain('agreement');
    // Nothing held out was recorded.
    expect(
      json<{ judgments: unknown[] }>((await h.run(['judge', 'list', '--json'])).io.stdout)
        .judgments,
    ).toHaveLength(3);
  });

  it('cli.judge-pack-moves-between-agents-with-provenance', async () => {
    const { h: from } = judging();
    await record(from, { ref: 'p1' });
    await record(from, {
      subject: 'Refactor hides a null pointer',
      domain: 'code-review',
      by: 'cy',
      reason: 'Errors must not be swallowed.',
    });
    const out = path.join(from.root, 'ada.pack.jsonl');
    const ex = await from.run([
      'judge',
      'pack',
      'export',
      '--out',
      out,
      '--domain',
      'content',
      '--name',
      'ada-content',
    ]);
    expect(ex.code).toBe(0);
    expect(ex.io.stdout).toContain('Exported 1 judgment(s)');
    if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600);

    // Another agent, another store.
    const { h: to } = judging();
    const refused = await to.run(['judge', 'pack', 'import', out]);
    expect(refused.code).toBe(2); // asks first; no TTY
    const imp = await to.run([
      '--agent',
      'cursor',
      'judge',
      'pack',
      'import',
      out,
      '--yes',
      '--json',
    ]);
    expect(imp.code).toBe(0);
    expect(json<{ added: string[]; name: string }>(imp.io.stdout)).toMatchObject({
      name: 'ada-content',
    });
    const listed = json<{
      judgments: { by: string; via: string; pack: { name: string; exportedBy: string } }[];
    }>((await to.run(['judge', 'list', '--json'])).io.stdout).judgments;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      by: 'ada',
      via: 'pack',
      pack: { name: 'ada-content', exportedBy: 'anonymous' },
    });
    const again = await to.run(['judge', 'pack', 'import', out, '--yes']);
    expect(again.io.stdout).toContain('Imported 0 judgment(s)');
    const apply = await to.run(['judge', 'apply', 'A vitamin cures colds']);
    expect(apply.io.stdout).toContain('from pack ada-content');

    // A changed pack is refused.
    fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replace('Health claim', 'Wealth claim'));
    const bad = await to.run(['judge', 'pack', 'import', out, '--yes']);
    expect(bad.code).toBe(2);
    expect(bad.io.stderr).toContain('digest does not match');
  });

  it('cli.judge-example-sets-import-and-evaluate', async () => {
    // docs/examples: a synthetic training set and a held-out set, for `oort judge eval`.
    const examples = path.join(import.meta.dirname, '..', '..', '..', 'docs', 'examples');
    const { h } = judging('rejected', 0.8);
    const imp = await h.run([
      'judge',
      'import',
      path.join(examples, 'judgments-train.csv'),
      '--json',
    ]);
    expect(imp.code).toBe(0);
    expect(json(imp.io.stdout)).toEqual({ rows: 18, added: 18, corrected: 0, unchanged: 0 });
    const e = await h.run([
      'judge',
      'eval',
      path.join(examples, 'judgments-heldout.csv'),
      '--json',
    ]);
    expect(e.code).toBe(0);
    const report = json<{ domains: Record<string, { items: number }> }>(e.io.stdout);
    expect(Object.keys(report.domains)).toEqual(['code-review', 'content', '(all)']);
    expect(report.domains['(all)']!.items).toBe(10);
  });

  it('cli.judge-refuses-in-cloud-mode', async () => {
    const h = harness();
    const base = h.wire;
    h.wire = async (dir, o) => ({ ...(await base(dir, o)), mode: 'cloud', cloud: {} as never });
    const r = await record(h);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('judgment memory is local-only for now');
  });
});

describe('oort mcp: judgment tools', () => {
  it('mcp.record-judgment-and-judge', async () => {
    const { h } = judging('rejected', 0.88);
    const w: Wired = await h.wire(h.cwd);
    const b = localBackend({ wired: w });
    const rec = await b.recordJudgment!({
      subject: 'Post says a vitamin cures the flu',
      verdict: 'rejected',
      reason: 'Health claim with no cited source.',
      criteria: ['no-source'],
      domain: 'content',
      by: 'ada',
    });
    expect(rec).toMatchObject({ outcome: 'added', id: expect.any(String) });
    const out = (await b.judge!({ item: 'A vitamin cures colds', limit: 5 })) as {
      status: string;
      prediction: { verdict: string; is: string };
      precedents: { reason: string; agrees: boolean }[];
      note: string;
    };
    expect(out.status).toBe('suggested');
    expect(out.prediction.verdict).toBe('rejected');
    expect(out.prediction.is).toContain('not the expert decision');
    expect(out.precedents[0]).toMatchObject({
      reason: 'Health claim with no cited source.',
      agrees: true,
    });
    expect(out.note).toContain('prediction');
    await expect(
      b.recordJudgment!({
        subject: 's',
        verdict: 'maybe',
        reason: 'r',
        domain: 'content',
        by: 'ada',
      }),
    ).rejects.toThrow(/verdict must be one of/);
  });
});
