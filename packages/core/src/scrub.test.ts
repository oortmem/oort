import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Observation } from './adapters.js';
import { scrub, scrubObservation } from './scrub.js';

// Synthetic credentials are assembled at runtime so no full key literal appears in source.
const AWS_AKID = 'AKIA' + 'IOSFODNN7EXAMPLE';
const AWS_ASIA = 'ASIA' + 'IOSFODNN7EXAMPLE';

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

/** Some 8-character window of `secret` that survives in `out`, if any. */
function survivingWindow(secret: string, out: string): string | undefined {
  for (let i = 0; i + 8 <= secret.length; i++) {
    const w = secret.slice(i, i + 8);
    if (out.includes(w)) return w;
  }
  return undefined;
}

/** Deterministic PRNG (mulberry32), so property tests are reproducible. */
function prng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

describe('scrub', () => {
  it('scrub.redacts-all-fixture-secrets', () => {
    expect(SECRETS.length).toBeGreaterThanOrEqual(20);
    const failures: string[] = [];
    for (const { kind, secret, text } of SECRETS) {
      expect(text).toContain(secret);
      const out = scrub(text);
      const kept = out.text.includes(secret) ? secret : survivingWindow(secret, out.text);
      if (
        !out.text.includes(`[REDACTED:${kind}]`) ||
        kept !== undefined ||
        !out.redactions.map((r) => r.kind).includes(kind)
      ) {
        failures.push(`${text}  ->  ${out.text}${kept === undefined ? '' : `  (kept ${kept})`}`);
      }
    }
    expect(failures).toEqual([]);
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
      'shopify-key',
      'digitalocean-token',
      'mailgun-key',
      'gitlab-token',
      'square-token',
      'slack-token',
      'slack-webhook',
      'npm-token',
      'huggingface-token',
      'twilio-sid',
      'twilio-key',
      'basic-auth-arg',
    ]) {
      expect(kinds.has(k), k).toBe(true);
    }
  });

  it('scrub.leaves-lookalikes', () => {
    const lines = fixture('lookalikes.txt');
    expect(lines.length).toBeGreaterThanOrEqual(20);
    const failures: string[] = [];
    for (const line of lines) {
      const out = scrub(line);
      if (out.text !== line || out.redactions.length > 0 || out.secretRatio !== 0) {
        failures.push(`${line}  ->  ${out.text}`);
      }
    }
    expect(failures).toEqual([]);
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
    const out = scrub(`before ${AWS_AKID} after\nDB_PASSWORD=hunter2hunter2\nlast line`);
    expect(out.text).toBe(
      'before [REDACTED:aws-access-key] after\nDB_PASSWORD=[REDACTED:env-secret]\nlast line',
    );
    const url = 'https://u:pw@host.example/path'; // nosemgrep: synthetic test credential, not a real secret
    expect(scrub(url).text).toBe('https://[REDACTED:url-credentials]@host.example/path');
    expect(scrub('').secretRatio).toBe(0);
  });

  it('scrub.counts-redactions-and-ratio', () => {
    const out = scrub(`a ${AWS_AKID} b ${AWS_ASIA} c`);
    expect(out.redactions).toEqual([{ kind: 'aws-access-key', count: 2 }]);
    expect(out.secretRatio).toBeCloseTo(40 / 47, 5);
  });

  it('scrub.ratio-never-exceeds-one', () => {
    const quoted = SECRETS.map((s) => s.text.split(s.secret).join(`"${s.secret}"`)).join('\n');
    const once = scrub(quoted);
    expect(once.secretRatio).toBeLessThanOrEqual(1);
    expect(scrub(once.text).secretRatio).toBe(0);
    for (const { text, secret } of SECRETS) {
      // Already quoted, inside escaped JSON, or a URL userinfo: a bare quote there
      // makes the input invalid rather than the secret quoted.
      if (
        text.includes(`"${secret}"`) ||
        text.includes('\\"') ||
        text.includes(`://${secret}@`) ||
        text.includes(`/services/${secret}`)
      ) {
        continue;
      }
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
    const key = 'Zk3Qx9Lm2Vb7Nc4Rt8Yp1Wd6Hs5Jg0Fa9Eu3Io7Kl2Mn'; // nosemgrep: synthetic test credential, not a real secret
    expect(key).toHaveLength(44);
    const out = scrub(`/home/me/.cache/blobs/${key}/data.bin`);
    // The short component on each side of a key goes with it: base64 contains
    // `/`, so `blobs` or `data` could be the key's own edge chunk.
    expect(out.text).toBe('/home/me/.cache/[REDACTED:high-entropy].bin');
    expect(scrub('/Users/mjnong/Library/Application_Support/Code/User').text).toBe(
      '/Users/mjnong/Library/Application_Support/Code/User',
    );
  });

  it('scrub.keeps-json-valid-and-count-keys', () => {
    const json = '{"password": "hunter2hunter2"}'; // nosemgrep: synthetic test credential, not a real secret
    expect(scrub(json).text).toBe('{"password": "[REDACTED:env-secret]"}');
    expect(scrub('TOKEN_COUNT=4096\nmax_tokens: 1024').text).toBe(
      'TOKEN_COUNT=4096\nmax_tokens: 1024',
    );
  });

  it('scrub.redacts-keys-in-paths-without-leaks', () => {
    const k44 = 'kT9+vQ2/Lm8Xp4Rz+Wd6Nc3Bh7Ys1/Fj5Ga0Ue2Io9Pq'; // nosemgrep: synthetic test credential, not a real secret
    const k88 =
      '452GH2wVMPSIobFpU6EpN4dQJzEI66h/aJF++WFGNdC4Oq08twSbp5YOgw4keTUTI5W4VT/MC54cHr4b1/gktN=='; // nosemgrep: synthetic test credential, not a real secret
    const R = '[REDACTED:high-entropy]';
    // A base64 key with `/` takes the short components beside it: any of them
    // could be its edge chunk. Hosts and dot-directories stay.
    expect(scrub(`/srv/uploads/tokens/${k88}`).text).toBe(`/${R}`);
    expect(scrub(`/var/lib/app/${k44}`).text).toBe(`/${R}`);
    expect(scrub(`example.com/download/${k44}`).text).toBe(`example.com/${R}`);
    expect(scrub(`GET https://api.example.com/v1/keys/${k44}`).text).toBe(
      `GET https://api.example.com/${R}`,
    );
    expect(scrub(`key sha512-${k44}`).text).toBe(`key ${R}`);
  });

  it('scrub.json-values-stop-at-delimiters', () => {
    expect(scrub('{"password": 1234, "x": 1}').text).toBe(
      '{"password": [REDACTED:env-secret], "x": 1}',
    );
  });

  it('scrub.exempts-hashes-and-uuids', () => {
    const sha256 = 'a'.repeat(8) + '0123456789abcdef'.repeat(3) + 'b'.repeat(8);
    expect(sha256).toHaveLength(64);
    expect(scrub(`digest ${sha256}`).text).toBe(`digest ${sha256}`);
    expect(scrub(`secret ${sha256}`).text).toBe('secret [REDACTED:high-entropy]');
  });

  it('scrub.exact-outputs', () => {
    const R = (k: string): string => `[REDACTED:${k}]`;
    const cases: [string, string][] = [
      // An unquoted value ends at a delimiter only when the delimiter ends the value.
      ['DB_PASSWORD=Xk9}mQ2)vLp,8rT', `DB_PASSWORD=${R('env-secret')}`],
      ['export DB_PASSWORD=hunter2,secondhalf', `export DB_PASSWORD=${R('env-secret')}`], // nosemgrep: synthetic test credential, not a real secret
      ['PGPASSWORD=ab]cd]ef', `PGPASSWORD=${R('env-secret')}`],
      ['{"password": 1234, "x": 1}', `{"password": ${R('env-secret')}, "x": 1}`],
      ['f(password=hunter2)', `f(password=${R('env-secret')})`], // nosemgrep: synthetic test credential, not a real secret
      ['[password=abc]', `[password=${R('env-secret')}]`],
      ['password=hunter2, next', `password=${R('env-secret')}, next`], // nosemgrep: synthetic test credential, not a real secret
      [
        '{"password": "hunter2hunter2", "user": "bob"}', // nosemgrep: synthetic test credential, not a real secret
        `{"password": "${R('env-secret')}", "user": "bob"}`,
      ],
      // Arrays of strings: each element goes, the array stays valid.
      ['secrets: ["a","b"]', `secrets: ["${R('env-secret')}","${R('env-secret')}"]`],
      // JSON inside a JSON string (AWS Secrets Manager).
      [
        '{"SecretString": "{\\"username\\":\\"admin\\",\\"password\\":\\"Tr0ub4dor3x\\"}"}', // nosemgrep: synthetic test credential, not a real secret
        `{"SecretString": "${R('env-secret')}"}`,
      ],
      [
        [
          '{',
          '    "Name": "prod/db",',
          '    "SecretString": "{\\"username\\":\\"admin\\",\\"password\\":\\"Tr0ub4dor3x\\"}",', // nosemgrep: synthetic test credential, not a real secret
          '    "VersionId": "abc"',
          '}',
        ].join('\n'),
        `{\n    "Name": "prod/db",\n    "SecretString": "${R('env-secret')}",\n    "VersionId": "abc"\n}`,
      ],
      [
        '{"body": "{\\"password\\":\\"Tr0ub4dor3x\\"}"}', // nosemgrep: synthetic test credential, not a real secret
        `{"body": "{\\"password\\":\\"${R('env-secret')}\\"}"}`,
      ],
      // Query parameters keep their name.
      [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
        `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${R('high-entropy')}`,
      ],
      // A key in a path goes with its base64 chunks; the file extension stays.
      [
        'cat ./secrets/kT9+vQ2/Lm8Xp4Rz+Wd6Nc3Bh7Ys1/Fj5Ga0Ue2Io9Pq.json',
        `cat ./${R('high-entropy')}.json`,
      ],
    ];
    expect(cases.map(([i]) => scrub(i).text)).toEqual(cases.map(([, o]) => o));
  });

  /**
   * Accepted trade-offs, pinned so a change in either direction is deliberate.
   * Misses: tokens under 32 chars are never judged (too many ids look random
   * at 24); "the secret: we" cannot be told from YAML; a bcrypt hash is not a
   * credential shape. Over-redactions: ids shaped exactly like keys (mixed
   * case, digits, 32+ chars), and the short path components beside a key.
   */
  it('scrub.documented-trade-offs', () => {
    const R = '[REDACTED:high-entropy]';
    const cases: [string, string][] = [
      ['x 9fKq2LmZ8xRt4VbN7wPy3HsJ6c y', 'x 9fKq2LmZ8xRt4VbN7wPy3HsJ6c y'],
      ['x aZ3kP9qL2mX7vB4nR8tW1yC6 y', 'x aZ3kP9qL2mX7vB4nR8tW1yC6 y'],
      ['aZ3kP9qL2mX7vB4nR8tW1yC6', 'aZ3kP9qL2mX7vB4nR8tW1yC6'],
      ['x 9fKq2LmZ8xRt4VbN7wPy3HsJ6cD1eG', 'x 9fKq2LmZ8xRt4VbN7wPy3HsJ6cD1eG'],
      ['session_id=sess_9fK2mQ7xL4pR8tZ1', 'session_id=sess_9fK2mQ7xL4pR8tZ1'],
      ['x 9fKq2LmZ8xRt4VbN7wPy3HsJ6cD1eG.', 'x 9fKq2LmZ8xRt4VbN7wPy3HsJ6cD1eG.'],
      ['passwordHash: $2b$10$abc', 'passwordHash: $2b$10$abc'],
      // Code with a credential-named variable: the expression goes too.
      ['const tokenValue = parseToken(raw);', 'const tokenValue = [REDACTED:env-secret]'],
      ['dict(password=pw,host=db1)', 'dict(password=[REDACTED:env-secret])'],
      ['the secret: we ship friday', 'the secret: [REDACTED:env-secret] ship friday'],
      [
        'https://docs.google.com/document/d/1aBcD3fGhIjKlMnOpQrStUvWxYz0123456789AbCdEf/edit',
        `https://docs.google.com/${R}`,
      ],
      ['/dev/disk/by-id/nvme-Samsung_SSD_980_1TB_S64ANS0T123456X', `/dev/disk/by-id/${R}`],
    ];
    expect(cases.map(([i]) => scrub(i).text)).toEqual(cases.map(([, o]) => o));
  });

  /**
   * Random keys, bare and inside paths, are redacted whole or not at all: no
   * key character survives (a key's own `/` may, it carries nothing). Accepted
   * misses are keys that read as identifiers: a word share of 0.75 or more
   * (0.5 when over 85% letters with under 3 digits), measured with
   * scratch sweeps of 3000 keys per cell and 5 seeds at about 1-2% of 32-char
   * keys, 0.5% at 40, 0.3% at 44 and 0% at 64+, with 0 partial leaks.
   * The bounds asserted are the task's: 10% at 32 chars, 3% at 44.
   */
  it('scrub.random-keys-fully-redacted', () => {
    const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const alphabets: Record<string, string> = {
      alnum: AL,
      base64: `${AL}+/`,
      base64url: `${AL}-_`,
    };
    const prefixes = [
      '/var/lib/app/',
      '/srv/uploads/tokens/',
      'example.com/download/',
      '/home/me/.cache/blobs/',
      './',
      '~/',
      'https://api.example.com/v1/keys/',
      's3://bucket/uploads/',
      '/Users/mjnong/Desktop/',
      'C:/Users/Me/AppData/',
    ];
    const suffixes = ['', '/data.bin', '.json', '/x'];
    const maxMiss: Record<number, number> = { 32: 0.1, 40: 0.05, 44: 0.03, 64: 0.01, 88: 0.01 };
    const rnd = prng(6);
    const partial: string[] = [];
    const rates: string[] = [];
    for (const [name, al] of Object.entries(alphabets)) {
      for (const n of [32, 40, 44, 64, 88]) {
        for (const ctx of ['bare', 'path']) {
          let miss = 0;
          for (let i = 0; i < 200; i++) {
            let key = '';
            for (let j = 0; j < n; j++) key += al[rnd(al.length)];
            const pre = ctx === 'bare' ? '' : (prefixes[rnd(prefixes.length)] ?? '');
            const suf = ctx === 'bare' ? '' : (suffixes[rnd(suffixes.length)] ?? '');
            const text = `see ${pre}${key}${suf} now`;
            const out = scrub(text);
            expect(out.secretRatio).toBeLessThanOrEqual(1);
            expect(scrub(out.text).text).toBe(out.text);
            if (out.text === text) {
              miss++;
              continue;
            }
            // Zero key characters survive: what is left is the context only.
            const bare = (x: string): string => x.replace(/\//g, '');
            const rest = bare(out.text.replace(/\[REDACTED:[a-z-]+\]/g, ''));
            const mid = rest.slice(4, -4);
            let ok = rest.startsWith('see ') && rest.endsWith(' now');
            ok &&= [...Array(mid.length + 1).keys()].some(
              (k) => bare(pre).startsWith(mid.slice(0, k)) && bare(suf).endsWith(mid.slice(k)),
            );
            if (!ok) partial.push(`${text}  ->  ${out.text}`);
          }
          rates.push(`${name} ${n} ${ctx} ${miss / 200}`);
          expect(miss / 200, `${name} n=${n} ${ctx}`).toBeLessThanOrEqual(maxMiss[n] ?? 0);
        }
      }
    }
    expect(partial).toEqual([]);
    if (process.env['SCRUB_RATES'] !== undefined) console.log(rates.join('\n'));
  });

  it('scrub.fuzz-ratio-and-idempotence', () => {
    const MARKS = /\[REDACTED:[a-z-]+\]/g;
    const bits = [
      ...SECRETS.map((s) => s.text),
      ...fixture('lookalikes.txt'),
      '"',
      "'",
      'Authorization: "',
      'PASSWORD="',
      '[REDACTED:env-secret]',
      'TOKEN=',
      'x-api-key: ',
      'https://:',
      '@',
      ' ',
      '\n',
      'pa-',
      'sk-',
      '/',
      '.',
      ',',
      '}',
      '\\"',
    ];
    const rnd = prng(11);
    const bad: string[] = [];
    for (let i = 0; i < 5000; i++) {
      let s = '';
      const k = 1 + rnd(6);
      for (let j = 0; j < k; j++) s += (bits[rnd(bits.length)] ?? '') + (rnd(3) === 0 ? ' ' : '');
      const out = scrub(s);
      const kept = out.text.replace(MARKS, '').length + (s.length - s.replace(MARKS, '').length);
      // Every character is either kept or counted as removed, exactly once.
      const removed = out.secretRatio * s.length;
      if (Math.abs(removed - Math.min(s.length, s.length - kept)) > 1e-6) bad.push(`ratio ${s}`);
      if (scrub(out.text).text !== out.text) bad.push(`idempotence ${s}`);
    }
    expect(bad).toEqual([]);
  });

  it('scrub.adversarial-inputs-are-fast', () => {
    const inputs = [
      ' SECRET_'.repeat(12_500),
      '-SECRET'.repeat(14_000),
      'a://:' + 'x@'.repeat(50_000),
      'PASSWORD="'.repeat(10_000),
      '"authorization": "'.repeat(5_000),
      ('_' + 'A'.repeat(70) + '_SECRET').repeat(1_300),
      'Ab1/'.repeat(25_000),
      'secret '.repeat(15_000),
      'aSecret_'.repeat(13_000),
      'x='.repeat(50_000),
      'tokenA'.repeat(17_000),
      '"secret":'.repeat(11_000),
      'aB3/'.repeat(25_000),
      'aB3.'.repeat(25_000),
      'password=a,'.repeat(9_000),
      'secrets: ["a",'.repeat(7_000),
      '"secret": "\\'.repeat(8_000),
      'tokenizer:'.repeat(10_000),
      '/'.repeat(100_000),
      'a.'.repeat(50_000),
      'kT9+vQ2/Lm8Xp4Rz+Wd6Nc3Bh7Ys1/Fj5Ga0Ue2Io9Pq '.repeat(2_300), // nosemgrep: synthetic test credential, not a real secret
    ];
    for (const s of inputs) {
      const t = performance.now();
      scrub(s);
      expect(performance.now() - t, s.slice(0, 20)).toBeLessThan(250);
    }
  });
});

