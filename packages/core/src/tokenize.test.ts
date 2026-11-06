import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryStore,
  informativeTokens,
  LEXICAL_VERSION,
  localScope,
  queryCoverage,
  tokenizeLexical,
  tokenizeLexicalV1,
  tokenizerForVersion,
} from './index.js';
import { makeMemory, TG, vec } from './store-conformance.js';

describe('tokenizeLexical', () => {
  it('tokenize.keeps-joiners-inside-and-trims-ends', () => {
    expect(tokenizeLexical('Route via auth-service-8080, port 8080. See node.js_v2!')).toEqual([
      'route',
      'via',
      'auth-service-8080',
      'port',
      '8080',
      'see',
      'node.js_v2',
    ]);
  });

  it('tokenize.drops-operators-and-quotes', () => {
    expect(tokenizeLexical('"foo" OR bar* a"b --- ((')).toEqual(['foo', 'or', 'bar', 'a', 'b']);
    expect(tokenizeLexical('')).toEqual([]);
  });
});

describe('tokenizeLexical v2 (CON-110)', () => {
  const t = (s: string) => tokenizeLexical(s).join(' ');

  it('tokenize.v2-design-examples', () => {
    expect(t('The auth-service listens on port 8080.')).toBe(
      'the auth-service listens on port 8080',
    );
    expect(t('认证服务使用端口8080')).toBe('认证 证服 服务 务使 使用 用端 端口 8080');
    expect(t('认证服务用什么端口')).toBe('认证 证服 服务 务用 用什 什么 么端 端口');
    expect(t('認証サービスはポート8080を使います')).toBe(
      '認証 証サ サー ービ ビス スは はポ ポー ート 8080 を使 使い いま ます',
    );
    expect(t('인증 서비스는 포트 8080을')).toBe('인증 서비 비스 스는 포트 8080 을');
    expect(t('บริการยืนยันตัวตนใช้พอร์ต 8080')).toBe('บริการ ยืนยัน ตัว ตน ใช้ พอร์ต 8080');
    expect(t('प्रमाणीकरण सेवा पोर्ट 8080 का उपयोग करती है')).toBe(
      'प्रमाणीकरण सेवा पोर्ट 8080 का उपयोग करती है',
    );
  });

  it('tokenize.v2-normalises-and-folds-latin-only', () => {
    expect(t('ＡＰＩ ｖ２')).toBe('api v2');
    expect(t('El servicio de autenticación')).toBe('el servicio de autenticacion');
    // Decomposed input (e + combining acute) folds the same way.
    expect(t('autenticación')).toBe('autenticacion');
    expect(t('naïve Straße ąčę ø')).toBe('naive straße ace ø');
    // Marks in other scripts are vowels and stay.
    expect(t('हिंदी')).toBe('हिंदी');
    expect(t('Привет, мир')).toBe('привет мир');
  });

  it('tokenize.v2-separates-identifiers-from-cjk', () => {
    expect(tokenizeLexical('checkout-webはポート4173')).toEqual([
      'checkout-web',
      'はポ',
      'ポー',
      'ート',
      '4173',
    ]);
    // A joiner between CJK runs is a boundary, not part of a token.
    expect(tokenizeLexical('認証-サービス')).toEqual(['認証', 'サー', 'ービ', 'ビス']);
    // One CJK character is a unigram; the prolonged sound mark counts as CJK.
    expect(tokenizeLexical('を')).toEqual(['を']);
    expect(tokenizeLexical('ー')).toEqual(['ー']);
  });

  it('tokenize.v1-is-kept-for-old-indexes', () => {
    expect(tokenizeLexicalV1('认证服务使用端口8080')).toEqual(['认证服务使用端口8080']);
    expect(tokenizeLexicalV1('हिंदी')).toEqual(['ह', 'द']);
    expect(tokenizerForVersion(1)).toBe(tokenizeLexicalV1);
    expect(tokenizerForVersion(2)).toBe(tokenizeLexical);
    expect(LEXICAL_VERSION).toBe(2);
  });

  it('tokenize.v2-equals-v1-without-marks-cjk-sea-or-accents', () => {
    // The invariant (design §5.1): for NFKC-stable text with no combining marks, no CJK or
    // Southeast Asian script and no accented Latin, v2 gives v1's tokens. Random strings over
    // ASCII, Cyrillic, Greek, Arabic letters, digits, joiners and punctuation, from a fixed seed.
    const alphabet = [
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      ...'-_.-_. ,;:!?()[]{}"\'/\\@#$%^&*+=<>|~`\n\t',
      ...'привет мир ΑΒΓαβγ قاعدة',
      '€',
      '’',
      '“',
      '😀',
      // Emoji with variation selectors, keycaps and ZWJ sequences, and leaders (CON-110 review).
      '⚠️',
      '❤️',
      '✔️',
      '⚙️',
      '1️⃣',
      '#️⃣',
      '👍🏽',
      '👩‍💻',
      '👨‍👩‍👧',
      '🏳️‍🌈',
      '…',
      '‥',
    ];
    let seed = 0x2545f491;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let i = 0; i < 2000; i++) {
      const len = 1 + Math.floor(next() * 60);
      let s = '';
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(next() * alphabet.length)];
      expect(tokenizeLexical(s), JSON.stringify(s)).toEqual(tokenizeLexicalV1(s));
    }
  });

  it('tokenize.v2-emoji-and-leaders-tokenise-as-v1', () => {
    for (const s of [
      '⚠️ fix the deploy',
      'done ✔️',
      '❤️ it',
      '⚙️config',
      'step 1️⃣ then 2️⃣',
      'a1️⃣b',
      'pair 👩‍💻 on it',
      'family 👨‍👩‍👧 photo',
      'wait…then retry',
      'wait…',
      'v1‥v2',
      '\u0301orphan mark',
      'x \u20e3 y',
    ]) {
      expect(tokenizeLexical(s), JSON.stringify(s)).toEqual(tokenizeLexicalV1(s));
    }
    expect(tokenizeLexical('wait…then')).toEqual(['wait', 'then']);
    expect(tokenizeLexical('⚠️')).toEqual([]);
  });

  it('tokenize.v2-documented-nfkc-folds', () => {
    // Deliberate: NFKC folds compatibility forms to what they stand for.
    expect(tokenizeLexical('ＡＰＩ ｖ２')).toEqual(['api', 'v2']); // full-width ASCII
    expect(tokenizeLexical('½ cup')).toEqual(['1', '2', 'cup']); // v1: ['½', 'cup']
    expect(tokenizeLexical('x² m³')).toEqual(['x2', 'm3']); // v1: ['x²', 'm³']
    expect(tokenizeLexical('Oort™ API')).toEqual(['oorttm', 'api']); // v1: ['oort', 'api']
    expect(tokenizeLexical('ﬁle')).toEqual(['file']); // ligature; v1: ['ﬁle']
    // A variation selector on a letter is dropped, not a split (ideographic variants).
    expect(tokenizeLexical('葛\ufe00城')).toEqual(tokenizeLexical('葛城'));
    // A zero-width joiner inside a word joins it (Indic conjuncts); elsewhere it separates.
    expect(tokenizeLexical('क्\u200dष')).toEqual(tokenizeLexical('क्ष'));
  });

  it('tokenize.v2-falls-back-to-bigrams-without-segmenter', async () => {
    const real = Intl.Segmenter;
    vi.resetModules();
    try {
      (Intl as { Segmenter?: unknown }).Segmenter = undefined;
      const fresh = await import('./tokenize.js');
      // Base characters with their marks, in overlapping pairs.
      expect(fresh.tokenizeLexical('ใช้พอร์ต')).toEqual(['ใช้', 'ช้พ', 'พอ', 'อร์', 'ร์ต']);
    } finally {
      (Intl as { Segmenter?: unknown }).Segmenter = real;
      vi.resetModules();
    }
  });
});

