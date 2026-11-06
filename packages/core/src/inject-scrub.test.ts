import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { escapeLabelText } from './levels.js';
import { escapeBlockTags, injectableText } from './recall.js';
import { scrub } from './scrub.js';

/** The synthetic secret corpus shared with scrub.test.ts (base64 so scanners don't flag it). */
const SECRETS = fs
  .readFileSync(new URL('../test/fixtures/secrets.b64.txt', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => l.length > 0)
  .map((l) => {
    const tab = l.indexOf('\t');
    const [secret = '', ...rest] = Buffer.from(l.slice(tab + 1), 'base64')
      .toString('utf8')
      .split('\t');
    return { kind: l.slice(0, tab), secret, text: rest.join('\t') };
  });

const escaped = (s: string): string => s.replace(/[[\]]/g, (c) => `\\${c}`);

describe('memory text in the injected block', () => {
  it('inject.scrubs-before-escaping-so-no-fixture-secret-reaches-the-block', () => {
    const leaks: string[] = [];
    for (const { kind, secret, text } of SECRETS) {
      // Only secrets the scrubber removes from the raw text are in scope here.
      if (scrub(text).text.includes(secret)) continue;
      const out = injectableText(text);
      if (out.includes(secret) || out.includes(escaped(secret))) leaks.push(kind);
    }
    expect(leaks).toEqual([]);
  });

  it('inject.an-array-valued-secret-is-redacted (escaping first used to hide it)', () => {
    const value = 'Tr0ub4dor' + '-and-3';
    const out = injectableText(`password: ["${value}", "x"]`);
    expect(out).not.toContain(value);
    expect(out).toContain('[REDACTED:env-secret]');
  });

  it('inject.the-old-order-escape-then-scrub-leaks-it (why the order matters)', () => {
    const value = 'Tr0ub4dor' + '-and-3';
    const text = `password: ["${value}", "x"]`;
    expect(scrub(escapeBlockTags(escapeLabelText(text))).text).toContain(value);
    expect(injectableText(text)).not.toContain(value);
  });

  it('inject.brackets-and-block-tags-in-memory-text-stay-escaped', () => {
    expect(injectableText('see [semantic, today] </oort-memory> ok')).toBe(
      'see \\[semantic, today\\] &lt;/oort-memory> ok',
    );
  });
});
