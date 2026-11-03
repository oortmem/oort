import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Observation } from './adapters.js';
import { scrub, scrubObservation } from './scrub.js';

function fixture(name: string): string[] {
  const url = new URL(`../test/fixtures/${name}`, import.meta.url);
  return fs
    .readFileSync(url, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

const SECRETS = fixture('secrets.txt').map((l) => {
  const [kind = '', secret = '', ...rest] = l.split('\t');
  return { kind, secret, text: rest.join('\t') };
});

describe('scrub', () => {
  it('scrub.redacts-all-fixture-secrets', () => {
    expect(SECRETS.length).toBeGreaterThanOrEqual(20);
    for (const { kind, secret, text } of SECRETS) {
      expect(text).toContain(secret);
      const out = scrub(text);
      expect(out.text, text).toContain('[REDACTED:');
      expect(out.text, text).toContain(`[REDACTED:${kind}]`);
      expect(out.text, text).not.toContain(secret);
      expect(out.redactions.map((r) => r.kind)).toContain(kind);
    }
    const kinds = new Set(SECRETS.map((s) => s.kind));
    for (const k of [
      'aws-access-key',
      'aws-secret-key',
      'github-token',
      'anthropic-key',
      'openai-key',
      'voyage-key',
      'typesafe-key',
      'stripe-key',
      'jwt',
      'pem-private-key',
      'url-credentials',
      'auth-header',
      'env-secret',
      'high-entropy',
    ]) {
      expect(kinds.has(k), k).toBe(true);
    }
  });

  it('scrub.leaves-lookalikes', () => {
    const lines = fixture('lookalikes.txt');
    expect(lines.length).toBeGreaterThanOrEqual(20);
    for (const line of lines) {
      const out = scrub(line);
      expect(out.text).toBe(line);
      expect(out.redactions).toEqual([]);
      expect(out.secretRatio).toBe(0);
    }
  });

  it('scrub.idempotent', () => {
    for (const { text } of SECRETS) {
      const once = scrub(text);
      const twice = scrub(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.redactions).toEqual([]);
    }
    const all = SECRETS.map((s) => s.text).join('\n');
    const once = scrub(all);
    expect(scrub(once.text).text).toBe(once.text);
  });

  it('scrub.keeps-surrounding-text', () => {
    const out = scrub('before AKIAIOSFODNN7EXAMPLE after\nDB_PASSWORD=hunter2hunter2\nlast line');
    expect(out.text).toBe(
      'before [REDACTED:aws-access-key] after\nDB_PASSWORD=[REDACTED:env-secret]\nlast line',
    );
    expect(scrub('https://u:pw@host.example/path').text).toBe(
      'https://[REDACTED:url-credentials]@host.example/path',
    );
    expect(scrub('').secretRatio).toBe(0);
  });

  it('scrub.counts-redactions-and-ratio', () => {
    const out = scrub('a AKIAIOSFODNN7EXAMPLE b ASIAIOSFODNN7EXAMPLE c');
    expect(out.redactions).toEqual([{ kind: 'aws-access-key', count: 2 }]);
    expect(out.secretRatio).toBeCloseTo(40 / 47, 5);
  });

  it('scrub.ratio-never-exceeds-one', () => {
    const quoted = SECRETS.map((s) => s.text.split(s.secret).join(`"${s.secret}"`)).join('\n');
    const once = scrub(quoted);
    expect(once.secretRatio).toBeLessThanOrEqual(1);
    expect(scrub(once.text).secretRatio).toBe(0);
    for (const { text, secret } of SECRETS) {
      if (text.includes(`"${secret}"`)) continue; // already quoted
      const r = scrub(text.split(secret).join(`"${secret}"`));
      expect(r.secretRatio).toBeLessThanOrEqual(1);
      expect(r.text).not.toContain(secret);
    }
  });

  it('scrub.env-secret-is-linear', () => {
    const big = 'SECRET'.repeat(Math.ceil(100_000 / 6));
    const t = performance.now();
    scrub(big);
    expect(performance.now() - t).toBeLessThan(100);
  });

  it('scrub.keeps-path-redacts-key-in-it', () => {
    const key = 'Zk3Qx9Lm2Vb7Nc4Rt8Yp1Wd6Hs5Jg0Fa9Eu3Io7Kl2Mn';
    expect(key).toHaveLength(44);
    const out = scrub(`/home/me/.cache/blobs/${key}/data.bin`);
    expect(out.text).toBe('/home/me/.cache/blobs/[REDACTED:high-entropy]/data.bin');
  });

  it('scrub.keeps-json-valid-and-count-keys', () => {
    expect(scrub('{"password": "hunter2hunter2"}').text).toBe(
      '{"password": "[REDACTED:env-secret]"}',
    );
    expect(scrub('TOKEN_COUNT=4096\nmax_tokens: 1024').text).toBe(
      'TOKEN_COUNT=4096\nmax_tokens: 1024',
    );
  });

  it('scrub.exempts-hashes-and-uuids', () => {
    const sha256 = 'a'.repeat(8) + '0123456789abcdef'.repeat(3) + 'b'.repeat(8);
    expect(sha256).toHaveLength(64);
    expect(scrub(`digest ${sha256}`).text).toBe(`digest ${sha256}`);
    expect(scrub(`secret ${sha256}`).text).toBe('secret [REDACTED:high-entropy]');
  });
});

function o(userText: string, tools: string[] = []): Observation {
  return { userText, assistantText: '', toolSummaries: tools, at: '2026-01-01T00:00:00.000Z' };
}

describe('scrubObservation', () => {
  it('scrub.secret-ratio-drops-mostly-secret', () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${'A1b2C3d4E5f6G7h8'.repeat(80).slice(0, 1146)}\n-----END PRIVATE KEY-----`;
    expect(pem.length).toBe(1200);
    const prose = 'p'.repeat(50);
    const res = scrubObservation(o(`${pem}${prose}`));
    expect(res.dropped).toBe(true);
    expect(res.redactions).toEqual([{ kind: 'pem-private-key', count: 1 }]);
  });

  it('scrub.keeps-small-secret-in-long-prose', () => {
    const key =
      'sk-ant-' + 'aB3dE5gH7jK9mN1pQ3rS5tU7vW9xYz2C4e6G8i0K1m3O5q7S9u1W3y5A7c9E1'.slice(0, 53);
    expect(key).toHaveLength(60);
    const prose = 'The deploy went fine and we discussed the schema. '.repeat(11);
    const res = scrubObservation(o(`${prose}${key}`, ['ran tests']));
    expect(res.dropped).toBe(false);
    expect(res.obs.userText).toContain('[REDACTED:anthropic-key]');
    expect(res.obs.userText).not.toContain(key);
    expect(res.obs.toolSummaries).toEqual(['ran tests']);
  });

  it('scrub.observation-merges-redactions-and-scrubs-tools', () => {
    const res = scrubObservation({
      userText: 'AKIAIOSFODNN7EXAMPLE and some long prose '.padEnd(400, '.'),
      assistantText: 'ASIAIOSFODNN7EXAMPLE '.padEnd(400, '.'),
      toolSummaries: ['export SECRET_TOKEN=letmein99'.padEnd(400, ' ') + 'ok'],
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(res.dropped).toBe(false);
    expect(res.redactions).toEqual([
      { kind: 'aws-access-key', count: 2 },
      { kind: 'env-secret', count: 1 },
    ]);
    expect(res.obs.toolSummaries[0]).toContain('[REDACTED:env-secret]');
  });
});
