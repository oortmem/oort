import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { MemoryWriter, Observation } from '@oortmem/core';
import { compareRuns, renderComparison } from './compare.js';
import { writerEntities } from './entities.js';
import { outputPaths, parseQuestionResults, type QuestionResult } from './per-question.js';
import { cacheFileName, publicMain, writerPromptVersion, type PublicArgs } from './public-main.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-hardening-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const SAMPLE_LME = fileURLToPath(
  new URL('../eval/public/longmemeval-sample.json', import.meta.url),
);
const obs = (userText: string): Observation => ({
  userText,
  assistantText: '',
  toolSummaries: [],
  sessionId: 's',
  turnRef: 's#0',
  at: '2024-01-01T00:00:00.000Z',
});
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = (over: Partial<PublicArgs>): PublicArgs => ({
  set: 'longmemeval',
  file: SAMPLE_LME,
  unpinned: true,
  fetch: false,
  plan: true,
  yes: false,
  embed: 'none',
  rerank: 'none',
  links: 'off',
  noGate: false,
  k: '5,10',
  json: false,
  ...over,
});
const quiet = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

describe('entity prefetch stops at the failure cap', () => {
  it('entities.no-call-starts-after-the-cap-trips-and-nothing-writes-after-close', async () => {
    let started = 0;
    let settled = 0;
    // Every other call fails, each after a short wait, so several are in flight at once.
    const writer: MemoryWriter = {
      async write() {
        const n = ++started;
        await tick(5);
        settled++;
        if (n % 2 === 0) throw new Error('flaky');
        return { text: '', stub: '', entities: ['Kim'], type: 'episodic' };
      },
    };
    const file = path.join(root, 'cap.sqlite');
    const src = writerEntities(writer, { model: 'm', file, concurrency: 4, maxFailures: () => 1 });
    const todo = Array.from({ length: 40 }, (_, i) => obs(`turn ${i}`));
    await expect(src.prefetch(todo)).rejects.toThrow(/writer calls failed, stopping/);
    // Every call that started has finished before the error came out: nothing is in flight.
    expect(settled).toBe(started);
    // The cap tripped on the second failure (the fourth call); at most the other three workers'
    // calls were already in flight then.
    expect(started).toBeLessThanOrEqual(4 + 3);
    const after = started;
    src.close();
    await tick(30);
    expect(started).toBe(after);
    // The successful answers were kept, none lost to a closed database.
    const db = new Database(file, { readonly: true });
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM e').get() as { n: number }).n;
    db.close();
    expect(rows).toBe(src.usage().calls - src.usage().failed);
  });
});

describe('entity cache key and values', () => {
  const counting = () => {
    const calls: string[] = [];
    const w: MemoryWriter = {
      async write(o) {
        calls.push(o.userText);
        return { text: '', stub: '', entities: ['Ada'], type: 'episodic' };
      },
    };
    return { w, calls };
  };

  it('entities.another-writer-prompt-version-is-a-miss', async () => {
    const file = path.join(root, 'ver.sqlite');
    const { w, calls } = counting();
    const a = writerEntities(w, { model: 'm', version: 'v1', file });
    await a.source(obs('Ada wrote'));
    a.close();
    const b = writerEntities(w, { model: 'm', version: 'v2', file });
    expect(b.has('Ada wrote\n')).toBe(false);
    await b.source(obs('Ada wrote'));
    expect(calls).toHaveLength(2);
    b.close();
    // The version public-main uses follows the writer's prompts, and is stable.
    expect(writerPromptVersion()).toMatch(/^[0-9a-f]{16}$/);
    expect(writerPromptVersion()).toBe(writerPromptVersion());
  });

  it('entities.a-cached-value-that-is-not-a-list-of-strings-is-a-miss', async () => {
    const file = path.join(root, 'bad.sqlite');
    const { w, calls } = counting();
    const a = writerEntities(w, { model: 'm', file });
    await a.source(obs('Ada wrote'));
    a.close();
    const db = new Database(file);
    for (const bad of ['{"a":1}', '[1,2]', 'not json', '"Ada"']) {
      db.prepare('UPDATE e SET v = ?').run(bad);
      const b = writerEntities(w, { model: 'm', file });
      expect(b.has('Ada wrote\n')).toBe(false);
      expect(await b.source(obs('Ada wrote'))).toEqual(['Ada']);
      b.close();
    }
    db.close();
    expect(calls).toHaveLength(5);
  });
});

