/**
 * The only logging in the site (review I6). Workers invocation logs are off, so this line is all
 * Cloudflare keeps: a status and, when known, how long the request took. Never an error message,
 * stack, URL, header, IP or body, since any of them can carry personal data.
 */
export function logStatus(status: number, ms?: number): void {
  console.error(JSON.stringify(ms === undefined ? { status } : { status, ms }));
}
