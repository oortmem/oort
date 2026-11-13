/**
 * LoCoMo (`locomo10.json`, CON-147): 10 long conversations between two people over up to 35
 * sessions, with about 2,000 questions whose `evidence` names the dialogue turns (`D3:7`) that
 * answer them. One haystack per conversation: every turn observed with its session's date as
 * `at` and its dialogue id as `turnRef`; every question scored by recall@k of its evidence turns.
 *
 * Categories are numbers in the file. This adapter uses the mapping most published retrieval
 * results use (and the per-category question counts confirm): 1 multi-hop, 2 temporal, 3
 * open-domain, 4 single-hop, 5 adversarial. The LoCoMo paper's own tables name them in another
 * order, which is one reason published LoCoMo numbers do not compare.
 */
import type { Haystack, PublicSet, Question, Turn } from './public-sets.js';

export const LOCOMO_CATEGORIES: Record<number, string> = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
  5: 'adversarial',
};
export const LOCOMO_GROUPS = ['single-hop', 'multi-hop', 'temporal', 'open-domain', 'adversarial'];

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** `1:56 pm on 8 May, 2023` as an ISO time (the file has no zone: read as UTC). */
export function parseLocomoDate(s: string): string {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([a-z]+),?\s+(\d{4})\s*$/i.exec(s);
  const month = MONTHS.indexOf((m?.[5] ?? '').toLowerCase());
  if (m === null || month < 0) throw new Error(`LoCoMo: unreadable session date "${s}"`);
  const hour = (Number(m[1]) % 12) + (m[3]?.toLowerCase() === 'pm' ? 12 : 0);
  return new Date(Date.UTC(Number(m[6]), month, Number(m[4]), hour, Number(m[2]))).toISOString();
}

/** A dialogue id in one spelling: `D30:05` and `D30:5` name the same turn. */
export function diaId(id: string): string {
  const m = /^D(\d+):(\d+)$/.exec(id);
  return m === null ? id : `D${Number(m[1])}:${Number(m[2])}`;
}

/**
 * Evidence ids as written, cleaned of the file's few typos: several ids in one string
 * (`D8:6; D9:17`), a stray colon (`D:11:26`), a leading zero (`D30:05`). Anything else
 * unreadable is dropped.
 */
export function evidenceIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((e) => (typeof e === 'string' ? e.split(/[;,\s]+/) : []))
    .map((e) => e.replace(/^D:(\d+:\d+)$/, 'D$1'))
    .filter((e) => /^D\d+:\d+$/.test(e))
    .map(diaId);
}

interface RawTurn {
  speaker: string;
  dia_id: string;
  text: string;
  blip_caption?: string;
}

/** A turn's words: the speaker's name and text, and the caption of an image they shared. */
const turnWords = (t: RawTurn): string =>
  `${t.speaker}: ${t.text}${t.blip_caption !== undefined ? ` [shares an image: ${t.blip_caption}]` : ''}`;

export function loadLocomo(json: unknown): PublicSet {
  if (!Array.isArray(json)) throw new Error('LoCoMo: expected a JSON array of conversations');
  let droppedEvidence = 0;
  let droppedQuestions = 0;
  const haystacks: Haystack[] = [];
  for (const sample of json as Record<string, unknown>[]) {
    const id = String(sample['sample_id']);
    const conv = sample['conversation'] as Record<string, unknown>;
    const turns: Turn[] = [];
    let last = 0;
    for (let s = 1; Array.isArray(conv[`session_${s}`]); s++) {
      const start = Date.parse(parseLocomoDate(String(conv[`session_${s}_date_time`])));
      for (const [i, t] of (conv[`session_${s}`] as RawTurn[]).entries()) {
        // One second apart, so turn order survives as time order.
        const at = start + i * 1000;
        last = Math.max(last, at);
        turns.push({
          turnRef: diaId(t.dia_id),
          sessionId: `${id}:session_${s}`,
          at: new Date(at).toISOString(),
          userText: turnWords(t),
          assistantText: '',
        });
      }
    }
    const known = new Set(turns.map((t) => t.turnRef));
    const questions: Question[] = [];
    for (const [i, q] of ((sample['qa'] as Record<string, unknown>[]) ?? []).entries()) {
      const ids = evidenceIds(q['evidence']);
      const evidence = [...new Set(ids.filter((e) => known.has(e)))];
      droppedEvidence += ids.length - ids.filter((e) => known.has(e)).length;
      const group = LOCOMO_CATEGORIES[Number(q['category'])] ?? 'uncategorized';
      if (evidence.length === 0) {
        droppedQuestions++;
        continue;
      }
      questions.push({ id: `${id}:q${i}`, question: String(q['question']), group, evidence });
    }
    // Recall reads "now" as one day after the last session.
    haystacks.push({ id, now: new Date(last + 86_400_000).toISOString(), turns, questions });
  }
  return { name: 'locomo', haystacks, groups: LOCOMO_GROUPS, droppedEvidence, droppedQuestions };
}
