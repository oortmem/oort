// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AccountError, NotSignedIn } from '@/server/account';
import { toResult } from '@/server/result';

describe('toResult', () => {
  it('wraps a value', async () => {
    expect(await toResult(async () => 3)).toEqual({ ok: true, value: 3 });
  });
  it('marks a signed-out request', async () => {
    expect(
      await toResult(async () => {
        throw new NotSignedIn();
      }),
    ).toEqual({ ok: false, error: 'Sign in to continue.', signedOut: true });
  });
  it('passes a plain refusal message through', async () => {
    expect(
      await toResult(async () => {
        throw new AccountError('Billing is not set up yet.');
      }),
    ).toEqual({ ok: false, error: 'Billing is not set up yet.' });
  });
  it('hides unexpected error details', async () => {
    const r = await toResult(async () => {
      throw new Error('D1_ERROR: no such table accounts; secret sk_live_123');
    });
    expect(r).toEqual({ ok: false, error: 'Something went wrong. Please try again.' });
  });
});