describe('cache file names', () => {
  it('cache.model-names-never-leave-the-cache-dir', () => {
    expect(cacheFileName('voyage-3.5-lite')).toBe('voyage-3.5-lite');
    expect(cacheFileName('../../x')).toBe('.._.._x');
    expect(cacheFileName('a/b\\c d')).toBe('a_b_c_d');
    expect(() => cacheFileName('')).toThrow(/empty model name/);
  });

  it('cache.writer-and-embedding-files-stay-inside-and-an-empty-model-is-refused', async () => {
    quiet();
    vi.stubEnv('VOYAGE_API_KEY', 'not-a-key');
    vi.stubGlobal('fetch', () => {
      throw new Error('the network was called');
    });
    const cacheDir = path.join(root, 'cache');
    await publicMain(args({ cacheDir, entities: 'writer:../../escape' }), () => {});
    await publicMain(args({ cacheDir, embed: 'voyage:../../escape' }), () => {});
    expect(fs.readdirSync(path.join(cacheDir, 'entities'))).toEqual(['.._.._escape.sqlite']);
    expect(fs.readdirSync(path.join(cacheDir, 'embeddings'))).toEqual(['.._.._escape-512.sqlite']);
    expect(fs.existsSync(path.join(root, 'escape.sqlite'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'escape-512.sqlite'))).toBe(false);
    for (const bad of [{ entities: 'writer:' }, { embed: 'voyage:' }, { rerank: 'voyage:' }]) {
      await expect(publicMain(args({ cacheDir, ...bad }), () => {})).rejects.toThrow(
        /empty model name/,
      );
    }
  });
});

describe('per-question files', () => {
  it('per-question.an-infinite-metric-is-refused', () => {
    const line = (v: string) =>
      `{"run":"r","level":"turn","id":"1","group":"g","question":"q","ranks":[1],"metrics":{"mrr":${v}}}`;
    expect(parseQuestionResults(line('0.5'))).toHaveLength(1);
    expect(() => parseQuestionResults(line('1e999'))).toThrow(/metrics must map names to numbers/);
    expect(() => parseQuestionResults(line('-1e999'))).toThrow(/metrics/);
  });

  it('per-question.out-and-questions-must-differ', async () => {
    const out = path.join(root, 'r.json');
    expect(outputPaths(out, undefined)).toEqual({
      out,
      questions: path.join(root, 'r.questions.jsonl'),
    });
    expect(outputPaths(undefined, undefined)).toEqual({});
    expect(() => outputPaths(out, path.join(root, '.', 'r.json'))).toThrow(
      /--out and --questions name the same file/,
    );
    quiet();
    await expect(
      publicMain(args({ plan: false, cacheDir: root, out, questions: out }), () => {}),
    ).rejects.toThrow(/--out and --questions name the same file/);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('compare output', () => {
  it('compare.control-characters-are-stripped-and-pipes-escaped', () => {
    const q = (run: string): QuestionResult => ({
      run,
      level: 'tu\u0007rn',
      id: '1',
      group: 'a|b\u001b[31m',
      question: 'q',
      ranks: [1],
      returned: 1,
      aboveThreshold: 1,
      linked: 0,
      linkedExpected: 0,
      metrics: { mrr: 1 },
    });
    const text = renderComparison(
      compareRuns([q('links=off\r\nX')], [q('links=all|y')], { resamples: 10 }),
    );
    // oxlint-disable-next-line no-control-regex -- matching control characters is the point
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(text).toContain('| a\\|b[31m | mrr |');
    expect(text).toContain('A: links=offX');
    expect(text).toContain('B: links=all\\|y');
    expect(text).toContain('Level: turn.');
  });
});
