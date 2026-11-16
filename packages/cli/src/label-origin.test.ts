import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionController, Feedback, Judgment, Prediction } from '@oortmem/core';
import { inputSchemas } from '@oortmem/mcp';
import { makeFeedback, TG } from '@oortmem/core/store-conformance';
import { data, fakeDecide, harness, memory, type Harness } from '../test/helpers.js';
import { localBackend } from './mcp.js';

/**
 * How a label arrived (`origin`), through the CLI and MCP: `interactive` only at a terminal with
 * no `--yes` or `--json`, `integration` for every other CLI call, `agent` for MCP whatever it
 * sends, and on a confirm the confirmer's origin with the agent's kept as `proposedOrigin`.
 */

const MEMORY = 'aaaaaaaa-0000-4000-8000-000000000001';
/** stdin and stdout both a terminal: a person could be answering. */
const TERMINAL = { tty: true, stdoutTTY: true } as const;

function judging(): Harness {
  const h = harness();
  // Agents may record for ada (MCP needs a listed expert).
  fs.mkdirSync(h.home, { recursive: true });
  fs.writeFileSync(
    path.join(h.home, 'config.json'),
    JSON.stringify({ judge: { experts: ['ada'] } }),
  );
  const decide: DecisionController = {
    ...fakeDecide,
    async judge(req) {
      const probabilities = Object.fromEntries(
        req.verdicts.map((v) => [v, v === 'rejected' ? 0.9 : 0.1 / (req.verdicts.length - 1)]),
      );
      return { verdict: 'rejected', probability: 0.9, probabilities, decisions: [] };
    },
  };
  const base = h.wire;
  h.wire = async (dir, o) => ({ ...(await base(dir, o)), decide });
  return h;
}

const record = (subject: string, ref?: string) => [
  'judge',
  'record',
  '--subject',
  subject,
  '--verdict',
  'rejected',
  '--reason',
  'Health claim with no cited source.',
  '--criteria',
  'no-source',
  '--domain',
  'content',
  '--by',
  'ada',
  ...(ref === undefined ? [] : ['--ref', ref]),
];

async function judgments(h: Harness): Promise<(Judgment & { id: string })[]> {
  const r = await h.run(['judge', 'list', '--all', '--json']);
  expect(r.code, r.io.stderr).toBe(0);
  return data<{ judgments: (Judgment & { id: string })[] }>(r.io.stdout).judgments;
}

const bySubject = async (h: Harness, subject: string) =>
  (await judgments(h)).find((j) => j.subject.summary === subject);

async function seed(h: Harness): Promise<void> {
  for (const subject of [
    'Post says a vitamin cures the flu',
    'Ad says a miracle remedy cures the flu',
    'Post says a vitamin cures colds',
  ]) {
    expect((await h.run(record(subject))).code).toBe(0);
  }
}

async function predict(h: Harness, item: string): Promise<string> {
  const r = await h.run(['judge', 'apply', item, '--domain', 'content', '--json']);
  expect(r.code, r.io.stderr).toBe(0);
  return data<{ predictionId: string }>(r.io.stdout).predictionId;
}

async function prediction(h: Harness, id: string): Promise<Prediction> {
  const r = await h.run(['judge', 'predictions', '--all', '--json']);
  return data<{ predictions: Prediction[] }>(r.io.stdout).predictions.find((p) => p.id === id)!;
}

async function feedback(h: Harness): Promise<(Feedback & { id: string })[]> {
  const r = await h.run(['feedback', 'list', '--json']);
  expect(r.code, r.io.stderr).toBe(0);
  return data<{ feedback: (Feedback & { id: string })[] }>(r.io.stdout).feedback;
}

