import { describe, expect, it } from 'vitest';
import { subQueries } from './subqueries.js';

describe('subQueries: which came first, X or Y', () => {
  it('subqueries.choice-names-each-alternative-with-the-event-verb', () => {
    expect(subQueries('Which laptop did I buy first, the ThinkPad X1 or the MacBook Air?')).toEqual(
      ['buy ThinkPad X1', 'buy MacBook Air'],
    );
  });

  it('subqueries.choice-with-the-alternative-as-subject', () => {
    expect(
      subQueries('Which event happened first, my sister’s graduation or the office move?'),
    ).toEqual(['sister’s graduation', 'office move']);
    expect(subQueries('Who moved abroad first, Priya or Daniel?')).toEqual([
      'Priya moved abroad',
      'Daniel moved abroad',
    ]);
  });

  it('subqueries.choice-keeps-words-after-the-order-cue', () => {
    expect(
      subQueries('Which room did we paint first in March, the kitchen or the hallway?'),
    ).toEqual(['paint kitchen in March', 'paint hallway in March']);
  });

  it('subqueries.choice-with-other-order-cues', () => {
    expect(
      subQueries(
        'Which course did I finish most recently, the Spanish course or the pottery class?',
      ),
    ).toEqual(['finish Spanish course', 'finish pottery class']);
    expect(
      subQueries('Which trip did we take earlier, the one to Lisbon or the one to Oslo?'),
    ).toEqual(['take one to Lisbon', 'take one to Oslo']);
  });

  it('subqueries.choice-keeps-quoted-titles-intact', () => {
    expect(subQueries("Which book did I finish first, 'The Name of the Wind' or 'Dune'?")).toEqual([
      "finish 'The Name of the Wind'",
      "finish 'Dune'",
    ]);
    expect(subQueries('Which film did I watch first, "Heat, Part One" or "Ronin"?')).toEqual([
      'watch "Heat, Part One"',
      'watch "Ronin"',
    ]);
  });

  it('subqueries.choice-alternative-may-contain-and', () => {
    expect(subQueries('Who did I meet first, Ana and Luis or Ben?')).toEqual([
      'meet Ana and Luis',
      'meet Ben',
    ]);
  });

  it('subqueries.choice-with-one-word-alternatives', () => {
    expect(subQueries('Which pet did I adopt first, the cat or the dog?')).toEqual([
      'adopt cat',
      'adopt dog',
    ]);
  });

  it('subqueries.three-alternatives', () => {
    expect(subQueries('Which city did I visit first, Rome, Paris or Madrid?')).toEqual([
      'visit Rome',
      'visit Paris',
      'visit Madrid',
    ]);
  });
});

describe('subQueries: lists of events', () => {
  it('subqueries.order-list-after-a-colon', () => {
    expect(
      subQueries(
        'In what order did these happen: the day I adopted the puppy, the day I started the new job, and the day I sold my car?',
      ),
    ).toEqual(['adopted the puppy', 'started the new job', 'sold my car']);
  });

  it('subqueries.order-list-of-quoted-events', () => {
    expect(
      subQueries(
        "What is the order of the three events: 'I renewed my passport', 'I booked the flights', and 'I packed'?",
      ),
    ).toEqual(["'I renewed my passport'", "'I booked the flights'", "'I packed'"]);
  });

  it('subqueries.among-a-list-of-people', () => {
    expect(subQueries('Who retired first, second and third among Maria, Tom and Lee?')).toEqual([
      'Maria retired',
      'Tom retired',
      'Lee retired',
    ]);
  });
});

describe('subQueries: between X and Y', () => {
  it('subqueries.days-between-two-events', () => {
    expect(
      subQueries(
        'How many days passed between the day I planted the apple tree and the day I picked the first apples?',
      ),
    ).toEqual(['planted the apple tree', 'picked the first apples']);
  });

  it('subqueries.between-picks-the-parallel-and', () => {
    expect(
      subQueries(
        'How many weeks passed between the time I sold bread and jam at the market and the time I opened my bakery?',
      ),
    ).toEqual(['sold bread and jam at the market', 'opened my bakery']);
  });

  it('subqueries.between-named-events', () => {
    expect(
      subQueries("How many days had passed between the 'Spring Gala' and the harvest festival?"),
    ).toEqual(["'Spring Gala'", 'harvest festival']);
  });

  it('subqueries.between-first-and-second-shares-the-noun', () => {
    expect(
      subQueries("How many months passed between Kim's first and second job interview?"),
    ).toEqual(["Kim's first job interview", 'second job interview']);
  });

  it('subqueries.difference-in-something-between', () => {
    expect(
      subQueries(
        'What is the difference in price between my winter coat and the one I saw online?',
      ),
    ).toEqual(['winter coat', 'one I saw online']);
  });
});

