import { describe, expect, it } from 'vitest';
import { beaconScripts, beaconToken } from '@/lib/analytics';

describe('Cloudflare Web Analytics beacon', () => {
  it('loads nothing without a token', () => {
    expect(beaconScripts('')).toEqual([]);
    expect(beaconScripts('   ')).toEqual([]);
  });
  it('adds one script with the token when set', () => {
    const [s] = beaconScripts('abc123');
    expect(s?.src).toContain('cloudflareinsights.com');
    expect(s?.['data-cf-beacon']).toBe('{"token":"abc123"}');
  });
  it('has no token in dev and tests', () => {
    expect(beaconToken).toBe('');
  });
});