describe('label origin: oort judge', () => {
  it('cli.origin-judge-record-is-interactive-only-at-a-terminal', async () => {
    const h = judging();
    const cases: [string, Parameters<Harness['run']>[1], string[], string][] = [
      ['typed at a terminal', TERMINAL, [], 'interactive'],
      ['with --json', TERMINAL, ['--json'], 'integration'],
      ['stdin piped', { tty: false, stdoutTTY: true }, [], 'integration'],
      ['stdout piped', { tty: true, stdoutTTY: false }, [], 'integration'],
    ];
    for (const [subject, io, extra] of cases) {
      const r = await h.run([...record(subject), ...extra], io);
      expect(r.code, r.io.stderr).toBe(0);
    }
    for (const [subject, , , origin] of cases) {
      expect((await bySubject(h, subject))?.origin, subject).toBe(origin);
    }
  });

  it('cli.origin-judge-resolve-records-it-on-the-resolve-and-its-judgment', async () => {
    const h = judging();
    await seed(h);
    const typed = await predict(h, 'Satire site says a vitamin cures the flu');
    const piped = await predict(h, 'Parody blog says a vitamin cures colds');
    const resolve = (id: string, reason: string) => [
      'judge',
      'resolve',
      id,
      '--verdict',
      'approved',
      '--reason',
      reason,
      '--by',
      'ada',
    ];
    expect((await h.run(resolve(typed, 'Labelled satire.'), TERMINAL)).code).toBe(0);
    expect((await h.run(resolve(piped, 'Labelled parody.'), { tty: true })).code).toBe(0);
    expect((await prediction(h, typed)).resolution).toMatchObject({ origin: 'interactive' });
    expect((await prediction(h, piped)).resolution).toMatchObject({ origin: 'integration' });
    const all = await judgments(h);
    expect(all.find((j) => j.reason === 'Labelled satire.')?.origin).toBe('interactive');
    expect(all.find((j) => j.reason === 'Labelled parody.')?.origin).toBe('integration');
  });

  it('cli.origin-agent-judgment-confirmed-at-a-terminal-keeps-the-proposed-origin', async () => {
    const h = judging();
    const b = localBackend({ wired: await h.wire(h.cwd) });
    // An agent cannot set or spoof an origin: extra fields are not part of the tool.
    const input = (subject: string) =>
      inputSchemas.record_judgment.parse({
        subject,
        verdict: 'rejected',
        reason: 'Health claim with no cited source.',
        domain: 'content',
        by: 'ada',
        origin: 'interactive',
        reviewer: 'grace',
      });
    const typed = await b.recordJudgment!(input('Agent row one'));
    const flagged = await b.recordJudgment!(input('Agent row two'));
    expect(await bySubject(h, 'Agent row one')).toMatchObject({ origin: 'agent' });
    expect((await bySubject(h, 'Agent row one'))?.reviewer).toBeUndefined();

    const ok = await h.run(['judge', 'confirm', String(typed['id'])], { ...TERMINAL, answer: 'y' });
    expect(ok.code, ok.io.stderr).toBe(0);
    expect(await bySubject(h, 'Agent row one')).toMatchObject({
      origin: 'interactive',
      proposedOrigin: 'agent',
    });
    // `--yes` never asks, so it is not a terminal confirm, even at one.
    const yes = await h.run(['judge', 'confirm', String(flagged['id']), '--yes'], TERMINAL);
    expect(yes.code, yes.io.stderr).toBe(0);
    expect(await bySubject(h, 'Agent row two')).toMatchObject({
      origin: 'integration',
      proposedOrigin: 'agent',
    });
  });

  it('cli.origin-agent-resolve-confirmed-at-a-terminal', async () => {
    const h = judging();
    await seed(h);
    const b = localBackend({ wired: await h.wire(h.cwd) });
    const id = await predict(h, 'Satire site says a vitamin cures the flu');
    const r = await b.resolvePrediction!(
      inputSchemas.resolve_prediction.parse({
        prediction_id: id,
        verdict: 'approved',
        by: 'ada',
        reason: 'Labelled satire.',
        origin: 'interactive',
        reviewer: 'grace',
      }),
    );
    expect(r).toMatchObject({ status: 'agent-recorded, unconfirmed' });
    expect((await prediction(h, id)).resolution).toMatchObject({ origin: 'agent' });
    expect((await judgments(h)).find((j) => j.reason === 'Labelled satire.')?.origin).toBe('agent');
    const ok = await h.run(['judge', 'confirm', id], { ...TERMINAL, answer: 'y' });
    expect(ok.code, ok.io.stderr).toBe(0);
    const resolution = (await prediction(h, id)).resolution;
    expect(resolution).toMatchObject({ origin: 'interactive', proposedOrigin: 'agent' });
    expect(resolution?.reviewer).toBeUndefined();
    expect((await judgments(h)).find((j) => j.reason === 'Labelled satire.')).toMatchObject({
      origin: 'interactive',
      proposedOrigin: 'agent',
    });
    const shown = await h.run(['judge', 'predictions', '--resolved']);
    expect(shown.io.stdout).toContain('[origin interactive, proposed agent]');
  });

  it('cli.origin-judge-list-shows-it-and-reads-older-rows', async () => {
    const h = judging();
    expect((await h.run(record('Typed at a terminal'), TERMINAL)).code).toBe(0);
    // A judgment written before origins were kept: no origin at all.
    const [m] = (await h.store.list(TG, { validOnly: false })).filter(
      (x) => x.judgment !== undefined,
    );
    const { origin: _o, ...j } = m!.judgment!;
    await h.store.upsert(TG, {
      ...m!,
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      judgment: { ...(j as Judgment), subject: { summary: 'Written by an older build' } },
    });
    // An agent's, from an older build, that no person has confirmed: it reads `agent`.
    await h.store.upsert(TG, {
      ...m!,
      id: 'bbbbbbbb-0000-4000-8000-000000000003',
      judgment: {
        ...(j as Judgment),
        via: 'mcp',
        subject: { summary: 'Recorded by an agent on an older build' },
      },
    });
    const text = await h.run(['judge', 'list']);
    expect(text.io.stdout).toMatch(/Typed at a terminal.*\[origin interactive\]/);
    expect(text.io.stdout).toMatch(/Written by an older build.*\[origin integration\]/);
    expect(text.io.stdout).toMatch(/Recorded by an agent on an older build.*\[origin agent\]/);
    expect(await bySubject(h, 'Recorded by an agent on an older build')).toMatchObject({
      origin: 'agent',
    });
    expect(await bySubject(h, 'Written by an older build')).toMatchObject({
      origin: 'integration',
    });
    expect(await bySubject(h, 'Typed at a terminal')).toMatchObject({ origin: 'interactive' });
  });
});

