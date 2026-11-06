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
  // acknowledge. Compared after NFKC and lowercasing, without punctuation, symbols or spaces.
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
  'ok thanks',
  'ok thank you',
  // Multi-word replies in the gating languages (compared without punctuation or spaces)
  'はい、お願いします',
  'はい、ありがとうございます',
  'ありがとうございました',
  'よろしくお願いします',
  'わかりました',
  '大丈夫です',
  'いいですね',
  '好的，谢谢',
  '好的，谢谢你',
  '好的，继续',
  '好的，没问题',
  '收到，谢谢',
  '明白了',
  '知道了',
  '行，继续吧',
  '네, 감사합니다',
  '네, 알겠습니다',
  '알겠습니다, 감사합니다',
  '고맙습니다',
  'どうもありがとう',
];

/** A reply as compared: NFKC, lowercase, without punctuation, symbols or spaces. */
const compact = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, '');

const ACKS = new Set(ACKNOWLEDGMENTS.map(compact));

/** An acknowledgement, or one said several times over (`嗯嗯嗯…`, `好的好的…`, `ok ok ok`). */
function isAcknowledgment(c: string): boolean {
  if (ACKS.has(c)) return true;
  // Short replies only: the repetition test is quadratic, and a long prompt is never just this.
  if (c.length > 64) return false;
  const repeated = /^(.+?)\1+$/u.exec(c);
  return repeated !== null && ACKS.has(repeated[1] as string);
}

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
  // Punctuation and spacing anywhere do not matter: `はい、お願いします` and `ok, thank you!`.
  if (isAcknowledgment(compact(p))) return { recall: false, reason: 'acknowledgment' };
  return { recall: true, reason: 'ok' };
}
