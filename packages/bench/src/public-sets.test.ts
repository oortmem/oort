import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DATASETS, fetchDataset, datasetPath } from './datasets.js';
import { cachingEmbedder } from './embed-cache.js';
import { fakeEmbedder } from './fake-embed.js';
import { diaId, evidenceIds, loadLocomo, parseLocomoDate } from './locomo.js';
import { loadLongMemEval, parseLongMemEvalDate, roundsOf } from './longmemeval.js';
import { estimateTokens, planPublicSet, renderPlan } from './public-plan.js';
import { publicMain, spread, type PublicArgs } from './public-main.js';
import { embedTextOf, runPublicSet, sessionsOfRounds } from './public-sets.js';
import { computeMetrics } from './eval.js';

const sample = (name: string): unknown =>
  JSON.parse(fs.readFileSync(new URL(`../eval/public/${name}`, import.meta.url), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-public-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const SAMPLE_LME = fileURLToPath(
  new URL('../eval/public/longmemeval-sample.json', import.meta.url),
);
const args = (over: Partial<PublicArgs>): PublicArgs => ({
  set: 'longmemeval',
  fetch: false,
  plan: false,
  yes: false,
  unpinned: false,
  embed: 'none',
  rerank: 'none',
  links: 'off',
  noGate: false,
  k: '5,10',
  json: false,
  cacheDir: root,
  ...over,
});
/** A fetch that fails the test if anything calls it. */
const noNetwork = () => {
  const f = vi.fn(() => {
    throw new Error('the network was called');
  });
  vi.stubGlobal('fetch', f);
  return f;
};
const quiet = () => {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  return out;
};

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

describe('pinning (CON-147)', () => {
  it('datasets.download-stops-past-the-recorded-size', async () => {
    let signal: AbortSignal | undefined;
    let sent = 0;
    const chunk = new Uint8Array(64 * 1024);
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += chunk.length;
        if (sent > 50 * DATASETS.locomo.bytes) c.close();
        else c.enqueue(chunk);
      },
    });
    const fake = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(endless);
    }) as unknown as typeof fetch;
    const cacheDir = path.join(root, 'cap');
    await expect(fetchDataset('locomo', { cacheDir, fetch: fake })).rejects.toThrow(
      /more than the recorded/,
    );
    expect(signal?.aborted).toBe(true);
    // It stopped near the cap, not at the end of the stream.
    expect(sent).toBeLessThan(DATASETS.locomo.bytes * 2);
    const dir = path.dirname(datasetPath('locomo', cacheDir));
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('public.a-file-by-path-needs---unpinned', async () => {
    noNetwork();
    const out = quiet();
    const log: string[] = [];
    const code = await publicMain(args({ file: SAMPLE_LME }), (m) => log.push(m));
    expect(code).toBe(1);
    expect(log.join('\n')).toMatch(/--unpinned/);
    expect(out.join('')).toBe('');
  });

  it('public.a-hash-mismatch-is-refused-before-parsing', async () => {
    noNetwork();
    const cacheDir = path.join(root, 'mismatch');
    const file = datasetPath('longmemeval', cacheDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Not JSON: parsing it would throw, so a clean exit 1 shows it was never parsed.
    fs.writeFileSync(file, 'not json');
    const log: string[] = [];
    const code = await publicMain(args({ cacheDir }), (m) => log.push(m));
    expect(code).toBe(1);
    expect(log.join('\n')).toMatch(/SHA-256 .* is not the recorded/);
  });

  it('public.---unpinned-runs-and-records-pinned-false', async () => {
    noNetwork();
    quiet();
    const outFile = path.join(root, 'unpinned.json');
    const code = await publicMain(
      args({ file: SAMPLE_LME, unpinned: true, out: outFile }),
      () => {},
    );
    expect(code).toBe(0);
    const report = JSON.parse(fs.readFileSync(outFile, 'utf8')) as {
      dataset: { pinned: boolean };
    };
    expect(report.dataset.pinned).toBe(false);
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

  it('locomo.ids-without-leading-zeros', () => {
    expect(diaId('D30:05')).toBe('D30:5');
    expect(diaId('D03:007')).toBe('D3:7');
    expect(evidenceIds(['D30:05', 'D:01:2'])).toEqual(['D30:5', 'D1:2']);
    const padded = loadLocomo([
      {
        sample_id: 'z',
        conversation: {
          session_1_date_time: '9:15 am on 3 March, 2024',
          session_1: [{ speaker: 'A', dia_id: 'D01:01', text: 'hello there' }],
        },
        qa: [{ question: 'hi?', answer: 'x', evidence: ['D1:01'], category: 4 }],
      },
    ]);
    expect(padded.haystacks[0]?.turns[0]?.turnRef).toBe('D1:1');
    expect(padded.haystacks[0]?.questions[0]?.evidence).toEqual(['D1:1']);
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
      // Sessions follow the rounds: only the latest answer session is expected.
      answerSessions: ['k-new'],
      staleSessions: ['k-old'],
    });
    expect(abs?.questions[0]).toMatchObject({ group: 'abstention', abstention: true });
  });

  it('longmemeval.session-recall-at-k-reads-the-top-k-rounds', () => {
    const sessionOf = new Map([
      ['a0', 'a'],
      ['a1', 'a'],
      ['b0', 'b'],
    ]);
    const ids = sessionsOfRounds(['a0', 'a1', 'b0'], sessionOf);
    expect(ids).toEqual(['a', 'a', 'b']);
    const r = computeMetrics(
      [{ question: 'q', expectedMemoryIds: ['a', 'b'] }],
      [{ ids, aboveThreshold: ids.length }],
      [1, 2, 3],
    );
    // The top 2 rounds are both in session a: one of two answer sessions.
    expect(r.groups['overall']?.recallAt).toEqual({ 1: 0.5, 2: 0.5, 3: 1 });
  });

  it('longmemeval.run-reports-turns-and-sessions', async () => {
    const r = await runPublicSet({ set, ks: [5, 10] });
    expect(r.haystacks).toBe(3);
    expect(r.turns).toBe(8);
    expect(r.turn.groups['abstention']?.abstainFp).not.toBeNull();
    expect(r.turn.groups['knowledge-update']?.staleLeak).not.toBeNull();
    expect(r.session?.groups['knowledge-update']?.staleLeak).not.toBeNull();
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
    vi.stubEnv('VOYAGE_API_KEY', 'not-a-key');
    const net = noNetwork();
    const out = quiet();
    const code = await publicMain(
      args({ file: SAMPLE_LME, unpinned: true, embed: 'voyage', rerank: 'voyage' }),
      () => {},
    );
    expect(code).toBe(2);
    expect(out.join('')).toContain('Nothing was sent');
    expect(net).not.toHaveBeenCalled();
  });

  it('plan.checks---k', async () => {
    noNetwork();
    quiet();
    await expect(
      publicMain(args({ file: SAMPLE_LME, unpinned: true, plan: true, k: '0' }), () => {}),
    ).rejects.toThrow(/--k/);
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
