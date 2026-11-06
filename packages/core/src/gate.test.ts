import { describe, expect, it } from 'vitest';
import { ACKNOWLEDGMENTS, promptWidth, shouldRecall } from './gate.js';

describe('gate, multilingual', () => {
  it('gate.wide-characters-count-two', () => {
    // "The auth port?": 8 characters, a full question. Wide characters count two, so 16.
    expect(promptWidth('認証のポートは？')).toBe(16);
    expect(shouldRecall('認証のポートは？')).toEqual({ recall: true, reason: 'ok' });
    expect(shouldRecall('端口是多少？')).toEqual({ recall: true, reason: 'ok' });
    expect(shouldRecall('인증 포트가 뭐예요?')).toEqual({ recall: true, reason: 'ok' });
    // Fullwidth Latin is wide too; halfwidth katakana is not.
    expect(promptWidth('ＡＰＩ')).toBe(6);
    expect(promptWidth('ｱｲｳ')).toBe(3);
    // Supplementary ideographs are two code units already and count two, not four.
    expect(promptWidth('𠀀')).toBe(2);
    // Still too short: two or three wide characters.
    expect(shouldRecall('端口？')).toEqual({ recall: false, reason: 'too-short' });
    expect(shouldRecall('はい')).toEqual({ recall: false, reason: 'too-short' });
  });
  it('gate.english-width-is-unchanged', () => {
    // Without wide characters the width is the UTF-16 length, as the floor measured before.
    for (const p of [
      'ok',
      'yes please',
      'what port did we move auth to?',
      'sounds good!',
      'El servicio usa el puerto 8080',
      'प्रमाणीकरण सेवा',
      'บริการยืนยันตัวตน',
      '👍👍👍',
      'café\r\nok',
    ]) {
      expect(promptWidth(p)).toBe(p.length);
    }
    expect(shouldRecall('short one')).toEqual({ recall: false, reason: 'too-short' });
    expect(shouldRecall('twelve chars')).toEqual({ recall: true, reason: 'ok' });
  });
  it('gate.acknowledgments-in-the-gating-languages', () => {
    for (const ack of [
      'muchas gracias',
      'muito obrigado!',
      'pode continuar',
      'Vielen Dank!',
      'sieht gut aus',
      'merci beaucoup !',
      'ありがとうございます',
      '了解しました。',
      '承知しました！',
      '続けてください',
      '계속해 주세요',
    ]) {
      expect(shouldRecall(ack), ack).toEqual({ recall: false, reason: 'acknowledgment' });
    }
    // Every listed acknowledgement is skipped, by the floor when it is short enough.
    for (const ack of ACKNOWLEDGMENTS) expect(shouldRecall(ack).recall, ack).toBe(false);
    // Fullwidth punctuation and letters are normalised (NFKC) before the comparison.
    expect(shouldRecall('ありがとうございます！！')).toEqual({
      recall: false,
      reason: 'acknowledgment',
    });
    // A real question that starts like an acknowledgement still recalls.
    expect(shouldRecall('gracias, ¿y qué puerto usa auth?')).toEqual({
      recall: true,
      reason: 'ok',
    });
    expect(shouldRecall('はい、認証サービスのポートは？')).toEqual({ recall: true, reason: 'ok' });
    expect(ACKNOWLEDGMENTS).toEqual(expect.arrayContaining(['gracias', 'obrigado', 'merci']));
    expect(ACKNOWLEDGMENTS).toEqual(expect.arrayContaining(['danke', 'はい', 'ありがとう']));
    expect(ACKNOWLEDGMENTS).toEqual(expect.arrayContaining(['好的', '谢谢', '네', '감사합니다']));
  });
});

describe('gate, acknowledgements with punctuation (CON-110 review)', () => {
  it('gate.acknowledgments-ignore-punctuation-and-spacing', () => {
    for (const ack of [
      'はい、お願いします',
      'ありがとうございました',
      'よろしくお願いします',
      '好的，谢谢你！',
      '收到，谢谢！',
      '네, 감사합니다',
      'ＯＫ　ｔｈａｎｋｓ！',
      'ok, thank you!',
      'sounds   good!!',
    ]) {
      expect(shouldRecall(ack), ack).toEqual({ recall: false, reason: 'acknowledgment' });
    }
    // A question still recalls, whatever it starts with.
    expect(shouldRecall('好的，认证服务用什么端口？')).toEqual({ recall: true, reason: 'ok' });
    expect(shouldRecall('ok thanks, which port is auth on?')).toEqual({
      recall: true,
      reason: 'ok',
    });
  });
});
