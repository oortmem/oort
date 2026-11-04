import { describe, expect, it } from 'vitest';
import { MissingCredentialError } from './errors.js';

describe('errors', () => {
  it('missing-credential.message-names-fix', () => {
    const e = new MissingCredentialError('VOYAGE_API_KEY', 'embed.apiKey');
    // Keys stay out of the plaintext config file by design: only the env var is named.
    expect(e.message).toBe(
      'Missing VOYAGE_API_KEY. Set it with: oort keys set voyage (or export VOYAGE_API_KEY=...)',
    );
    expect(e.configKey).toBe('embed.apiKey');
  });
});
