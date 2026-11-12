import { describe, expect, it } from 'vitest';
import type { Reranker } from '@oortmem/core';
import { fakeEmbedder } from './fake-embed.js';
import {
  chooseCheaper,
  chooseFloors,
  foldOf,
  heldOut,
  judge,
  measure,
  OFF,
  perLanguage,
  recordGateMiss,
  replay,
  rerankLatency,
  type GateMissRecord,
} from './gate-miss.js';
import { LANGUAGES, unrelatedRows } from './multilingual.js';

const row = (category: string, expected: string[] = []) => ({
  question: 'q',
  expectedMemoryIds: expected,
  category: category as 'single-fact',
});

/** A cross row the gate dropped, its expected memory scoring `score` on rerank. */
const crossMiss = (lang: 'es' | 'de', topDense: number, score: number): GateMissRecord => ({
  lang,
  condition: 'cross',
  unrelated: false,
  row: row('single-fact', ['en-f01']),
  ids: [],
  gateMiss: { topDense, scored: [{ id: 'en-f01', score }], rerankMs: 200 },
});
/** An abstention (or unrelated) row the gate dropped, its best wrong memory scoring `score`. */
const negMiss = (
  lang: 'en' | 'es' | 'de',
  condition: 'mono' | 'cross',
  topDense: number,
  score: number,
  unrelated = false,
): GateMissRecord => ({
  lang,
  condition,
  unrelated,
  row: row('abstention'),
  ids: [],
  gateMiss: { topDense, scored: [{ id: 'x', score }], rerankMs: 300 },
});
const monoHit = (lang: 'en' | 'es' | 'de'): GateMissRecord => ({
  lang,
  condition: 'mono',
  unrelated: false,
  row: row('single-fact', [`${lang}-f01`]),
  ids: [`${lang}-f01`],
});

const RECORDS: GateMissRecord[] = [
  monoHit('en'),
  monoHit('es'),
  monoHit('de'),
  negMiss('en', 'mono', 0.3, 0.2),
  crossMiss('es', 0.55, 0.8),
  crossMiss('de', 0.42, 0.6),
  negMiss('es', 'cross', 0.5, 0.55),
  negMiss('de', 'cross', 0.35, 0.9, true),
];
const BARS = { crossShare: 0.75, abstainSlack: 0.1, languages: ['es', 'de'] as const };