function o(userText: string, tools: string[] = []): Observation {
  return { userText, assistantText: '', toolSummaries: tools, at: '2026-01-01T00:00:00.000Z' };
}

describe('scrubObservation', () => {
  it('scrub.secret-ratio-drops-mostly-secret', () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${'A1b2C3d4E5f6G7h8'.repeat(80).slice(0, 1146)}\n-----END PRIVATE KEY-----`; // nosemgrep: synthetic test credential, not a real secret
    expect(pem.length).toBe(1200);
    const prose = 'p'.repeat(50);
    const res = scrubObservation(o(`${pem}${prose}`));
    expect(res.dropped).toBe(true);
    expect(res.redactions).toEqual([{ kind: 'pem-private-key', count: 1 }]);
  });

  it('scrub.keeps-small-secret-in-long-prose', () => {
    const key =
      'sk-' + 'ant-' + 'aB3dE5gH7jK9mN1pQ3rS5tU7vW9xYz2C4e6G8i0K1m3O5q7S9u1W3y5A7c9E1'.slice(0, 53);
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
      userText: `${AWS_AKID} and some long prose `.padEnd(400, '.'),
      assistantText: `${AWS_ASIA} `.padEnd(400, '.'),
      toolSummaries: ['export SECRET_TOKEN=letmein99'.padEnd(400, ' ') + 'ok'], // nosemgrep: synthetic test credential, not a real secret
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
