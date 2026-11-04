/** Every Oort API key starts with this (the relay rejects anything else). */
export const KEY_PREFIX = 'oort_sk_';
const PREFIX_LENGTH = 12;

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A new key: `oort_sk_` plus 32 random bytes, base64url. Shown to the user once. */
export function generateKey(): string {
  return KEY_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** What the account page shows instead of the key. */
export function keyPrefix(key: string): string {
  return key.slice(0, PREFIX_LENGTH);
}

/** Lowercase hex SHA-256, identical to apps/relay/src/keys.ts. D1 stores only this. */
export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** RFC 8628's suggested user-code alphabet: consonants only, so no look-alikes and no words. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const USER_CODE_LENGTH = 8;

/** A new `oort login` user code, 8 letters drawn without bias (stored without the dash). */
export function generateUserCode(): string {
  let out = '';
  while (out.length < USER_CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      // 240 is the largest multiple of 20 under 256: rejecting the rest keeps every letter equal.
      if (b < 240 && out.length < USER_CODE_LENGTH) out += USER_CODE_ALPHABET[b % 20];
    }
  }
  return out;
}

/** How the terminal and the page show a code: XXXX-XXXX. */
export const formatUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

/** What the user typed, as a stored code: case, spaces and dashes ignored; null when not a code. */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  const c = input.toUpperCase().replace(/[\s-]/g, '');
  const ok = c.length === USER_CODE_LENGTH && [...c].every((x) => USER_CODE_ALPHABET.includes(x));
  return ok ? c : null;
}

/** base64url without padding for 32 bytes is 43 characters. */
export const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The challenge for a CLI secret: base64url(SHA-256(S)) over the 32 raw bytes of S, which the
 * CLI sends as base64url. Null when `secret` is not 32 bytes of base64url.
 */
export async function challengeOf(secret: unknown): Promise<string | null> {
  if (typeof secret !== 'string' || !CHALLENGE.test(secret)) return null;
  const bin = atob(secret.replace(/-/g, '+').replace(/_/g, '/') + '=');
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  if (bytes.length !== 32) return null;
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
