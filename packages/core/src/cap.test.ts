import { describe, expect, it } from 'vitest';
import {
  OBSERVATION_TEXT_MAX_BYTES,
  capObservation,
  capUtf8,
  truncateUtf8,
  utf8Bytes,
} from './cap.js';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

describe('capUtf8', () => {
  it('leaves text within the cap alone', () => {
    expect(capUtf8('hello', 100)).toBe('hello');
  });

  it('keeps about 2/3 head and 1/3 tail around a marker line, within the cap', () => {
    const text = 'a'.repeat(3000) + 'M'.repeat(3000) + 'z'.repeat(3000);
    const out = capUtf8(text, 1000);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(1000);
    const m = /\n\[… (\d+) bytes omitted …\]\n/.exec(out);
    expect(m).not.toBeNull();
    const [head, tail] = out.split(m![0]);
    expect(head!.startsWith('aaa')).toBe(true);
    expect(tail!.endsWith('zzz')).toBe(true);
    expect(head!.length).toBeGreaterThan(tail!.length);
    expect(Number(m![1])).toBe(9000 - head!.length - tail!.length);
  });

  it('never cuts inside a UTF-8 sequence or a surrogate pair', () => {
    const text = '日本語😀é🙂'.repeat(5000);
    for (const max of [200, 201, 202, 203, 1001, 1002, 1003, 1004]) {
      const out = capUtf8(text, max);
      expect(utf8Bytes(out)).toBeLessThanOrEqual(max);
      expect(out).not.toContain('�');
      expect(() => dec.decode(enc.encode(out))).not.toThrow();
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out),
      ).toBe(false);
    }
  });
});

describe('truncateUtf8', () => {
  it('keeps the head without splitting a character', () => {
    for (const max of [1, 2, 3, 4, 5, 6, 7]) {
      const out = truncateUtf8('😀😀😀', max);
      expect(utf8Bytes(out)).toBeLessThanOrEqual(max);
      expect(out).toBe('😀'.repeat(Math.floor(max / 4)));
    }
  });
});

describe('capObservation', () => {
  it('caps user and assistant text at 32 KB each and bounds tool summaries', () => {
    const big = '😀日本語'.repeat(30_000);
    const o = capObservation({
      userText: big,
      assistantText: big,
      toolSummaries: Array.from({ length: 40 }, () => 'x'.repeat(5000)),
      at: 't',
    });
    expect(OBSERVATION_TEXT_MAX_BYTES).toBe(32 * 1024);
    expect(utf8Bytes(o.userText)).toBeLessThanOrEqual(32 * 1024);
    expect(utf8Bytes(o.assistantText)).toBeLessThanOrEqual(32 * 1024);
    expect(o.toolSummaries.length).toBeLessThanOrEqual(16);
    for (const t of o.toolSummaries) expect(utf8Bytes(t)).toBeLessThanOrEqual(512);
  });

  it('returns the same observation when nothing is over a cap', () => {
    const obs = { userText: 'a', assistantText: 'b', toolSummaries: ['c'], at: 't' };
    expect(capObservation(obs)).toBe(obs);
  });
});
