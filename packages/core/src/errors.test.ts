import { describe, expect, it } from 'vitest';
import { MissingCredentialError } from './errors.js';

describe('errors', () => {
  it('missing-credential.message-names-fix', () => {
    const e = new MissingCredentialError('VOYAGE_API_KEY', 'embed.apiKey');
    expect(e.message).toBe(
      'Missing VOYAGE_API_KEY. Set it with: export VOYAGE_API_KEY=... (or set embed.apiKey in ~/.oort/config.json).',
    );
  });
});
