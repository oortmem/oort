import type { Memory } from './model.js';
import { tokenizeLexical } from './tokenize.js';

/**
 * Words that say nothing about what a query is about: articles, pronouns, and the verbs and
 * question words people wrap a question in ("which library does X use"). Coverage ignores them,
 * so "the incident policy for the relay" is judged on incident, policy and relay.
 */
const STOPWORDS = new Set(
  (
    'a an the of for to in on at by with and or but is are was were be been being it its this ' +
    'that these those who whom whose what which when where how why do does did done from as into ' +
    'about over under than then there their our your my me we you they he she i us them his her ' +
    'use uses used using has have had get gets got set sets can could should would will shall may ' +
    'might must not no yes just also any all some much many more most other another such only own ' +
    'same so too very back now still ever if else please tell show know remember'
  ).split(' '),
);

/** A text's informative tokens: lexical tokens minus stopwords, plus the parts of joined tokens. */
export function informativeTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenizeLexical(text)) {
    if (!STOPWORDS.has(t)) out.add(t);
    for (const part of t.split(/[-_.]/)) {
      if (part.length > 0 && part !== t && !STOPWORDS.has(part)) out.add(part);
    }
  }
  return out;
}

/**
 * The share of a query's informative tokens that a memory's text, stub or entities contain,
 * from 0 to 1. A query with no informative tokens covers nothing (0).
 */
export function queryCoverage(query: Set<string>, m: Memory): number {
  if (query.size === 0) return 0;
  const doc = informativeTokens([m.text, m.stub, ...m.entities].join(' '));
  let hit = 0;
  for (const t of query) if (doc.has(t)) hit++;
  return hit / query.size;
}

/** The coverage a fused top result needs before rerank can be skipped. */
export const CONFIDENT_COVERAGE = 0.8;
/** How much weaker on query words the runner-up must be for the top result to count as clear. */
export const CONFIDENT_COVERAGE_GAP = 0.3;
