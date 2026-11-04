// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { hashKey as relayHash } from '../../../../relay/src/keys';
import { generateKey, hashKey, keyPrefix } from '@/server/keys';

describe('API keys', () => {
  it('look like oort_sk_ plus 43 url-safe characters', () => {
    const k = generateKey();
    expect(k).toMatch(/^oort_sk_[A-Za-z0-9_-]{43}$/);
    expect(generateKey()).not.toBe(k);
  });
  it('display by a 12-character prefix', () => {
    expect(keyPrefix('oort_sk_abcdefghijk')).toBe('oort_sk_abcd');
  });
  it('hash exactly as the relay does', async () => {
    const k = generateKey();
    expect(await hashKey(k)).toBe(await relayHash(k));
    expect(await hashKey('oort_sk_test')).toBe(
      'f7c90a661cfeb74836b50df73b3855265a0302f829685688567366666b1dcdbb',
    );
  });
});
