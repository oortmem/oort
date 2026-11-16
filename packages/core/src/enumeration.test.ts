import { describe, expect, it } from 'vitest';
import { isEnumeration, spreadAcrossSources } from './enumeration.js';

describe('isEnumeration: questions that gather many things', () => {
  it.each([
    // The order of many events.
    'What is the order of the six museums I visited, from earliest to latest?',
    'In what order did I read the three books my sister recommended?',
    'Can you tell me the order in which I visited the national parks?',
    'Put the concerts I went to this year in chronological order.',
    // How many of a plural thing.
    'How many charity events did I participate in?',
    'How many different doctors did I visit?',
    'How many projects have I led or am currently leading?',
    'How many items of clothing do I need to pick up or return from a store?',
    'How many times did I go to the gym last month?',
    'How many books I read this summer?',
    'How many people did we invite to the wedding?',
    'How many of my friends did I help move?',
    // The most, the least.
    'Which airline did I fly with the most?',
    'Which restaurant did we order from most often?',
    'What is the most expensive thing I bought this year?',
    'Which of my plants needed the least watering?',
    // All the, every.
    'What are all the cities I lived in?',
    'Remind me of all my dentist appointments.',
    'Did I mention every hike I did in Norway?',
    // List.
    'List the restaurants I tried in Lisbon.',
    'Can you list all the podcasts I subscribed to?',
    'Please list my workouts from last week.',
    // In total.
    'How much did I spend on coffee in total?',
    'How many hours have I spent playing games in total?',
    'What is the total amount of money I raised for charity?',
    'How far did we hike altogether on the trip?',
    // A perfect or past clause in other shapes.
    'How many concerts have we been to this year?',
    "Which of the cafes I've tried did I like the most?",
    'Name all the hikes we already finished.',
    "How many tanks do I currently have, including the one I set up for my friend's kid?",
    'What is the total number of siblings I have?',
  ])('enumeration.detects %s', (q) => {
    expect(isEnumeration(q)).toBe(true);
  });

  it.each([
    // About one thing.
    'How many tests fail?',
    'How many tests fail in my repo?',
    'How many people came to the launch?',
    'What is the most common error in this log?',
    'Which test fails the most?',
    // The latest, not one of many.
    'What is the most recent book I read?',
    'Which car did I buy most recently?',
    'Did I sleep at least seven hours?',
    // Durations and single events.
    'How many days ago did I buy the bike?',
    'How many weeks did it take me to finish the course?',
    'How long did I stay in Rome?',
    'I placed an order of sushi yesterday.',
    'I drove all the way to Boston.',
    'I do this all the time.',
    'Where did I put my keys?',
    'What did I eat for dinner on Monday?',
    // Coding prompts in the present: no past the person tells of.
    'how do I get the most out of this hook',
    'what is the most common error in my log',
    'how do I handle every request in my app',
    'list the files in my repo',
    'how many tests do we run in CI',
    'How many workers do we need for every request?',
    'How do I read all the files in my project?',
    'Which endpoint do we call the most?',
    // Instructions.
    'Fix all the failing tests I wrote yesterday.',
    'Rename every variable I added in the parser.',
    'Check all the links in my docs.',
    'Run the tests and list the failures.',
    'List the steps to deploy the app.',
    // Code and long or multi-line text.
    'How many calls to `fetchUser` did I add?',
    'List all the files I changed in src/core.',
    'How many TODOs did I leave in recall.ts?',
    'How many times did I call parseArgs?',
    `How many charity events did I participate in?\nAnd what did I wear?`,
    `I want some help. ${'Here is a lot of context about the project. '.repeat(10)}How many charity events did I attend?`,
    '',
  ])('enumeration.ignores %s', (q) => {
    expect(isEnumeration(q)).toBe(false);
  });
});

describe('spreadAcrossSources', () => {
  const ranked = (ids: string[]) => ids.map((id) => ({ id }));
  const sources: Record<string, string> = {
    a1: 'A',
    a2: 'A',
    a3: 'A',
    a4: 'A',
    b1: 'B',
    b2: 'B',
    b3: 'B',
    c1: 'C',
  };
  const sourceOf = (id: string) => sources[id];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  it('enumeration.spread-at-most-n-per-source-in-rank-order', () => {
    const out = spreadAcrossSources(
      ranked(['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'c1']),
      sourceOf,
      2,
      5,
    );
    expect(ids(out)).toEqual(['a1', 'a2', 'b1', 'b2', 'c1']);
  });

  it('enumeration.spread-fills-from-skipped-when-sources-are-few', () => {
    const out = spreadAcrossSources(ranked(['a1', 'a2', 'a3', 'a4', 'b1']), sourceOf, 2, 5);
    expect(ids(out)).toEqual(['a1', 'a2', 'b1', 'a3', 'a4']);
    // Fewer candidates than places: every one is returned.
    expect(ids(spreadAcrossSources(ranked(['a1', 'a2', 'a3']), sourceOf, 1, 10))).toEqual([
      'a1',
      'a2',
      'a3',
    ]);
  });

  it('enumeration.spread-a-memory-without-a-source-is-its-own', () => {
    const out = spreadAcrossSources(ranked(['x', 'y', 'a1', 'a2', 'a3', 'z']), sourceOf, 1, 4);
    expect(ids(out)).toEqual(['x', 'y', 'a1', 'z']);
  });

  it('enumeration.spread-keeps-a-kept-memory-whatever-its-source', () => {
    const out = spreadAcrossSources(
      ranked(['a1', 'a2', 'a3', 'b1', 'a4']),
      sourceOf,
      2,
      4,
      new Set(['a3']),
    );
    expect(ids(out)).toEqual(['a1', 'a2', 'a3', 'b1']);
  });

  it('enumeration.spread-never-adds-and-keeps-the-same-objects', () => {
    const list = ranked(['a1', 'a2', 'a3', 'b1']);
    const out = spreadAcrossSources(list, sourceOf, 1, 10);
    expect(out).toHaveLength(list.length);
    for (const x of out) expect(list).toContain(x);
    // Already spread: the order is unchanged.
    const spread = ranked(['a1', 'b1', 'c1']);
    expect(spreadAcrossSources(spread, sourceOf, 1, 3)).toEqual(spread);
  });
});
