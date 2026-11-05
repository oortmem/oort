#!/usr/bin/env node
// Fails when a tracked file holds something that must never be in this public repo:
// a real-looking live credential, a private key, or the maintainer's personal details.
// Runs first in `pnpm verify`. Test fixtures that need secret-shaped values keep them
// base64-encoded or build them at runtime, so they never match these patterns.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const SELF = 'scripts/check-public.mjs';

// Personal details are spelled in pieces so this file does not match itself in a plain grep.
const j = (...parts) => parts.join('');
const RULES = [
  ['Stripe live secret or restricted key', /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ['Stripe webhook signing secret', /\bwhsec_[A-Za-z0-9]{20,}/],
  ['Anthropic API key', /\bsk-ant-api03-[A-Za-z0-9_-]{80,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['Voyage API key', /\bpa-[A-Za-z0-9_-]{40,}/],
  // A PEM header followed on the next line by a literal base64 body (runtime-built test keys are templates).
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{40,}\r?\n/],
  ['local home path', new RegExp(j('/Users/', 'mj', 'nong'))],
  ['personal email', new RegExp(j('marcus', 'nagy', '@icloud\\.com'), 'i')],
  ['work email domain', new RegExp(j('@', 'bim', '\\.com'), 'i')],
  ['personal identity number', new RegExp(j('19960505', '6911'))],
  ['Swedish phone number', /\+46[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{2}/],
];

// Large binaries bloat every clone forever (history keeps them), so any tracked file above this
// size fails. The full-size brand kit lives in the private repo, not here.
const MAX_BYTES = 500_000;

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((f) => f !== '' && f !== SELF);

const hits = [];
for (const file of files) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  if (size > MAX_BYTES) {
    hits.push(
      `${file}  ${(size / 1000).toFixed(0)} kB is over the ${(MAX_BYTES / 1000).toFixed(0)} kB limit`,
    );
  }
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue; // deleted in the working tree but still in the index
  }
  if (buf.includes(0)) continue; // binary
  const text = buf.toString('utf8');
  for (const [what, re] of RULES) {
    const m = re.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push(`${file}:${line}  ${what}`);
    }
  }
}

if (hits.length > 0) {
  console.error('check-public: found content that must not be in the public repo:\n');
  for (const h of hits) console.error(`  ${h}`);
  console.error(
    '\nRemove it, or for a test fixture keep the value base64-encoded or built at runtime.\n' +
      'For a large file: compress it, or keep it outside the repo.',
  );
  process.exit(1);
}
console.log(`check-public: ${files.length} tracked files clean`);
