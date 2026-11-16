import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Judgment, TrainingManifest } from '@oortmem/core';
import { makeFeedback, makePrediction, TG } from '@oortmem/core/store-conformance';
import { data, harness, memory, type Harness } from '../test/helpers.js';

/** `oort export training`: the labels as fine-tuning JSON Lines, from the local store. */

const DAY = (d: number): string => new Date(Date.UTC(2026, 9, d, 9)).toISOString();

function judged(id: string, over: Partial<Judgment>) {
  const judgment: Judgment = {
    subject: { summary: `Item ${id}` },
    verdict: 'rejected',
    verdicts: ['approved', 'rejected'],
    reason: `Reason ${id}.`,
    criteria: [],
    domain: 'content',
    by: 'ada',
    decidedAt: DAY(1),
    via: 'cli',
    origin: 'interactive',
    ...over,
  };
  return memory({
    id,
    type: 'judgment',
    text: `Judgment ${id}`,
    validFrom: judgment.decidedAt,
    createdAt: judgment.decidedAt,
    judgment,
  });
}

async function seeded(): Promise<Harness> {
  const h = harness();
  await h.store.upsertMany(TG, [
    judged('j-1', { decidedAt: DAY(1) }),
    judged('j-2', { decidedAt: DAY(2), origin: 'dashboard', reviewer: 'grace@example.com' }),
    judged('j-3', { decidedAt: DAY(3), origin: 'integration', via: 'sdk' }),
    judged('j-4', { decidedAt: DAY(4), via: 'mcp', origin: 'agent' }),
    judged('j-5', { decidedAt: DAY(5), withdrawn: { at: DAY(6), by: 'ada' } }),
    memory({ id: 'm-1', text: 'The team orders lunch on Fridays.' }),
    memory({ id: 'm-2', text: 'The auth service listens on port 5502.' }),
  ]);
  await h.store.putPrediction!(
    TG,
    makePrediction({
      id: 'p-1',
      verdict: 'approved',
      resolution: {
        verdict: 'rejected',
        reason: 'No source.',
        criteria: [],
        by: 'ada',
        at: DAY(7),
        via: 'cli',
        origin: 'interactive',
        agrees: false,
      },
    }),
  );
  for (const f of [
    makeFeedback({
      id: 'f-1',
      memoryId: 'm-1',
      signal: 'irrelevant',
      query: 'auth port',
      origin: 'interactive',
      status: 'recorded',
      createdAt: DAY(8),
    }),
    makeFeedback({
      id: 'f-2',
      memoryId: 'm-2',
      signal: 'helped',
      query: 'auth port',
      origin: 'interactive',
      status: 'recorded',
      createdAt: DAY(9),
    }),
    makeFeedback({ id: 'f-3', memoryId: 'm-1', signal: 'wrong', status: 'dismissed' }),
  ]) {
    expect(await h.store.putFeedback!(TG, f)).toBe('written');
  }
  return h;
}

