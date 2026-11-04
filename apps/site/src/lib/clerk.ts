/** Clerk publishable key, inlined at build time. Empty means sign-in is off in this build. */
export const clerkPublishableKey: string = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? '';
export const clerkEnabled = clerkPublishableKey.startsWith('pk_');

/** Where to go after sign-in. Only same-site paths are allowed, so the link cannot send people away. */
export function safeRedirect(v: unknown, fallback = '/account'): string {
  if (typeof v !== 'string' || v.length > 512) return fallback;
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return fallback;
  return v;
}
