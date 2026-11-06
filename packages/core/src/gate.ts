/** Acknowledgments and fillers that never warrant a memory lookup. */
export const ACKNOWLEDGMENTS: readonly string[] = [
  'ok',
  'okay',
  'yes',
  'yes please',
  'no',
  'thanks',
  'thank you',
  'thx',
  'continue',
  'go ahead',
  'go on',
  'proceed',
  'lgtm',
  'looks good',
  'sounds good',
  'done',
  'next',
  'y',
  'n',
  'k',
  // The gating languages (CON-110, design §10), plus Korean: the common replies that only
  // acknowledge. Compared after NFKC and lowercasing, without trailing punctuation.
  // Spanish
  'gracias',
  'muchas gracias',
  'vale',
  'sí',
  'si',
  'de acuerdo',
  'perfecto',
  'listo',
  'adelante',
  'sigue',
  'continúa',
  'dale',
  // Brazilian Portuguese
  'obrigado',
  'obrigada',
  'muito obrigado',
  'muito obrigada',
  'valeu',
  'beleza',
  'sim',
  'pode seguir',
  'pode continuar',
  'perfeito',
  'certo',
  'combinado',
  // German
  'danke',
  'danke schön',
  'danke dir',
  'vielen dank',
  'ja',
  'nein',
  'passt',
  'weiter',
  'mach weiter',
  'klingt gut',
  'sieht gut aus',
  'alles klar',
  'genau',
  // French
  'merci',
  'merci beaucoup',
  'oui',
  'non',
  "d'accord",
  'parfait',
  'vas-y',
  "c'est bon",
  'ça marche',
  'nickel',
  // Japanese
  'はい',
  'いいえ',
  'うん',
  'ありがとう',
  'ありがとうございます',
  'どうも',
  '了解',
  '了解です',
  '了解しました',
  '承知しました',
  'お願いします',
  '続けて',
  '続けてください',
  'いいね',
  'オッケー',
  // Simplified Chinese
  '好',
  '好的',
  '好吧',
  '谢谢',
  '谢谢你',
  '多谢',
  '行',
  '可以',
  '没问题',
  '继续',
  '收到',
  '嗯',
  '是的',
  '对',
  // Korean
  '네',
  '예',
  '응',
  '감사합니다',
  '고마워요',
  '고마워',
  '좋아요',
  '계속',
  '계속해 주세요',
  '알겠습니다',
  // ok variants
  'okey',
  'oki',
  'okk',
  'okie',
];

const ACKS = new Set(ACKNOWLEDGMENTS);

/** The floor, in width units (`promptWidth`). */
const MIN_LENGTH = 12;

/**
 * East Asian Wide and Fullwidth code points (UAX #11), by the ranges that matter for prompts:
 * Hangul Jamo, CJK radicals to Bopomofo and the Hangul compatibility block, CJK Unified
 * Ideographs (with extension A), Yi, Hangul syllables, CJK compatibility ideographs, vertical
 * and small forms, fullwidth forms, and the supplementary ideographic planes.
 */
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}]/u;

/**
 * A prompt's length for the floor, in width units: a wide (East Asian Wide or Fullwidth) code
 * point counts two, as it takes two columns and carries about a word's meaning, so
 * `認証のポートは？` (8 characters) counts 16. Never less than the UTF-16 length, so text without
 * wide characters measures exactly as before (CON-110).
 */
export function promptWidth(text: string): number {
  let wide = 0;
  for (const ch of text) if (WIDE.test(ch)) wide += ch.length === 1 ? 1 : 0;
  // A BMP wide character is one code unit and counts two; a supplementary one is already two.
  return text.length + wide;
}

export type GateReason = 'slash-command' | 'too-short' | 'acknowledgment' | 'ok';

/** Cheap, synchronous gate: should this prompt trigger a memory recall at all? */
export function shouldRecall(prompt: string): { recall: boolean; reason: GateReason } {
  const p = prompt.trim();
  if (p.startsWith('/')) return { recall: false, reason: 'slash-command' };
  if (promptWidth(p) < MIN_LENGTH) return { recall: false, reason: 'too-short' };
  const norm = p
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\s]+$/u, '');
  if (ACKS.has(norm)) return { recall: false, reason: 'acknowledgment' };
  return { recall: true, reason: 'ok' };
}
