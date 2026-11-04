import { describe, expect, it } from 'vitest';
import { safeRedirect } from '@/lib/clerk';

describe('safeRedirect', () => {
  it('keeps same-site paths', () => {
    expect(safeRedirect('/account/cli?session=abc')).toBe('/account/cli?session=abc');
  });
  it('falls back to /account for anything that could leave the site', () => {
    for (const v of ['https://evil.example', '//evil.example', '/\\evil.example', 'account', 42]) {
      expect(safeRedirect(v)).toBe('/account');
    }
    expect(safeRedirect(undefined)).toBe('/account');
  });
});