describe('gate-miss calibration (CON-131)', () => {
  it('replays a row at any floors without another model call', () => {
    const r = crossMiss('es', 0.55, 0.8);
    expect(replay(r, OFF)).toEqual({ ids: [], reranked: false });
    expect(replay(r, { dense: 0.6, rerank: 0.5 })).toEqual({ ids: [], reranked: false });
    expect(replay(r, { dense: 0.5, rerank: 0.5 })).toEqual({ ids: ['en-f01'], reranked: true });
    // Reranked, but under the rerank floor: paid for, nothing returned.
    expect(replay(r, { dense: 0.5, rerank: 0.85 })).toEqual({ ids: [], reranked: true });
    // A row the gate answered is the same at every floor.
    expect(replay(monoHit('es'), { dense: 0, rerank: 0 }).ids).toEqual(['es-f01']);
  });

  it('measures recall, abstention, unrelated prompts and the rerank rate per cell', () => {
    const at = measure(RECORDS, { dense: 0.4, rerank: 0.5 });
    const es = at.find((m) => m.lang === 'es' && m.condition === 'cross');
    expect(es).toMatchObject({ recall10: 1, abstainFp: 1, rows: 2, rerankRate: 1 });
    const de = at.find((m) => m.lang === 'de' && m.condition === 'cross');
    expect(de).toMatchObject({ recall10: 1, unrelatedFp: 0, rerankRate: 0.5 });
  });

  it('judges floors against the bars: cross share, abstention slack, no new false injection', () => {
    const loose = judge(RECORDS, { dense: 0.3, rerank: 0.5 }, BARS);
    expect(loose.passes).toBe(false);
    expect(loose.failures.join('\n')).toMatch(/es cross abstention FP/);
    expect(loose.failures.join('\n')).toMatch(/unrelated prompts injected 0 → 1/);
    const tight = judge(RECORDS, { dense: 0.4, rerank: 0.6 }, BARS);
    expect(tight).toMatchObject({ passes: true, crossMacro: 1, unrelatedInjected: 0 });
    expect(judge(RECORDS, OFF, BARS).failures.join('\n')).toMatch(/es cross recall@10 0.000/);
  });

  it('fails floors that newly answer an abstention question, whatever the FP slack', () => {
    // A slack this loose lets any abstention FP through: the count must still not rise.
    const lax = { ...BARS, abstainSlack: 1 };
    const v = judge(RECORDS, { dense: 0.4, rerank: 0.5 }, lax);
    expect(v.passes).toBe(false);
    expect(v.failures.join('\n')).toMatch(/abstention questions answered 0 → 1/);
    expect(judge(RECORDS, { dense: 0.4, rerank: 0.6 }, lax).passes).toBe(true);
  });

  it('chooses the best cross recall that meets the bars, then the stricter floors', () => {
    const v = chooseFloors(RECORDS, [0.3, 0.4, 0.5], [0.5, 0.6, 0.7], BARS);
    // 0.6 keeps es (0.8) and de (0.6) and drops the es abstention (0.55); 0.7 would lose de.
    expect(v?.floors).toEqual({ dense: 0.4, rerank: 0.6 });
    expect(v?.passes).toBe(true);
    expect(chooseFloors(RECORDS, [0.6], [0.5], BARS)).toBeUndefined();
  });

  it('trades a stated slack of cross recall for a higher dense floor (fewer rerank calls)', () => {
    // Four es cross rows; only a low dense floor (0.36) reaches the fourth.
    const records = [
      ...RECORDS,
      crossMiss('es', 0.55, 0.8),
      crossMiss('es', 0.55, 0.8),
      crossMiss('es', 0.37, 0.8),
    ];
    const D = [0.36, 0.4, 0.5];
    const R = [0.5, 0.6, 0.7];
    const strict = chooseCheaper(records, 0, D, R, BARS);
    expect(strict?.chosen.floors).toEqual({ dense: 0.36, rerank: 0.6 });
    const cheaper = chooseCheaper(records, 0.2, D, R, BARS);
    expect(cheaper?.best.floors).toEqual({ dense: 0.36, rerank: 0.6 });
    // 0.4 loses the low es row (macro 1 to 0.875, within 0.2); 0.5 loses de (0.42): bars fail.
    expect(cheaper?.chosen.floors).toEqual({ dense: 0.4, rerank: 0.6 });
    expect(cheaper?.chosen.crossMacro).toBeCloseTo(0.875, 3);
  });

  it('reports what each language alone would pick, and the latency the floors pay for', () => {
    const per = perLanguage(RECORDS, [0.3, 0.4, 0.5], [0.5, 0.6, 0.7]);
    expect(per.find((p) => p.lang === 'es')).toMatchObject({ cross: 1 });
    expect(per.find((p) => p.lang === 'es')?.floors?.rerank).toBeGreaterThan(0.55);
    expect(rerankLatency(RECORDS, { dense: 0.4, rerank: 0.6 })).toEqual({
      calls: 3,
      p50: 200,
      p95: 300,
    });
  });

  it('holds out whole questions: each fold is judged at floors chosen without it', () => {
    // Two questions, each asked in two languages: a fold never sees its own question's translations.
    const recs: GateMissRecord[] = [
      { ...crossMiss('es', 0.55, 0.8), item: 'q1' },
      { ...crossMiss('de', 0.55, 0.8), item: 'q1' },
      { ...crossMiss('es', 0.45, 0.7), item: 'q2' },
      { ...crossMiss('de', 0.45, 0.7), item: 'q2' },
    ];
    const seen: string[][] = [];
    const h = heldOut(recs, 2, (train) => {
      seen.push([...new Set(train.map((r) => r.item as string))]);
      // Floors that answer exactly the training fold's question.
      return train[0]?.item === 'q1' ? { dense: 0.5, rerank: 0.75 } : { dense: 0.4, rerank: 0.65 };
    });
    expect(seen.map((s) => s.length)).toEqual([1, 1]);
    expect(seen.flat().sort()).toEqual(['q1', 'q2']);
    // q2 judged at q1's floors (dense 0.5 > 0.45: missed); q1 at q2's (0.4, 0.65: answered).
    const es = h.cells.find((c) => c.lang === 'es' && c.condition === 'cross');
    expect(es?.recall10).toBeCloseTo(0.5);
    expect(h.folds).toHaveLength(2);
    expect(h.folds.map((f) => f.items).sort()).toEqual([1, 1]);
  });

  it('splits by item deterministically, and keeps an item in one fold', () => {
    const items = Array.from({ length: 40 }, (_, i) => `q${i}`);
    const folds = items.map((i) => foldOf(i, 5));
    expect(items.map((i) => foldOf(i, 5))).toEqual(folds);
    for (let f = 0; f < 5; f++) expect(folds.filter((x) => x === f).length).toBeGreaterThan(2);
  });

  it('records a real run: rows the gate answers are untouched, misses carry scores', async () => {
    const calls: number[] = [];
    // Scores every candidate 0.5, so the recording keeps them all.
    const rerank: Reranker = {
      rerank: async (_q, docs, topK) => {
        calls.push(docs.length);
        return docs.slice(0, topK).map((d) => ({ id: d.id, score: 0.5 }));
      },
    };
    const unrelated = unrelatedRows();
    const records = await recordGateMiss({
      languages: ['en', 'de'],
      conditions: ['mono', 'cross'],
      embed: fakeEmbedder(),
      rerank,
      extraRows: unrelated,
    });
    // 34 rows per language and condition, plus 5 unrelated prompts each (no English cross).
    expect(records.length).toBe((34 + 5) * 3);
    expect(records.filter((r) => r.unrelated).length).toBe(15);
    const misses = records.filter((r) => r.gateMiss?.scored.length);
    expect(misses.length).toBe(calls.length);
    for (const m of misses) for (const s of m.gateMiss?.scored ?? []) expect(s.score).toBe(0.5);
    // Every question is one held-out item across languages and conditions; prompts are their own.
    const items = new Map<string, Set<string>>();
    for (const r of records) {
      const set = items.get(r.item as string) ?? new Set<string>();
      set.add(`${r.lang}/${r.condition}`);
      items.set(r.item as string, set);
    }
    expect(items.size).toBe(34 + 5 * 2);
    // A question in en/mono, de/mono, de/cross; a prompt in its own language's conditions.
    for (const [item, where] of items) {
      expect(where.size).toBe(item.startsWith('q:') ? 3 : item.startsWith('u:en:') ? 1 : 2);
    }
    // Without the escalation the recording replays the plain fast-mode result.
    const off = measure(records, OFF).find((m) => m.lang === 'de' && m.condition === 'cross');
    expect(off?.rerankRate).toBe(0);
  });

  it('has five unrelated prompts in every language, none a translation of another', () => {
    const u = unrelatedRows();
    for (const lang of LANGUAGES) expect(u.get(lang)?.length).toBe(5);
    const all = [...u.values()].flat().map((r) => r.question);
    expect(new Set(all).size).toBe(65);
  });
});