const lines = (file: string): Record<string, unknown>[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const mode = (p: string): number => fs.statSync(p).mode & 0o777;
const posix = process.platform !== 'win32';

describe('oort export training', () => {
  it('cli.training-export-writes-one-file-per-kind-and-a-manifest', async () => {
    const h = await seeded();
    const r = await h.run(['export', 'training', '--kind', 'all', '--out', 'train', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    const out = path.join(h.cwd, 'train');
    const { dir, manifest } = data<{ dir: string; manifest: TrainingManifest }>(r.io.stdout);
    expect(dir).toBe(out);
    expect(fs.readdirSync(out).sort()).toEqual([
      'manifest.json',
      'preference.jsonl',
      'retrieval.jsonl',
      'sft.jsonl',
    ]);
    expect(lines(path.join(out, 'sft.jsonl')).map((x) => [x['id'], x['origin']])).toEqual([
      ['j-1', 'interactive'],
      ['j-2', 'dashboard'],
    ]);
    expect(lines(path.join(out, 'preference.jsonl'))).toHaveLength(1);
    expect(lines(path.join(out, 'retrieval.jsonl'))).toEqual([
      {
        query: 'auth port',
        positive: 'The auth service listens on port 5502.',
        negative: 'The team orders lunch on Fridays.',
        id: 'f-1',
        at: DAY(9),
        origin: 'interactive',
        positiveId: 'f-2',
        positiveOrigin: 'interactive',
      },
    ]);
    expect(manifest.excluded.sft).toEqual({
      withdrawn: 1,
      'agent-unconfirmed': 1,
      'origin-not-selected': 1,
    });
    expect(manifest.excluded.retrieval).toEqual({ dismissed: 1 });
    expect(manifest.oortVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))).toEqual(manifest);
    if (posix) {
      expect(mode(out)).toBe(0o700);
      for (const f of fs.readdirSync(out)) expect(mode(path.join(out, f)), f).toBe(0o600);
    }
  });

  it('cli.training-export-refuses-an-earlier-export-without-force', async () => {
    const h = await seeded();
    expect((await h.run(['export', 'training', '--kind', 'sft', '--out', 't'])).code).toBe(0);
    const again = await h.run(['export', 'training', '--kind', 'sft', '--out', 't']);
    expect(again.code).toBe(2);
    expect(again.io.stderr).toMatch(
      /already holds an export \(manifest\.json, sft\.jsonl\); pass --force/,
    );
    const forced = await h.run([
      'export',
      'training',
      '--kind',
      'sft',
      '--out',
      't',
      '--force',
      '--include',
      'integration',
    ]);
    expect(forced.code, forced.io.stderr).toBe(0);
    expect(lines(path.join(h.cwd, 't', 'sft.jsonl')).map((x) => x['id'])).toEqual([
      'j-1',
      'j-2',
      'j-3',
    ]);
    expect(forced.io.stdout).toContain('origins: interactive, dashboard, connector, integration');
  });

  it('cli.training-export-filters-origins-and-splits-by-time', async () => {
    const h = await seeded();
    const r = await h.run([
      'export',
      'training',
      '--kind',
      'sft',
      '--out',
      'split',
      '--include',
      'integration',
      '--exclude',
      'interactive',
      '--split',
      'time:0.5',
      '--json',
    ]);
    expect(r.code, r.io.stderr).toBe(0);
    const out = path.join(h.cwd, 'split');
    expect(lines(path.join(out, 'sft.train.jsonl')).map((x) => x['id'])).toEqual(['j-2']);
    expect(lines(path.join(out, 'sft.eval.jsonl')).map((x) => x['id'])).toEqual(['j-3']);
    const { manifest } = data<{ manifest: TrainingManifest }>(r.io.stdout);
    expect(manifest.filters.origins).toEqual(['dashboard', 'connector', 'integration']);
  });

  it('cli.training-export-refuses-bad-options', async () => {
    const h = await seeded();
    const agent = await h.run([
      'export',
      'training',
      '--kind',
      'all',
      '--out',
      'a',
      '--include',
      'agent',
    ]);
    expect(agent.code).toBe(2);
    expect(agent.io.stderr).toMatch(/Agent labels are never exported/);
    const kind = await h.run(['export', 'training', '--kind', 'chat', '--out', 'a']);
    expect(kind.io.stderr).toMatch(/--kind must be one of: sft, preference, retrieval, all/);
    const split = await h.run([
      'export',
      'training',
      '--kind',
      'all',
      '--out',
      'a',
      '--split',
      '0.8',
    ]);
    expect(split.io.stderr).toMatch(/--split must be time:<fraction>/);
    expect(fs.existsSync(path.join(h.cwd, 'a'))).toBe(false);
    fs.writeFileSync(path.join(h.cwd, 'file'), '');
    const file = await h.run(['export', 'training', '--kind', 'all', '--out', 'file']);
    expect(file.code).toBe(2);
    expect(file.io.stderr).toMatch(/is a file, not a directory/);
    // The backup's own flags are not the training export's.
    const format = await h.run([
      'export',
      'training',
      '--kind',
      'sft',
      '--out',
      'b',
      '--format',
      '1',
    ]);
    expect(format.code).toBe(2);
    expect(format.io.stderr).toMatch(/unknown option .--format/);
    expect(fs.existsSync(path.join(h.cwd, 'b'))).toBe(false);
  });

  it('cli.training-export-refuses-under-an-agent-harness-even-with-yes', async () => {
    const h = await seeded();
    const agentEnv = { env: { HOME: h.root, OORT_HOME: h.home, CLAUDECODE: '1' } };
    const r = await h.run(['export', 'training', '--kind', 'all', '--out', 'x'], agentEnv);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toMatch(/CLAUDECODE is set/);
    expect(r.io.stderr).toMatch(/in your own terminal/);
    const yes = await h.run(
      ['export', 'training', '--kind', 'all', '--out', 'x', '--yes', '--json'],
      agentEnv,
    );
    expect(yes.code).toBe(2);
    const body = JSON.parse(yes.io.stdout) as {
      ok: boolean;
      error: { code: string; reason?: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({ code: 'refused', reason: 'agent-harness' });
    expect(fs.existsSync(path.join(h.cwd, 'x'))).toBe(false);
    // In a person's terminal the same command runs, and --yes changes nothing.
    const person = await h.run(['export', 'training', '--kind', 'all', '--out', 'x', '--yes']);
    expect(person.code, person.io.stderr).toBe(0);
  });

  it('cli.training-export-keeps-the-mode-of-an-existing-out-and-refuses-a-shared-one', async () => {
    const h = await seeded();
    if (posix) fs.chmodSync(h.cwd, 0o755);
    const r = await h.run(['export', 'training', '--kind', 'sft', '--out', '.']);
    expect(r.code, r.io.stderr).toBe(0);
    if (posix) {
      expect(mode(h.cwd)).toBe(0o755);
      expect(mode(path.join(h.cwd, 'sft.jsonl'))).toBe(0o600);
      expect(mode(path.join(h.cwd, 'manifest.json'))).toBe(0o600);
      const shared = path.join(h.cwd, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      const refused = await h.run(['export', 'training', '--kind', 'sft', '--out', 'shared']);
      expect(refused.code).toBe(2);
      expect(refused.io.stderr).toMatch(/writable by other users.*could replace/);
      expect(mode(shared)).toBe(0o777);
      expect(fs.readdirSync(shared)).toEqual([]);
    }
  });

  it('cli.training-export-adds-preference-reasons-only-when-asked', async () => {
    const h = await seeded();
    const plain = await h.run(['export', 'training', '--kind', 'preference', '--out', 'p']);
    expect(plain.code, plain.io.stderr).toBe(0);
    expect(lines(path.join(h.cwd, 'p', 'preference.jsonl'))[0]).toMatchObject({
      chosen: 'Verdict: rejected',
      rejected: 'Verdict: approved',
    });
    const r = await h.run([
      'export',
      'training',
      '--kind',
      'preference',
      '--out',
      'q',
      '--preference-reasons',
      '--json',
    ]);
    expect(r.code, r.io.stderr).toBe(0);
    expect(lines(path.join(h.cwd, 'q', 'preference.jsonl'))[0]).toMatchObject({
      chosen: 'Verdict: rejected\nReason: No source.',
      rejected: 'Verdict: approved',
    });
    const { manifest } = data<{ manifest: TrainingManifest }>(r.io.stdout);
    expect(manifest.filters.preferenceReasons).toBe(true);
    expect(manifest.notes[0]).toMatch(/rejected .*has no reason/);
  });

  it('cli.training-export-leaves-oort-export-as-it-was', async () => {
    const h = await seeded();
    const r = await h.run(['export', '--out', 'backup.jsonl', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(data<{ memories: number }>(r.io.stdout).memories).toBe(6);
  });
});
