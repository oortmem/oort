import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DATASETS, fetchDataset, datasetPath } from './datasets.js';
import { cachingEmbedder } from './embed-cache.js';
import { fakeEmbedder } from './fake-embed.js';
import { evidenceIds, loadLocomo, parseLocomoDate } from './locomo.js';
import { loadLongMemEval, parseLongMemEvalDate, roundsOf } from './longmemeval.js';
import { estimateTokens, planPublicSet, renderPlan } from './public-plan.js';
import { publicMain, spread } from './public-main.js';
import { embedTextOf, runPublicSet } from './public-sets.js';

const sample = (name: string): unknown =>
  JSON.parse(fs.readFileSync(new URL(`../eval/public/${name}`, import.meta.url), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-public-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

describe('datasets (CON-147)', () => {
  it('datasets.pinned-revisions', () => {
    for (const d of Object.values(DATASETS)) {
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(d.url).toContain(d.revision.split('@')[1] as string);
      expect(d.licence).not.toBe('');
    }
  });

  it('datasets.fetch-checks-the-hash-and-never-keeps-a-mismatch', async () => {
    const body = Buffer.from('not locomo');
    const fake = (async () => new Response(body)) as unknown as typeof fetch;
    await expect(fetchDataset('locomo', { cacheDir: root, fetch: fake })).rejects.toThrow(
      /SHA-256/,
    );
    expect(fs.existsSync(datasetPath('locomo', root))).toBe(false);
    // A cached file with the recorded hash is reused without fetching.
    const pinned = { ...DATASETS.locomo };
    expect(createHash('sha256').update(body).digest('hex')).not.toBe(pinned.sha256);
  });
});

describe('LoCoMo adapter (CON-147)', () => {
  const set = loadLocomo(sample('locomo-sample.json'));
  const h = set.haystacks[0]!;

  it('locomo.dates-and-evidence', () => {
    expect(parseLocomoDate('1:56 pm on 8 May, 2023')).toBe('2023-05-08T13:56:00.000Z');
    expect(parseLocomoDate('12:05 am on 1 January, 2024')).toBe('2024-01-01T00:05:00.000Z');
    expect(() => parseLocomoDate('yesterday')).toThrow(/LoCoMo/);
    expect(evidenceIds(['D8:6; D9:17', 'D', 'D:11:26', 'D9:1 D4:4'])).toEqual([
      'D8:6',
      'D9:17',
      'D11:26',
      'D9:1',
      'D4:4',
    ]);
  });

  it('locomo.turns-in-order-with-session-dates', () => {
    expect(h.turns.map((t) => t.turnRef)).toEqual([
      'D1:1',
      'D1:2',
      'D1:3',
      'D1:4',
      'D2:1',
      'D2:2',
      'D2:3',
    ]);
    expect(h.turns[0]?.at).toBe('2024-03-03T09:15:00.000Z');
    expect(h.turns[4]?.at).toBe('2024-05-20T18:40:00.000Z');
    expect(h.turns[2]?.userText).toBe(
      'Ana: Pixel already sleeps on my keyboard. [shares an image: a grey cat lying on a laptop keyboard]',
    );
    expect(h.turns[4]?.sessionId).toBe('sample-1:session_2');
    expect(h.now).toBe('2024-05-21T18:40:02.000Z');
  });

  it('locomo.questions-categories-and-dropped-evidence', () => {
    expect(h.questions.map((q) => [q.group, q.evidence])).toEqual([
      ['single-hop', ['D1:1']],
      ['multi-hop', ['D1:4', 'D2:1']],
      ['temporal', ['D2:1']],
      ['single-hop', ['D1:3']],
      ['adversarial', ['D2:3']],
    ]);
    expect(set.droppedQuestions).toBe(1);
    expect(set.droppedEvidence).toBe(1);
  });

  it('locomo.run-scores-evidence-through-turnRef', async () => {
    const r = await runPublicSet({ set, ks: [1, 5, 10] });
    expect(r.turns).toBe(7);
    expect(r.questions).toBe(5);
    expect(r.links).toBe('off');
    expect(Object.keys(r.turn.groups)).toEqual([
      'overall',
      'single-hop',
      'multi-hop',
      'temporal',
      'adversarial',
    ]);
    // "What is the name of Ana's cat?" finds the turn that names the cat.
    expect(r.turn.groups['single-hop']?.recallAt[10]).toBeGreaterThan(0);
    expect(r.session).toBeUndefined();
    const again = await runPublicSet({ set, ks: [1, 5, 10] });
    expect(again.turn).toEqual(r.turn);
  });
});

describe('LongMemEval adapter (CON-147)', () => {
  const set = loadLongMemEval(sample('longmemeval-sample.json'));

  it('longmemeval.rounds-dates-and-evidence', () => {
    expect(parseLongMemEvalDate('2023/05/20 (Sat) 02:21')).toBe('2023-05-20T02:21:00.000Z');
    expect(
      roundsOf([
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'q1', has_answer: true },
        { role: 'assistant', content: 'a1' },
      ]),
    ).toEqual([
      { user: '', assistant: 'hi', answer: false },
      { user: 'q1', assistant: 'a1', answer: true },
    ]);
    const [ms, ku, abs] = set.haystacks;
    expect(ms?.turns.map((t) => t.turnRef)).toEqual(['s-a#0', 's-a#1', 'noise-1#0', 's-b#0']);
    expect(ms?.questions[0]).toMatchObject({
      group: 'multi-session',
      evidence: ['s-a#0', 's-b#0'],
      answerSessions: ['s-a', 's-b'],
    });
    expect(ms?.now).toBe('2024-04-10T10:00:00.000Z');
    // knowledge-update: the latest answer session is expected, the earlier one is stale.
    expect(ku?.questions[0]).toMatchObject({
      group: 'knowledge-update',
      evidence: ['k-new#1'],
      stale: ['k-old#0'],
    });
    expect(abs?.questions[0]).toMatchObject({ group: 'abstention', abstention: true });
  });

  it('longmemeval.run-reports-turns-and-sessions', async () => {
    const r = await runPublicSet({ set, ks: [5, 10] });
    expect(r.haystacks).toBe(3);
    expect(r.turns).toBe(8);
    expect(r.turn.groups['abstention']?.abstainFp).not.toBeNull();
    expect(r.turn.groups['knowledge-update']?.staleLeak).not.toBeNull();
    expect(Object.keys(r.session?.groups ?? {})).toEqual([
      'overall',
      'multi-session',
      'knowledge-update',
    ]);
    // The second pottery session says "class", not "classes": the relevance gate (word coverage
    // 0.2 of 0.5) drops it, as today's recall does; without the gate both sessions come back.
    expect(r.session?.groups['multi-session']?.recallAt[10]).toBe(0.5);
    const open = await runPublicSet({ set, ks: [5, 10], gate: false });
    expect(open.session?.groups['multi-session']?.recallAt[10]).toBe(1);
  });
});

describe('plan and paid models (CON-147)', () => {
  const set = loadLongMemEval(sample('longmemeval-sample.json'));

  it('public.limit-spreads-through-the-file', () => {
    expect(spread([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([0, 3, 6]);
    expect(spread([0, 1], 5)).toEqual([0, 1]);
  });

  it('plan.counts-what-would-be-sent', () => {
    const p = planPublicSet(set, {
      embedModel: 'voyage-3.5-lite',
      rerankModel: 'rerank-3-lite',
      rerankK: 30,
      tokens: estimateTokens,
    });
    // 8 rounds, one of them in two haystacks with the same text: 7 distinct texts.
    const texts = new Set(set.haystacks.flatMap((h) => h.turns.map((t) => embedTextOf(t))));
    expect(texts.size).toBe(7);
    expect(p.embed?.documents.texts).toBe(texts.size);
    expect(p.embed?.documents.requests).toBe(1);
    expect(p.embed?.queries.requests).toBe(3);
    expect(p.rerank?.calls).toBe(3);
    expect(p.rerank?.documentsPerCall).toBe(4);
    expect(p.embed?.usd).toBeCloseTo(
      ((p.embed?.documents.tokens ?? 0) + (p.embed?.queries.tokens ?? 0)) * 0.02e-6,
    );
    expect(renderPlan(p)).toMatch(/Nothing was sent[\s\S]*estimated at 4 chars/);
    const cached = planPublicSet(set, {
      embedModel: 'voyage-3.5-lite',
      rerankK: 30,
      tokens: estimateTokens,
      cached: () => true,
    });
    expect(cached.embed?.documents).toMatchObject({ cached: texts.size, requests: 0, tokens: 0 });
  });

  it('plan.paid-models-without---yes-send-nothing', async () => {
    vi.stubEnv('VOYAGE_API_KEY', '');
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
    const code = await publicMain(
      {
        set: 'longmemeval',
        file: fileURLToPath(new URL('../eval/public/longmemeval-sample.json', import.meta.url)),
        fetch: false,
        plan: false,
        yes: false,
        embed: 'voyage',
        rerank: 'voyage',
        links: 'off',
        noGate: false,
        k: '5,10',
        json: false,
        cacheDir: root,
      },
      () => {},
    );
    expect(code).toBe(2);
    expect(out.join('')).toContain('Nothing was sent');
    vi.unstubAllEnvs();
  });

  it('embed-cache.prefetches-in-batches-and-persists', async () => {
    const file = path.join(root, 'emb.sqlite');
    const calls: number[] = [];
    const base = fakeEmbedder(8);
    const counting = {
      dimension: 8,
      embed: async (t: string[], k: 'document' | 'query') => (
        calls.push(t.length),
        base.embed(t, k)
      ),
    };
    const a = cachingEmbedder(counting, { model: 'm', file });
    await a.prefetch(['x', 'y', 'z', 'x'], 'document', 2);
    expect(calls).toEqual([2, 1]);
    await a.embed(['y', 'w'], 'document');
    expect(calls).toEqual([2, 1, 1]);
    expect(a.usage()).toMatchObject({ requests: 3, texts: 4, hits: 1 });
    a.close();
    const b = cachingEmbedder(counting, { model: 'm', file });
    expect(b.has('w', 'document')).toBe(true);
    expect(b.has('w', 'query')).toBe(false);
    expect(await b.embed(['x'], 'document')).toEqual(await base.embed(['x'], 'document'));
    expect(calls).toHaveLength(3);
    b.close();
  });
});
