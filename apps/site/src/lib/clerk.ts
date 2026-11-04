/** Clerk publishable key, inlined at build time. Empty means sign-in is off in this build. */
export const clerkPublishableKey: string = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? '';
export const clerkEnabled = clerkPublishableKey.startsWith('pk_');

const PLACEHOLDER_ORIGIN = 'https://oortcloud.invalid';

/**
 * Where to go after sign-in. Only same-site paths are allowed, so the link cannot send people
 * away. The value is resolved as a URL the way a browser would (which drops tabs and newlines, so
 * `/\t/evil.example` would be protocol-relative) and must keep the site's own origin.
 */
export function safeRedirect(v: unknown, fallback = '/account'): string {
  if (typeof v !== 'string' || v.length > 512) return fallback;
  if (!v.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(v)) return fallback;
  let u: URL;
  try {
    u = new URL(v, PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  if (u.origin !== PLACEHOLDER_ORIGIN) return fallback;
  // Dot segments can collapse to a protocol-relative path ("/.//evil.example" resolves to
  // "//evil.example"), and an encoded slash or backslash could be decoded into one later.
  if (/%2f|%5c/i.test(u.pathname)) return fallback;
  const out = `${u.pathname}${u.search}${u.hash}`;
  return /^\/(?![/\\])/.test(out) ? out : fallback;
}
