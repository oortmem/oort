/** Every Oort API key starts with this. */
export const KEY_PREFIX = 'oort_sk_';

/** Lowercase hex SHA-256 of the full key. D1 stores only this, never the key. */
export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
