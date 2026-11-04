import { describe, expect, it } from 'vitest';
import { tokenizeLexical } from './index.js';

describe('tokenizeLexical', () => {
  it('tokenize.keeps-joiners-inside-and-trims-ends', () => {
    expect(tokenizeLexical('Route via auth-service-8080, port 8080. See node.js_v2!')).toEqual([
      'route',
      'via',
      'auth-service-8080',
      'port',
      '8080',
      'see',
      'node.js_v2',
    ]);
  });

  it('tokenize.drops-operators-and-quotes', () => {
    expect(tokenizeLexical('"foo" OR bar* a"b --- ((')).toEqual(['foo', 'or', 'bar', 'a', 'b']);
    expect(tokenizeLexical('')).toEqual([]);
  });
});
