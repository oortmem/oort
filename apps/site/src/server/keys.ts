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