describe('label origin: oort feedback', () => {
  async function seeded(): Promise<Harness> {
    const h = harness();
    await h.store.upsert(
      TG,
      memory({ id: MEMORY, text: 'The auth service listens on port 5501 in staging.' }),
    );
    return h;
  }

  it('cli.origin-feedback-is-interactive-only-at-a-terminal', async () => {
    const h = await seeded();
    const give = async (note: string, io: Parameters<Harness['run']>[1], json = false) => {
      const r = await h.run(
        ['feedback', MEMORY, 'stale', '--note', note, ...(json ? ['--json'] : [])],
        io,
      );
      expect(r.code, r.io.stderr).toBe(0);
    };
    await give('typed', TERMINAL);
    await give('json', TERMINAL, true);
    await give('stdin piped', { tty: false, stdoutTTY: true });
    await give('stdout piped', { tty: true, stdoutTTY: false });
    const rows = Object.fromEntries((await feedback(h)).map((f) => [f.note, f.origin]));
    expect(rows).toEqual({
      typed: 'interactive',
      json: 'integration',
      'stdin piped': 'integration',
      'stdout piped': 'integration',
    });
  });

  it('cli.origin-agent-feedback-confirmed-keeps-the-proposed-origin', async () => {
    const h = await seeded();
    const b = localBackend({ wired: await h.wire(h.cwd) });
    expect(Object.keys(inputSchemas.feedback.shape)).not.toContain('origin');
    const pending = async (note: string) =>
      String(
        (
          await b.feedback!(
            inputSchemas.feedback.parse({
              memory_id: MEMORY,
              signal: 'wrong',
              note,
              origin: 'interactive',
              reviewer: 'grace',
            }),
          )
        )['feedback_id'],
      );
    const typed = await pending('confirmed at a terminal');
    const flagged = await pending('confirmed with yes');
    const before = (await feedback(h)).find((f) => f.id === typed);
    expect(before).toMatchObject({ origin: 'agent', status: 'pending' });
    expect(before?.reviewer).toBeUndefined();

    const ok = await h.run(['feedback', 'confirm', typed], { ...TERMINAL, answer: 'y' });
    expect(ok.code, ok.io.stderr).toBe(0);
    const yes = await h.run(['feedback', 'confirm', flagged, '--yes'], TERMINAL);
    expect(yes.code, yes.io.stderr).toBe(0);
    const rows = await feedback(h);
    expect(rows.find((f) => f.id === typed)).toMatchObject({
      origin: 'interactive',
      proposedOrigin: 'agent',
      status: 'open',
    });
    expect(rows.find((f) => f.id === flagged)).toMatchObject({
      origin: 'integration',
      proposedOrigin: 'agent',
    });
    const text = await h.run(['feedback', 'list']);
    expect(text.io.stdout).toContain('[origin interactive, proposed agent]');
    expect(text.io.stdout).toContain('[origin integration, proposed agent]');
  });

  it('cli.origin-feedback-list-reads-older-rows', async () => {
    const h = await seeded();
    // A row written before origins were kept: no origin at all.
    const old = makeFeedback({ id: 'cccccccc-0000-4000-8000-000000000003', memoryId: MEMORY });
    expect(old.origin).toBeUndefined();
    expect(await h.store.putFeedback!(TG, old)).toBe('written');
    expect((await feedback(h))[0]).toMatchObject({ origin: 'integration' });
    expect((await h.run(['feedback', 'list'])).io.stdout).toContain('[origin integration]');
    // An agent's, from an older build, that no person has confirmed: it reads `agent`.
    const agents = makeFeedback({
      id: 'cccccccc-0000-4000-8000-000000000004',
      memoryId: MEMORY,
      via: 'mcp',
      status: 'pending',
    });
    expect(await h.store.putFeedback!(TG, agents)).toBe('written');
    const rows = await feedback(h);
    expect(rows.find((f) => f.id === agents.id)).toMatchObject({ origin: 'agent' });
    expect(rows.find((f) => f.id === old.id)).toMatchObject({ origin: 'integration' });
    expect((await h.run(['feedback', 'list'])).io.stdout).toContain('[origin agent]');
  });

  it('mcp.origin-tools-take-no-origin-or-reviewer', () => {
    for (const tool of ['record_judgment', 'resolve_prediction', 'feedback'] as const) {
      const keys = Object.keys(inputSchemas[tool].shape);
      for (const k of ['origin', 'reviewer', 'upstream', 'proposed_origin']) {
        expect(keys, `${tool} ${k}`).not.toContain(k);
      }
    }
  });
});
