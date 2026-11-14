/**
 * Tokeniser v2 golden (CON-110, design §5.1): for plain English, v2's tokens are byte-identical to
 * v1's over every text the repo's evals and fixtures hold: the synthetic memories the bench and
 * the recall golden seed (text, stub and entities), the demo eval's questions, the multilingual
 * set's English corpus and questions, the recall golden's questions and injected blocks, and the
 * store migration fixtures. Recall over them therefore cannot change.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { tokenizeLexical, tokenizeLexicalV1 } from '@oortmem/core';
import { FIXTURE_COUNT, FIXTURE_SEED } from './fixture.js';
import { generateMemories } from './generate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.join(here, rel), 'utf8');

function strings(x: unknown, out: string[]): void {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out);
  else if (x !== null && typeof x === 'object') for (const v of Object.values(x)) strings(v, out);
}

function corpus(): string[] {
  const texts: string[] = [];
  // The demo store (recall golden, demo eval) and the bench's 10,000-memory store.
  for (const [n, seed] of [
    [FIXTURE_COUNT, FIXTURE_SEED],
    [10_000, 1],
  ] as const) {
    for (const m of generateMemories(n, seed)) texts.push(m.text, m.stub, m.entities.join(' '));
  }
  for (const file of [
    '../eval/fixture.jsonl',
    '../eval/multilingual/en.corpus.jsonl',
    '../eval/multilingual/en.questions.jsonl',
  ]) {
    for (const line of read(file).split('\n')) if (line.trim()) strings(JSON.parse(line), texts);
  }
  strings(JSON.parse(read('recall-golden.json')), texts);
  for (const file of [
    '../../store-sqlite/test/fixtures/phase1/expected.json',
    '../../store-sqlite/test/fixtures/schema2/expected.json',
  ]) {
    strings(JSON.parse(read(file)), texts);
  }
  return texts;
}

/**
 * English as people write it in chat, beyond the ASCII fixtures: emoji with variation selectors
 * and keycaps, ZWJ sequences, skin tones, ellipses and curly quotes (CON-110).
 */
const CHAT_ENGLISH = [
  '⚠️ the deploy script deletes the staging prefix, check it first',
  'LGTM ✔️ ship it',
  'I ❤️ the new retry backoff',
  '⚙️ config lives in packages/core/config.ts',
  'Steps: 1️⃣ build, 2️⃣ test, 3️⃣ deploy #️⃣ done',
  'pairing 👩‍💻 with Marta on the refund jobs 👍🏽',
  'the whole team 👨‍👩‍👧 agreed 🏳️‍🌈',
  'wait…then retry the migration',
  'hmm… not sure, maybe v1‥v2 of the API',
  '“auth-service” doesn’t listen on 8080 anymore',
  'it’s fine 😀😀😀',
  'Oort™ and Acme℠ both ship an API',
];

it('tokenize-golden.v2-is-byte-identical-to-v1-for-plain-english', () => {
  const texts = [...corpus(), ...CHAT_ENGLISH];
  expect(texts.length).toBeGreaterThan(30_000);
  let differ = 0;
  const examples: string[] = [];
  for (const t of texts) {
    if (tokenizeLexical(t).join(' ') !== tokenizeLexicalV1(t).join(' ')) {
      differ++;
      if (examples.length < 5) examples.push(t.slice(0, 120));
    }
  }
  expect(examples).toEqual([]);
  expect(differ).toBe(0);
});

it('tokenize-golden.documented-folds-are-the-only-differences', () => {
  // NFKC's deliberate folds (core/src/tokenize.ts): full-width ASCII, fractions, super- and
  // subscripts and ligatures. Each is pinned, with v1's tokens beside it.
  const folds: [string, string[], string[]][] = [
    ['ＯＫ　ｔｈａｎｋｓ', ['ok', 'thanks'], ['ｏｋ', 'ｔｈａｎｋｓ']],
    ['add ½ cup', ['add', '1', '2', 'cup'], ['add', '½', 'cup']],
    ['O(n²) time', ['o', 'n2', 'time'], ['o', 'n²', 'time']],
    ['H₂O', ['h2o'], ['h₂o']],
    ['the ﬁle', ['the', 'file'], ['the', 'ﬁle']],
  ];
  for (const [text, v2, v1] of folds) {
    expect(tokenizeLexical(text), text).toEqual(v2);
    expect(tokenizeLexicalV1(text), text).toEqual(v1);
  }
});
