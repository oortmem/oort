import { describe, expect, it } from 'vitest';
import { hashKey } from './keys.js';

// printf %s 'oort_sk_test' | shasum -a 256
export const HASH_VECTOR = {
  key: 'oort_sk_test',
  hash: 'f7c90a661cfeb74836b50df73b3855265a0302f829685688567366666b1dcdbb',
};

describe('hashKey', () => {
  it('is lowercase hex SHA-256 of the full key', async () => {
    expect(await hashKey(HASH_VECTOR.key)).toBe(HASH_VECTOR.hash);
  });
});