describe('subQueries: how long had I X when Y, before and after', () => {
  it('subqueries.how-long-had-i-when', () => {
    expect(
      subQueries('How long had I been learning the cello when I played my first concert?'),
    ).toEqual(['learning the cello', 'played my first concert']);
  });

  it('subqueries.how-many-days-had-passed-since-when', () => {
    expect(
      subQueries('How many days had passed since I started the diet when I ran the half marathon?'),
    ).toEqual(['started the diet', 'ran the half marathon']);
  });

  it('subqueries.how-many-days-before-x-did-i-y', () => {
    expect(
      subQueries('How many days before the product launch did I fix the billing bug?'),
    ).toEqual(['product launch', 'fix the billing bug']);
    expect(subQueries('How many months before our wedding did Sam change jobs?')).toEqual([
      'wedding',
      'Sam change jobs',
    ]);
  });

  it('subqueries.how-long-did-i-x-before-y', () => {
    expect(subQueries('How long did I use the old bike before I bought the electric one?')).toEqual(
      ['use the old bike', 'bought the electric one'],
    );
    expect(
      subQueries('How many days did it take me to sell the sofa after listing it online?'),
    ).toEqual(['sell the sofa', 'listing it online']);
  });
});

describe('subQueries: X and Y combined', () => {
  it('subqueries.quoted-titles-combined', () => {
    expect(
      subQueries("How long did it take me to read 'Middlemarch' and 'Persuasion' combined?"),
    ).toEqual(["'Middlemarch'", "'Persuasion'"]);
  });

  it('subqueries.in-total-shares-the-verb', () => {
    expect(
      subQueries('How many days did I spend in total hiking in Norway and in Scotland?'),
    ).toEqual(['hiking in Norway', 'hiking in Scotland']);
  });

  it('subqueries.combined-after-a-preposition', () => {
    expect(
      subQueries('How much did I spend on the hotel room and the rental car combined?'),
    ).toEqual(['hotel room', 'rental car']);
  });
});

describe('subQueries: no split', () => {
  const none = [
    // One thing.
    'What degree did I graduate with?',
    'How many days ago did I buy the smoker?',
    'What is the order of the six museums I visited from earliest to latest?',
    'How many charity events did I join this year?',
    'Which streaming service did I start using most recently?',
    'How many hours in total did I spend driving to my three destinations combined?',
    // "or" and "and" that are not two events.
    'How many items do I need to pick up or return from the store?',
    'How many projects have I led or am currently leading?',
    'Did I increase or decrease my coffee limit most recently?',
    'Can you recommend a show or movie for me to watch tonight?',
    'Which is faster, Redis or Memcached?',
    'Which should I do first, fix the login bug or update the docs?',
    "What's the difference between let and const?",
    'How many days did it take for my case to arrive after I bought it?',
    // A coding assistant's prompts.
    'fix the flaky test or skip it for now',
    'Fix X or Y, whichever is quicker.',
    'what is the difference between the two functions',
    'Which file did I edit first, src/recall.ts or src/fusion.ts?',
    'Which function did I change first, parseConfig or loadConfig?',
    'Which did I run first, `pnpm test` or `pnpm build`?',
    'Which hook fired first, on_save or on_load?',
    'How many lines changed between v1.2.0 and v1.3.0?',
    'How long did the build take before and after the cache change?',
    'Which test failed first, test_recall() or test_fuse()?',
    'Compare the old and new config: which keys changed first, a=1 or b=2?',
    'Which came first:\n- the refactor\n- the migration',
    '',
    '   ',
  ];
  for (const q of none) {
    it(`subqueries.none: ${JSON.stringify(q).slice(0, 60)}`, () => {
      expect(subQueries(q)).toBeUndefined();
    });
  }

  it('subqueries.a-long-prompt-is-not-split', () => {
    const long = `${'Some context about the project. '.repeat(20)}Which did I buy first, the desk or the chair?`;
    expect(subQueries(long)).toBeUndefined();
  });
});

describe('subQueries: the last sentence', () => {
  it('subqueries.a-question-after-a-preamble', () => {
    expect(
      subQueries(
        'I am sorting out my notes. Which laptop did I buy first, the ThinkPad X1 or the MacBook Air?',
      ),
    ).toEqual(['buy ThinkPad X1', 'buy MacBook Air']);
  });

  it('subqueries.at-most-four-parts', () => {
    expect(
      subQueries('Which city did I visit first, Rome, Paris, Madrid, Berlin or Vienna?'),
    ).toBeUndefined();
  });
});