describe('tokeniser v2 consumers (CON-110)', () => {
  const mem = (id: string, text: string) =>
    makeMemory({ id, text, stub: text, entities: [], embedding: vec(1, 0, 0, 0) });

  it('tokenize.v2-word-coverage-works-for-cjk-and-thai', () => {
    // The relevance gate and the lexical-first skip measure coverage over these tokens.
    const zh = mem('zh', '认证服务使用端口8080');
    expect(queryCoverage(informativeTokens('认证服务用什么端口'), zh)).toBe(0.5);
    const th = mem('th', 'บริการยืนยันตัวตนใช้พอร์ต 8080');
    expect(queryCoverage(informativeTokens('บริการยืนยันตัวตนใช้พอร์ตอะไร'), th)).toBeGreaterThan(
      0.8,
    );
    // A CJK run is one word: the question's own wording does not outweigh the identifier.
    const port = mem(
      'port',
      '本地开发时 checkout-web 跑在 4173 端口，API 请求会代理到 8081 端口的后端。',
    );
    const q = informativeTokens('本地要看 checkout-web 得打开哪个端口？');
    // Words: 本地要看 (1 of 3 bigrams), checkout-web, checkout, web, 得打开哪个端口 (1 of 6).
    expect(queryCoverage(q, port)).toBeCloseTo((1 / 3 + 3 + 1 / 6) / 5, 10);
    expect(queryCoverage(q, port)).toBeGreaterThanOrEqual(0.5);
    // English coverage is what it was.
    const en = mem('en', 'auth-service listens on port 8080');
    expect(queryCoverage(informativeTokens('which port does auth-service use'), en)).toBe(1);
  });

  it('tokenize.v2-in-memory-store-finds-cjk', async () => {
    const store = createMemoryStore();
    const g = TG;
    await store.upsertMany(g, [
      { ...mem('zh', '认证服务使用端口8080'), scope: localScope() },
      { ...mem('ja', '認証サービスはポート8080を使います'), scope: localScope() },
      { ...mem('en', 'billing webhooks retry three times'), scope: localScope() },
    ]);
    expect((await store.lexical(g, '认证 端口', 10)).map((h) => h.id)).toEqual(['zh']);
    expect((await store.lexical(g, 'ポート', 10)).map((h) => h.id)).toEqual(['ja']);
  });
});

describe('tokenizeLexical cost (CON-110 review)', () => {
  it('tokenize.joiner-runs-are-linear', () => {
    // A trimming regex took 2.5 s for 40,000 dashes (quadratic); trimming is linear now.
    // The slow case: a long run of joiners inside a word, so a trailing-joiner match fails late.
    const inner = `a${'-'.repeat(100_000)}b`;
    const text = `--${inner}.. ${'_'.repeat(100_000)}c${'.'.repeat(100_000)}`;
    const t0 = performance.now();
    const v2 = tokenizeLexical(text);
    const v1 = tokenizeLexicalV1(text);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(v2).toEqual([inner, 'c']);
    expect(v1).toEqual([inner, 'c']);
  });
});
