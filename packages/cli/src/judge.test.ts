import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionController, Embedder, JudgeRequest } from '@oortmem/core';
import {
  JSON_NEVER_ASKS,
  NO_TTY_STDIN,
  PIPED_YES,
  expectAsked,
  expectDeclined,
  expectRefusedWithoutPrompt,
  fakeDecide,
  data,
  failed,
  harness,
  type Harness,
} from '../test/helpers.js';
import { MCP_JUDGMENTS_PER_DAY, localBackend } from './mcp.js';

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

const json = <T = Record<string, unknown>>(s: string): T => data<T>(s);

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
    expect(w.io.stdout).toContain('leave it out from now on');
    expect(w.io.stdout).toContain('recorded as withdrawn by local-user');
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
    await record(h, {
      subject: 'Video says a vitamin cures colds',
      reason: 'No source for a health claim.',
    });
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
    expect(json(imp.io.stdout)).toEqual({
      rows: 3,
      added: 3,
      corrected: 0,
      unchanged: 0,
      tombstoned: 0,
    });
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
      ref: 'p2',
      subject: 'Ad says a miracle remedy cures back pain',
      reason: 'Medical claim, no study cited.',
    });
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
    expect(ex.io.stdout).toContain('Exported 2 judgment(s)');
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
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({
      by: 'ada',
      via: 'pack',
      pack: { name: 'ada-content', exportedBy: 'anonymous' },
    });
    const again = await to.run(['judge', 'pack', 'import', out, '--yes']);
    expect(again.io.stdout).toContain('Imported 0 judgment(s)');
    // A pack's experts are as its exporter states them: used only when asked.
    const local = await to.run(['judge', 'apply', 'A vitamin cures colds']);
    expect(local.io.stdout).toContain('Needs the expert: no judgments are recorded');
    expect(local.io.stdout).toContain('2 imported judgment(s) were not used');
    const apply = await to.run(['judge', 'apply', 'A vitamin cures colds', '--include-imported']);
    expect(apply.io.stdout).toContain('Prediction: rejected');
    expect(apply.io.stdout).toContain('imported from pack ada-content');
    expect((await to.run(['judge', 'list'])).io.stdout).toContain(
      '[imported from pack ada-content]',
    );

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
    expect(json(imp.io.stdout)).toEqual({
      rows: 18,
      added: 18,
      corrected: 0,
      unchanged: 0,
      tombstoned: 0,
    });
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
    expect(r.io.stderr).toContain('Judgment memory is local-only for now');
  });
});

/** Writes the home config's `judge` section (the only place it is read). */
function homeJudge(h: Harness, judge: Record<string, unknown>): void {
  fs.mkdirSync(h.home, { recursive: true });
  fs.writeFileSync(path.join(h.home, 'config.json'), JSON.stringify({ judge }));
}

const mcpJudgment = (over: Record<string, unknown> = {}) => ({
  subject: 'Post says a vitamin cures the flu',
  verdict: 'rejected',
  reason: 'Health claim with no cited source.',
  criteria: ['no-source'],
  domain: 'content',
  by: 'ada',
  ...over,
});

const judgeInput = (over: Record<string, unknown> = {}) => ({
  item: 'A vitamin cures colds',
  limit: 5,
  include_imported: false,
  include_agent_recorded: false,
  ...over,
});

interface JudgeOut {
  status: string;
  why?: string;
  prediction?: { verdict: string; is: string };
  precedents: {
    quoted_reason: string;
    quoted_subject: string;
    by: string;
    via: string;
    confirmed: boolean;
    agent_recorded?: true;
    agrees?: boolean;
  }[];
  note: string;
  data_note: string;
  unconfirmed_agent_recorded_not_used?: number;
}

