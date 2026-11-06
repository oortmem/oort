import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Observation } from './adapters.js';
import { RULE_KINDS, escapeBounded, scrub, scrubObservation } from './scrub.js';

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

// Each line is `<kind>\t<base64 of "secret\ttext">`: the synthetic credentials stay out of
// plain text so secret scanners (GitHub push protection among them) do not flag the corpus.
const SECRETS = fixture('secrets.b64.txt').map((l) => {
  const tab = l.indexOf('\t');
  const kind = l.slice(0, tab);
  const [secret = '', ...rest] = Buffer.from(l.slice(tab + 1), 'base64')
    .toString('utf8')
    .split('\t');
  return { kind, secret, text: rest.join('\t') };
});

/**
 * CPU milliseconds this thread spends in `fn`. Wall-clock time also counts the time spent waiting
 * for a core, which on a loaded machine (a load average of 100+) is most of it; CPU time is what
 * the code itself costs, so a bound on it holds whatever else the machine runs.
 */
function cpuMs(fn: () => void): number {
  // `threadCpuUsage` (Node 23.9+) leaves out other threads; `cpuUsage` is the whole process.
  const usage = (prev?: NodeJS.CpuUsage): NodeJS.CpuUsage =>
    typeof process.threadCpuUsage === 'function'
      ? process.threadCpuUsage(prev)
      : process.cpuUsage(prev);
  const before = usage();
  fn();
  const spent = usage(before);
  return (spent.user + spent.system) / 1000;
}

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
      'oort-key',
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

  it('scrub.a-bare-value-that-starts-with-a-bracket-is-redacted', () => {
    const value = 'Tr0ub4dor' + '-and-3';
    expect(scrub(`token=[${value}]`).text).not.toContain(value);
    expect(scrub(`password: [${value}`).text).not.toContain(value);
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

  // `secretRatio` is not clamped, so these bounds can fail.
  it('scrub.ratio-never-exceeds-one', () => {
    const quoted = SECRETS.map((s) => s.text.split(s.secret).join(`"${s.secret}"`)).join('\n');
    const once = scrub(quoted);
    expect(once.secretRatio).toBeLessThanOrEqual(1);
    expect(scrub(once.text).secretRatio).toBe(0);
    for (const { text, secret } of SECRETS) {
      // Already quoted, inside escaped JSON, a URL userinfo or after a backslash: a bare quote there
      // makes the input invalid rather than the secret quoted.
      if (
        text.includes(`"${secret}"`) ||
        text.includes('\\"') ||
        text.includes(`://${secret}@`) ||
        text.includes(`/services/${secret}`) ||
        text.includes(`\\${secret}`)
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
    expect(cpuMs(() => scrub(big))).toBeLessThan(100);
  });

  /**
   * Serialised text often has no real newline for a megabyte: deciding whether
   * a token sits inside a JSON string must not rescan the line for each token.
   * A scaling check, not a wall-clock bound (those flake under load): 4x the
   * input must cost well under 16x, the quadratic ratio. Both sides are CPU
   * time (`cpuMs`), so a busy machine does not skew the ratio.
   */
  it('scrub.linear-on-long-serialised-lines', { timeout: 180_000 }, () => {
    const rnd = prng(17);
    const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const rand = (n: number, al: string): string => {
      let s = '';
      for (let i = 0; i < n; i++) s += al[rnd(al.length)];
      return s;
    };
    const MB = 1_000_000;
    const lines = (line: () => string) => (size: number) => {
      let s = '';
      while (s.length < size) s += `${line()}\n`;
      return JSON.stringify({ content: s.slice(0, size) });
    };
    const inputs: [string, (size: number) => string][] = [
      ['\\n + 32-char tokens', (size) => `{"x":"${`\\n${'a'.repeat(32)} `.repeat(size / 35)}"}`],
      ['76-col base64', lines(() => rand(76, b64))],
      ['sha256sum', lines(() => `${rand(64, '0123456789abcdef')}  src/file.ts`)],
      [
        'go.sum',
        lines(() => `github.com/someorg/somepackage/v2 v2.3.${rnd(9)} h1:${rand(43, b64)}=`),
      ],
    ];
    // The fastest of five runs each, the two sizes interleaved: contention (a shared cache, a
    // slower core) only ever adds time, and interleaving exposes both sizes to the same spells.
    const ratioOf = (small: string, large: string): number => {
      let bestSmall = Infinity;
      let bestLarge = Infinity;
      for (let i = 0; i < 5; i++) {
        const smallMs = cpuMs(() => scrub(small));
        const largeMs = cpuMs(() => scrub(large));
        bestSmall = Math.min(bestSmall, smallMs);
        bestLarge = Math.min(bestLarge, largeMs);
      }
      return bestLarge / bestSmall;
    };
    for (const [label, make] of inputs) {
      const small = make(MB / 2);
      const large = make(2 * MB);
      scrub(small); // warm up
      const ratio = ratioOf(small, large);
      // 4x the input: linear is ~4, quadratic ~16. In CPU time it stayed within 3.9-4.3 at a
      // load average of 400 (wall-clock ratios reached 22 there), so 8 has room and still
      // catches a quadratic scan.
      expect(ratio, `${label}: t(2 MB) / t(0.5 MB)`).toBeLessThan(8);
    }
  });

  it('scrub.bare-value-keeps-json-closing-quote', () => {
    const B = '\\';
    const v = 'abc9' + 'xyz';
    for (const input of [
      `{"c":"PASSWORD=${v}${B}${B}"}`,
      `{"c":"token=${v}${B}${B}","d":"x"}`,
      `set PASSWORD=C:${B}${B}tmp${v}${B}${B}`,
    ]) {
      const out = scrub(input).text;
      expect(out, input).toContain('[REDACTED:env-secret]');
      expect(out, input).not.toContain(v);
      let parses = true;
      try {
        JSON.parse(input);
      } catch {
        parses = false;
      }
      if (parses) expect(() => JSON.parse(out), out).not.toThrow();
    }
  });

  it('scrub.lone-backslash-keeps-following-delimiter', () => {
    // A plain-text backslash is not an escape: the delimiter after it still ends the value.
    const B = '\\';
    const v = 'abc9' + 'xyz';
    const cases: [string, string][] = [
      [`PASSWORD=${v}${B}, next=1`, 'PASSWORD=[REDACTED:env-secret], next=1'],
      [`(PASSWORD=${v}${B}) next`, '(PASSWORD=[REDACTED:env-secret]) next'],
      [`[token=${v}${B}] x`, '[token=[REDACTED:env-secret]] x'],
      [`{token=${v}${B}} x`, '{token=[REDACTED:env-secret]} x'],
    ];
    for (const [input, want] of cases) expect(scrub(input).text, input).toBe(want);
    // JSON escapes of a backslash or a quote stay part of the value.
    expect(scrub(`{"c":"PASSWORD=ab${B}"c9${B}${B}"}`).text).toBe(
      '{"c":"PASSWORD=[REDACTED:env-secret]"}',
    );
  });

  it('scrub.escape-bounded-rejects-unrewritable-lookbehind', () => {
    expect(() => escapeBounded({ kind: 'synthetic', re: /(?<=x:)\w+/g })).toThrow(/cannot bound/);
    expect(() => escapeBounded({ kind: 'synthetic', re: /(?<!(?:a|b))\w+/g })).toThrow(
      /cannot bound/,
    );
    expect(() =>
      escapeBounded({ kind: 'synthetic', re: /(?<=x:)\w+/g, ownBoundary: true }),
    ).not.toThrow();
    expect(escapeBounded({ kind: 'synthetic', re: /\bab\w+/g }).re.source).toContain('(?<=\\\\');
  });

  it('scrub.keeps-path-redacts-key-in-it', () => {
    const key = 'Zk3Qx9Lm2Vb7Nc4Rt8Yp1Wd6Hs5Jg0Fa9Eu3Io7Kl2Mn'; // nosemgrep: synthetic test credential, not a real secret
    expect(key).toHaveLength(44);
    const out = scrub(`/home/me/.cache/blobs/${key}/data.bin`);
    // The short component on each side of a key goes with it: base64 contains
    // `/`, so `blobs` or `data` could be the key's own edge chunk.
    expect(out.text).toBe('/home/me/.cache/[REDACTED:high-entropy].bin');
    expect(scrub('/Users/alex/Library/Application_Support/Code/User').text).toBe(
      '/Users/alex/Library/Application_Support/Code/User',
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
   * Serialised tool input: a literal `\n` (backslash, `n`) or other JSON escape
   * is a token boundary on both sides, and the escape itself survives. Tokens
   * are assembled at runtime so no credential literal sits in this file.
   */
  it('scrub.json-escapes-are-token-boundaries', () => {
    const B = '\\';
    const A = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh2jKm';
    const aws = 'AK' + 'IA' + 'Q7XZB3KMP9RTW2LN';
    const gitlab = 'gl' + 'pat-' + A.slice(0, 20);
    const pw = 'hunter2' + 'hunter2';
    const R = (k: string): string => `[REDACTED:${k}]`;
    const cases: [string, string][] = [
      [
        `{"command":"echo hi${B}n${aws}${B}necho"}`,
        `{"command":"echo hi${B}n${R('aws-access-key')}${B}necho"}`,
      ],
      [`{"c":"x${B}t${gitlab}${B}t"}`, `{"c":"x${B}t${R('gitlab-token')}${B}t"}`],
      [`{"c":"${B}u00e9${aws}"}`, `{"c":"${B}u00e9${R('aws-access-key')}"}`],
      [
        `{"command":"export A=1${B}nDB_PASSWORD=${pw}${B}necho ok"}`,
        // An escape never ends a secret value: over-redaction beats a leaked tail.
        `{"command":"export A=1${B}nDB_PASSWORD=${R('env-secret')} ok"}`,
      ],
      [
        `{"c":"a${B}n${'kT9+vQ2/Lm8Xp4Rz+Wd6'}${'Nc3Bh7Ys1/Fj5Ga0Ue2Io9Pq'}${B}nb"}`,
        `{"c":"a${B}n${R('high-entropy')}${B}nb"}`,
      ],
      // A backslash in a password is not an escape that ends it.
      [`PASSWORD=pa${B}${B}ss${pw}`, `PASSWORD=${R('env-secret')}`],
    ];
    expect(cases.map(([i]) => scrub(i).text)).toEqual(cases.map(([, o]) => o));
    for (const [i] of cases) expect(scrub(scrub(i).text).text).toBe(scrub(i).text);
  });

  /**
   * Every rule, after every JSON escape: caught under its own kind, no secret
   * window survives, and the escape itself stays. Samples are assembled at
   * runtime; there must be one per rule. Deferred: basic-auth-arg is bounded
   * only by the start, whitespace or `\n` `\r` `\t`.
   */
  it('scrub.every-rule-bounded-after-every-escape', () => {
    const A = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh2jKm';
    const hex = '0123456789abcdef';
    const S = (text: string, secret = text): { text: string; secret: string } => ({ text, secret });
    const samples: Record<string, { text: string; secret: string }[]> = {
      'pem-private-key': [
        S(
          `-----BEGIN RSA ${'PRIVATE'} KEY-----MIIEowIBAAKCAQEA${A}-----END RSA ${'PRIVATE'} KEY-----`,
          A,
        ),
      ],
      'aws-access-key': [S('AK' + 'IA' + 'Q7XZB3KMP9RTW2LN')],
      'aws-secret-key': [
        S(
          'aws_secret_' + 'access_key=' + 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY' + 'EXAMPLEKEY',
          'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        ),
      ],
      'github-token': [S('gh' + 'p_' + A.slice(0, 36)), S('github' + '_pat_' + A.slice(0, 30))],
      'anthropic-key': [S('sk-' + 'ant-api03-' + A.slice(0, 40))],
      'oort-key': [S('oort' + '_sk_' + A.slice(0, 40))],
      'stripe-key': [S('sk_' + 'live_' + A.slice(0, 24))],
      'typesafe-key': [S('ts_' + 'live_' + A.slice(0, 20))],
      'shopify-key': [S('shp' + 'at_' + hex + hex)],
      'digitalocean-token': [S('dop' + '_v1_' + hex.repeat(4))],
      'mailgun-key': [S('key' + '-' + hex + hex)],
      'gitlab-token': [S('gl' + 'pat-' + A.slice(0, 20))],
      'square-token': [S('sq0' + 'atp-' + A.slice(0, 22))],
      'slack-token': [S('xo' + 'xb-1234567890-' + A.slice(0, 24))],
      'npm-token': [S('np' + 'm_' + A.slice(0, 36))],
      'huggingface-token': [S('h' + 'f_' + A.slice(0, 34))],
      'twilio-sid': [
        S(
          'account sid ' + 'AC' + '3f9b2c7e1a4d5068b9c2e7f1a3d5b6c8',
          '3f9b2c7e1a4d5068b9c2e7f1a3d5b6c8',
        ),
      ],
      'twilio-key': [S('SK' + '8e2f4a6c1b3d5e7f9a0b2c4d6e8f1a3b')],
      'slack-webhook': [
        S(
          'https://hooks.slack.com/services/' + 'T00000000/B00000000/' + A.slice(0, 24),
          A.slice(0, 24),
        ),
      ],
      'openai-key': [S('sk-' + 'proj-' + A.slice(0, 40))],
      'voyage-key': [S('pa' + '-' + A.slice(0, 30))],
      jwt: [S('ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + A.slice(0, 32))],
      'url-credentials': [
        S('https://admin:' + 'Hunter2Pass' + '@db.example.com/x', 'Hunter2Pass'),
        S('https://' + A.slice(0, 32) + '@o1.ingest.sentry.io/1', A.slice(0, 32)),
      ],
      'basic-auth-arg': [S('-u deploy:' + 'S3cr3tP@ss2024', 'S3cr3tP@ss2024')],
      'auth-header': [S('Authorization: Bearer ' + 'abc123tokenvalue', 'abc123tokenvalue')],
      'env-secret': [S('DB_PASSWORD=' + 'hunter2' + 'hunter2', 'hunter2hunter2')],
      'high-entropy': [S('kT9+vQ2/Lm8Xp4Rz+Wd6' + 'Nc3Bh7Ys1/Fj5Ga0Ue2Io9Pq')],
    };
    const perKind = (kinds: readonly string[]): Record<string, number> =>
      Object.fromEntries(
        [...new Set(kinds)].sort().map((k) => [k, kinds.filter((x) => x === k).length]),
      );
    expect(perKind(Object.entries(samples).flatMap(([k, v]) => v.map(() => k)))).toEqual(
      perKind(RULE_KINDS),
    );
    const B = '\\';
    const failures: string[] = [];
    for (const [kind, list] of Object.entries(samples)) {
      for (const { text: tok, secret } of list) {
        for (const e of ['n', 't', 'r', '"', B, '/', 'b', 'f', 'u00e9']) {
          if (kind === 'basic-auth-arg' && !['n', 't', 'r'].includes(e)) continue;
          const text = `{"c":"echo hi${B}${e}${tok}${B}nnext"}`;
          const out = scrub(text).text;
          const ok =
            out.includes(`[REDACTED:${kind}]`) &&
            !out.includes(secret) &&
            survivingWindow(secret, out) === undefined &&
            out.includes(`${B}${e}`) &&
            scrub(out).text === out;
          if (!ok) failures.push(`${kind} \\${e}: ${out}`);
        }
      }
    }
    expect(failures).toEqual([]);
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
      // A value is never cut at an escape, so prose and code on the next line go too.
      [
        '{"text":"Enter your\\npassword: then press enter"}',
        '{"text":"Enter your\\npassword: [REDACTED:env-secret] press enter"}',
      ],
      [
        '{"text":"```ts\\nconst apiKey = process.env.API_KEY;\\nconst tokenizer = new Tokenizer();\\n```"}',
        '{"text":"```ts\\nconst apiKey = [REDACTED:env-secret] tokenizer = new Tokenizer();\\n```"}',
      ],
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
      '/Users/alex/Desktop/',
      'C:/Users/Me/AppData/',
      'C:\\Users\\Me\\AppData\\',
      'C:\\keys\\',
      'C:\\\\Users\\\\Me\\\\',
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
      const ms = cpuMs(() => scrub(s));
      expect(ms, s.slice(0, 20)).toBeLessThan(250);
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
