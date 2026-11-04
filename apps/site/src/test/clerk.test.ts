import { describe, expect, it } from 'vitest';
import { safeRedirect } from '@/lib/clerk';

describe('safeRedirect', () => {
  it('keeps same-site paths', () => {
    expect(safeRedirect('/account?subscribe=pro')).toBe('/account?subscribe=pro');
    expect(safeRedirect('/account/cli')).toBe('/account/cli');
    expect(safeRedirect('/docs/pro#login')).toBe('/docs/pro#login');
  });
  it('falls back to /account for anything that could leave the site', () => {
    for (const v of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/%09/x\u0000',
      'account',
      42,
    ]) {
      expect(safeRedirect(v)).toBe('/account');
    }
    expect(safeRedirect(undefined)).toBe('/account');
  });
});