describe('oort mcp: judgment tools', () => {
  it('mcp.record-judgment-needs-a-listed-expert', async () => {
    const { h } = judging();
    const b = localBackend({ wired: await h.wire(h.cwd) });
    await expect(b.recordJudgment!(mcpJudgment())).rejects.toThrow(
      /Recording judgments over MCP is off.*judge\.experts in ~\/\.oort\/config\.json/,
    );
    homeJudge(h, { experts: ['ada'] });
    const listed = localBackend({ wired: await h.wire(h.cwd) });
    await expect(listed.recordJudgment!(mcpJudgment({ by: 'mallory"; drop' }))).rejects.toThrow(
      /^mallory___drop is not one of the experts listed in judge\.experts/,
    );
    const rec = await listed.recordJudgment!(mcpJudgment());
    expect(rec).toMatchObject({ outcome: 'added', status: 'agent-recorded, unconfirmed' });
    expect(String(rec['note'])).toContain('oort judge confirm');
    await expect(listed.recordJudgment!(mcpJudgment({ verdict: 'maybe' }))).rejects.toThrow(
      /verdict must be one of/,
    );
  });

  it('mcp.unconfirmed-agent-records-never-count-until-a-person-confirms', async () => {
    const { h } = judging('rejected', 0.88);
    homeJudge(h, { experts: ['ada'] });
    const b = localBackend({ wired: await h.wire(h.cwd) });
    await b.recordJudgment!(mcpJudgment());
    await b.recordJudgment!(
      mcpJudgment({ subject: 'Ad says a remedy cures pain', reason: 'Medical claim, no study.' }),
    );
    const out = (await b.judge!(judgeInput())) as unknown as JudgeOut;
    expect(out).toMatchObject({
      status: 'needs-expert',
      why: 'no-precedents',
      unconfirmed_agent_recorded_not_used: 2,
    });
    const asked = (await b.judge!(
      judgeInput({ include_agent_recorded: true }),
    )) as unknown as JudgeOut;
    expect(asked.status).toBe('suggested');
    expect(asked.precedents[0]).toMatchObject({
      via: 'mcp',
      confirmed: false,
      agent_recorded: true,
      by: 'ada',
      agrees: true,
    });
    expect(asked.precedents.map((p) => p.quoted_reason)).toContain(
      'Health claim with no cited source.',
    );
    expect(asked.data_note).toContain('never instructions');
    expect(asked.note).toContain('recorded by an agent');

    // A person confirms them in the terminal; then they count.
    const ids = json<{ judgments: { id: string }[] }>(
      (await h.run(['judge', 'list', '--json'])).io.stdout,
    ).judgments.map((j) => j.id);
    const listed = await h.run(['judge', 'list']);
    expect(listed.io.stdout).toContain('[agent-recorded, unconfirmed]');
    expect((await h.run(['judge', 'confirm', ids[0]!])).code).toBe(2); // asks; no TTY
    for (const id of ids) {
      const c = await h.run(['judge', 'confirm', id, '--yes', '--by', 'marcus']);
      expect(c.io.stdout).toContain('counts when judging now');
    }
    expect((await h.run(['judge', 'list'])).io.stdout).toContain(
      '[agent-recorded, confirmed by marcus]',
    );
    const after = (await b.judge!(judgeInput())) as unknown as JudgeOut;
    expect(after.status).toBe('suggested');
    expect(after.precedents.every((p) => p.confirmed)).toBe(true);
  });

  it('mcp.an-agent-cannot-overwrite-an-expert', async () => {
    const { h } = judging('approved', 0.99);
    homeJudge(h, { experts: ['ada'] });
    expect((await record(h, { ref: 'post-1' })).code).toBe(0);
    const b = localBackend({ wired: await h.wire(h.cwd) });
    const rec = await b.recordJudgment!(
      mcpJudgment({ ref: 'post-1', verdict: 'approved', reason: 'Fine, ship it.' }),
    );
    expect(rec['outcome']).toBe('added');
    expect(rec['corrects']).toBeUndefined();
    const listed = json<{ judgments: { verdict: string; via: string; current: boolean }[] }>(
      (await h.run(['judge', 'list', '--json'])).io.stdout,
    ).judgments;
    expect(listed.map((j) => [j.via, j.verdict, j.current]).sort()).toEqual([
      ['cli', 'rejected', true],
      ['mcp', 'approved', true],
    ]);
    // The forgery stays out of judging.
    const r = json<{ precedents: { via: string }[]; agentRecordedExcluded: number }>(
      (await h.run(['judge', 'apply', 'A vitamin cures colds', '--json'])).io.stdout,
    );
    expect(r.precedents.map((p) => p.via)).toEqual(['cli']);
    expect(r.agentRecordedExcluded).toBe(1);
  });

  it('mcp.recording-is-capped-per-day', async () => {
    const { h } = judging();
    homeJudge(h, { experts: ['ada'] });
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(h.home, 'judge-mcp-count.json'),
      JSON.stringify({ day: today, count: MCP_JUDGMENTS_PER_DAY - 1 }),
    );
    const b = localBackend({ wired: await h.wire(h.cwd) });
    await b.recordJudgment!(mcpJudgment());
    await expect(
      b.recordJudgment!(mcpJudgment({ subject: 'Another post', reason: 'Another reason.' })),
    ).rejects.toThrow(`already recorded ${MCP_JUDGMENTS_PER_DAY} judgments over MCP today`);
    // Yesterday's count does not carry over.
    fs.writeFileSync(
      path.join(h.home, 'judge-mcp-count.json'),
      JSON.stringify({ day: '2000-01-01', count: 999 }),
    );
    await expect(
      b.recordJudgment!(mcpJudgment({ subject: 'A third post', reason: 'Third.' })),
    ).resolves.toMatchObject({ outcome: 'added' });
  });

  it('mcp.concurrent-calls-never-exceed-the-cap', async () => {
    const { h } = judging();
    homeJudge(h, { experts: ['ada'] });
    const today = new Date().toISOString().slice(0, 10);
    const counter = path.join(h.home, 'judge-mcp-count.json');
    fs.writeFileSync(counter, JSON.stringify({ day: today, count: MCP_JUDGMENTS_PER_DAY - 3 }));
    // Two servers on the same home, ten calls at once.
    const servers = [
      localBackend({ wired: await h.wire(h.cwd) }),
      localBackend({ wired: await h.wire(h.cwd) }),
    ];
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        servers[i % 2]!.recordJudgment!(
          mcpJudgment({ subject: `Post ${i}`, reason: `Reason ${i}.` }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect(String((r as PromiseRejectedResult).reason)).toContain(
        `already recorded ${MCP_JUDGMENTS_PER_DAY} judgments over MCP today`,
      );
    }
    expect(JSON.parse(fs.readFileSync(counter, 'utf8'))).toEqual({
      day: today,
      count: MCP_JUDGMENTS_PER_DAY,
    });
    expect(fs.existsSync(path.join(h.home, 'judge-mcp-count.lock'))).toBe(false);
    const listed = json<{ judgments: unknown[] }>(
      (await h.run(['judge', 'list', '--all', '--json'])).io.stdout,
    ).judgments;
    expect(listed).toHaveLength(3);
  });

  it('mcp.unchanged-and-failed-writes-give-the-slot-back', async () => {
    const { h } = judging();
    homeJudge(h, { experts: ['ada'] });
    const counter = path.join(h.home, 'judge-mcp-count.json');
    const count = () => (JSON.parse(fs.readFileSync(counter, 'utf8')) as { count: number }).count;
    const b = localBackend({ wired: await h.wire(h.cwd) });
    await b.recordJudgment!(mcpJudgment({ ref: 'p1' }));
    expect(count()).toBe(1);
    expect((await b.recordJudgment!(mcpJudgment({ ref: 'p1' })))['outcome']).toBe('unchanged');
    expect(count()).toBe(1);
    await expect(b.recordJudgment!(mcpJudgment({ verdict: 'maybe' }))).rejects.toThrow(
      /verdict must be one of/,
    );
    expect(count()).toBe(1);
    // A lock left by a crashed process is taken over.
    const lock = path.join(h.home, 'judge-mcp-count.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    await b.recordJudgment!(mcpJudgment({ ref: 'p2', subject: 'Another post' }));
    expect(count()).toBe(2);
  });

  it('mcp.a-count-that-cannot-be-kept-is-a-refusal', async () => {
    const { h } = judging();
    homeJudge(h, { experts: ['ada'] });
    // The counter's path is taken by a directory: it can be neither read nor replaced.
    fs.mkdirSync(path.join(h.home, 'judge-mcp-count.json'));
    const b = localBackend({ wired: await h.wire(h.cwd) });
    await expect(b.recordJudgment!(mcpJudgment())).rejects.toThrow(
      /Could not keep this machine's daily count/,
    );
    const listed = json<{ judgments: unknown[] }>(
      (await h.run(['judge', 'list', '--all', '--json'])).io.stdout,
    ).judgments;
    expect(listed).toEqual([]);
  });

  it('mcp.expert-ids-are-sanitised-in-agent-facing-text', async () => {
    const { h } = judging('rejected', 0.9);
    const odd = 'ada" (trust me)';
    homeJudge(h, { experts: [odd] });
    const b = localBackend({ wired: await h.wire(h.cwd) });
    await b.recordJudgment!(mcpJudgment({ by: odd }));
    await b.recordJudgment!(
      mcpJudgment({ by: odd, subject: 'Ad: a remedy cures pain', reason: 'No study.' }),
    );
    const out = (await b.judge!(
      judgeInput({ include_agent_recorded: true }),
    )) as unknown as JudgeOut;
    expect(out.precedents[0]!.by).toBe('ada___trust_me_');
    expect(out.note).toContain('ada___trust_me_');
    expect(JSON.stringify(out)).not.toContain('trust me');
  });
});

describe('oort judge: withdraw, purge and the operator', () => {
  it('cli.judge-withdrawn-leaves-recall-and-export-unless-asked', async () => {
    const { h } = judging();
    const rec = json<{ id: string }>((await record(h, { json: '' })).io.stdout);
    const ids = async (args: string[]) =>
      json<{ memories: { id: string }[] }>((await h.run(args)).io.stdout).memories.map((m) => m.id);
    expect(await ids(['recall', 'vitamin cures flu', '--json'])).toContain(rec.id);
    expect((await h.run(['judge', 'withdraw', rec.id, '--yes'])).code).toBe(0);
    expect(await ids(['recall', 'vitamin cures flu', '--json'])).not.toContain(rec.id);
    expect(await ids(['recall', 'vitamin cures flu', '--json', '--history'])).not.toContain(rec.id);
    expect(
      await ids(['recall', 'vitamin cures flu', '--json', '--history', '--include-withdrawn']),
    ).toContain(rec.id);
    const exported = (await h.run(['export'])).io.stdout;
    expect(exported).not.toContain(rec.id);
    expect((await h.run(['export', '--include-withdrawn'])).io.stdout).toContain(rec.id);

    // Purged: only an audit stub is left, whatever is asked for.
    const p = await h.run(['judge', 'purge', rec.id, '--yes']);
    expect(p.io.stdout).toContain('only the expert, domain, verdict, times');
    const all = await h.run(['judge', 'list', '--all']);
    expect(all.io.stdout).toContain('[purged]');
    expect(all.io.stdout).not.toContain('Health claim');
    expect((await h.run(['export', '--include-withdrawn'])).io.stdout).not.toContain(
      'Health claim',
    );
    expect((await h.run(['judge', 'purge', rec.id, '--yes'])).io.stdout).toContain(
      'already purged',
    );
  });

  it('cli.judge-operator-comes-from-the-flag-or-the-home-config', async () => {
    const { h } = judging();
    homeJudge(h, { operator: 'marcus' });
    const a = json<{ id: string }>((await record(h, { json: '' })).io.stdout);
    const b = json<{ id: string }>(
      (await record(h, { ref: 'r2', subject: 'Other post', json: '' })).io.stdout,
    );
    expect((await h.run(['judge', 'withdraw', a.id, '--yes'])).io.stdout).toContain(
      'withdrawn by marcus',
    );
    expect(
      (await h.run(['judge', 'withdraw', b.id, '--yes', '--by', 'reviewer-2'])).io.stdout,
    ).toContain('withdrawn by reviewer-2');
    const listed = json<{ judgments: { id: string; withdrawn: { by: string } }[] }>(
      (await h.run(['judge', 'list', '--all', '--json'])).io.stdout,
    ).judgments;
    expect(Object.fromEntries(listed.map((j) => [j.id, j.withdrawn.by]))).toEqual({
      [a.id]: 'marcus',
      [b.id]: 'reviewer-2',
    });
  });

  it('cli.judge-import-reports-tombstoned-rows', async () => {
    const { h } = judging();
    fs.writeFileSync(
      path.join(h.cwd, 'past.csv'),
      'subject,verdict,reason,ref\n"Post A",rejected,"No source.",a\n',
    );
    await h.run(['judge', 'import', 'past.csv', '--domain', 'content', '--by', 'ada']);
    const id = json<{ judgments: { id: string }[] }>(
      (await h.run(['judge', 'list', '--json'])).io.stdout,
    ).judgments[0]!.id;
    await h.run(['judge', 'withdraw', id, '--yes']);
    const again = await h.run([
      'judge',
      'import',
      'past.csv',
      '--domain',
      'content',
      '--by',
      'ada',
    ]);
    expect(again.io.stdout).toContain(
      '0 added, 0 corrected, 0 already recorded, 1 withdrawn or corrected here before (not brought back)',
    );
  });
});

describe('oort judge: confirmations (CON-107)', () => {
  // Each refuses without a terminal on stdin, exits 0 when declined, and asks on stderr even with
  // stdout piped, acting on yes. --yes is covered by the tests above.
  const terminal = { tty: true, stdoutTTY: true, answer: 'n' } as const;

  it.each(['withdraw', 'purge'])('confirm.judge-%s-no-tty-declined-piped-yes', async (action) => {
    const { h } = judging();
    const id = json<{ id: string }>((await record(h, { json: '' })).io.stdout).id;
    if (action === 'purge') await h.run(['judge', 'withdraw', id, '--yes']);
    expectRefusedWithoutPrompt(await h.run(['judge', action, id]), NO_TTY_STDIN);
    const no = await h.run(['judge', action, id], terminal);
    expectDeclined(no);
    expect(no.io.stdout).toContain('Kept.');
    const yes = await h.run(['judge', action, id], PIPED_YES);
    expectAsked(yes);
    expect(yes.io.stdout).toContain(action === 'purge' ? 'Purged' : 'Withdrew');
  });

  it('confirm.judge-confirm-no-tty-declined-piped-yes', async () => {
    const { h } = judging();
    homeJudge(h, { experts: ['ada'] });
    await localBackend({ wired: await h.wire(h.cwd) }).recordJudgment!(mcpJudgment());
    const id = json<{ judgments: { id: string }[] }>(
      (await h.run(['judge', 'list', '--json'])).io.stdout,
    ).judgments[0]!.id;
    expectRefusedWithoutPrompt(await h.run(['judge', 'confirm', id]), NO_TTY_STDIN);
    const no = await h.run(['judge', 'confirm', id], terminal);
    expectDeclined(no);
    expect(no.io.stdout).toContain('Not confirmed.');
    const yes = await h.run(['judge', 'confirm', id], PIPED_YES);
    expectAsked(yes);
    expect(yes.io.stdout).toContain('counts when judging now');
  });

  it('confirm.judge-pack-import-no-tty-json-declined-piped-yes', async () => {
    const { h: from } = judging();
    await record(from);
    const out = path.join(from.root, 'p.pack.jsonl');
    expect((await from.run(['judge', 'pack', 'export', '--out', out])).code).toBe(0);
    const { h } = judging();
    const args = ['judge', 'pack', 'import', out];
    expectRefusedWithoutPrompt(await h.run(args), NO_TTY_STDIN);
    // --json never asks, even on a terminal: stdout is only the oort.v1 failure envelope.
    const j = await h.run([...args, '--json'], { ...terminal, answer: 'y' });
    expectRefusedWithoutPrompt(j, JSON_NEVER_ASKS);
    failed(j, 'needs-confirmation', 'judge pack import');
    const no = await h.run(args, terminal);
    expectDeclined(no);
    expect(no.io.stdout).toContain('Not imported.');
    // Re-review N1: the question says where an imported judgment is shown.
    expect(no.io.asked.join('')).toContain('pinned and shown at every session start');
    const yes = await h.run(args, PIPED_YES);
    expectAsked(yes);
    expect(yes.io.stdout).toContain('Imported 1 judgment(s)');
    const again = await h.run([...args, '--yes', '--json']);
    expect(again.code, again.io.stderr).toBe(0);
    expect(json<{ skipped: string[] }>(again.io.stdout).skipped).toHaveLength(1);
  });
});
