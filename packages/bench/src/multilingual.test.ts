/**
 * The multilingual eval set (CON-110): the files are consistent, and the lexical-only run, which
 * is deterministic, matches `eval/multilingual/baseline-lexical.json`. A tokeniser change shows up
 * here as a changed number. `OORT_UPDATE_GOLDEN=1` rewrites the baseline; do that only for an
 * intended change, and update the README's tables with it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEvalRows } from './eval.js';
import {
  factOf,
  GATING,
  LANGUAGES,
  languageOf,
  loadMultilingualSet,
  memoriesFor,
  MULTILINGUAL_DIR,
  runMultilingual,
  TRACKED,
  type MultilingualReport,
} from './multilingual.js';

const BASELINE = path.join(MULTILINGUAL_DIR, 'baseline-lexical.json');

/** Recall@5, recall@10, MRR, stale leaks and abstention false positives, to three decimals. */
function summary(report: MultilingualReport): Record<string, Record<string, number | null>> {
  const r3 = (n: number | null | undefined): number | null =>
    n === null || n === undefined ? null : Number(n.toFixed(3));
  const out: Record<string, Record<string, number | null>> = {};
  for (const r of report.results) {
    const g = r.report.groups['overall'];
    out[`${r.lang} ${r.condition}`] = {
      rows: g?.rows ?? 0,
      recall5: r3(g?.recallAt[5]),
      recall10: r3(g?.recallAt[10]),
      mrr: r3(g?.mrr),
      staleLeak: r3(g?.staleLeak),
      abstainFp: r3(g?.abstainFp),
      sameLanguageFirst: r3(r.sameLanguageFirst),
    };
  }
  return out;
}

describe('multilingual eval set', () => {
  const set = loadMultilingualSet();

  it('covers English, the six gating and the six tracked languages', () => {
    expect(LANGUAGES).toEqual(['en', ...GATING, ...TRACKED]);
    expect(GATING).toEqual(['es', 'pt-BR', 'de', 'fr', 'ja', 'zh-Hans']);
    expect(TRACKED).toEqual(['ko', 'hi', 'ar', 'th', 'ru', 'id']);
    for (const lang of LANGUAGES) {
      expect(set.corpora.get(lang)?.size).toBe(set.facts.length);
      const rows = set.questions.get(lang) ?? [];
      expect(rows.length).toBe(set.questions.get('en')?.length);
      const categories = new Set(rows.map((r) => r.category));
      for (const c of ['single-fact', 'knowledge-update', 'temporal', 'abstention']) {
        expect(categories.has(c as never)).toBe(true);
      }
    }
  });

  it('asks the same thing in every language, never in English words alone', () => {
    const en = set.questions.get('en') ?? [];
    for (const lang of LANGUAGES.filter((l) => l !== 'en')) {
      (set.questions.get(lang) ?? []).forEach((row, i) => {
        const ref = en[i];
        expect(row.expectedMemoryIds.map(factOf)).toEqual(ref?.expectedMemoryIds.map(factOf));
        expect(row.category).toBe(ref?.category);
        expect(row.asOf).toBe(ref?.asOf);
        expect(row.question).not.toBe(ref?.question);
      });
    }
  });

  it('eval rows carry lang and condition, and reject a bad condition', () => {
    const row = '{"question":"q","expectedMemoryIds":["ja-f01"],"lang":"ja","condition":"cross"}';
    expect(loadEvalRows(row).rows[0]).toMatchObject({ lang: 'ja', condition: 'cross' });
    expect(() => loadEvalRows('{"question":"q","expectedMemoryIds":[],"condition":"x"}')).toThrow(
      /condition must be one of mono, cross, mixed/,
    );
    expect(() => loadEvalRows('{"question":"q","expectedMemoryIds":[],"lang":""}')).toThrow(
      /lang must be a language code/,
    );
  });

  it('parses memory ids, including language codes with a dash', () => {
    expect(factOf('pt-BR-u03a')).toBe('u03a');
    expect(languageOf('pt-BR-u03a')).toBe('pt-BR');
    expect(factOf('zh-Hans-f01')).toBe('f01');
    expect(languageOf('zh-Hans-f01')).toBe('zh-Hans');
    expect(factOf('m7-1008')).toBe('m7-1008');
    expect(languageOf('m7-1008')).toBeUndefined();
  });

  it('chains knowledge updates as the write path leaves them', () => {
    const ms = new Map(memoriesFor(set, 'ja').map((m) => [m.id, m]));
    const old = ms.get('ja-u03a');
    const cur = ms.get('ja-u03b');
    expect(old?.supersededBy).toBe('ja-u03b');
    expect(old?.validTo).toBe(cur?.validFrom);
    expect(old?.endReason).toBe('superseded');
    expect(cur?.supersedes).toBe('ja-u03a');
    expect(cur?.validTo).toBeNull();
  });

  it('lexical-only recall matches the recorded baseline', async () => {
    const got = summary(await runMultilingual({ set }));
    if (process.env['OORT_UPDATE_GOLDEN'] === '1') {
      fs.writeFileSync(BASELINE, `${JSON.stringify(got, null, 2)}\n`);
    }
    const want = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as typeof got;
    expect(got).toEqual(want);
  });
});
