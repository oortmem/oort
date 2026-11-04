import { AccountError, NotSignedIn } from './account';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; signedOut?: true };

/**
 * Runs an account action and turns refusals into plain messages for the page. Unexpected errors
 * become a generic message, so no internal detail reaches the browser.
 */
export async function toResult<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    if (e instanceof NotSignedIn) return { ok: false, error: e.message, signedOut: true };
    if (e instanceof AccountError) return { ok: false, error: e.message };
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
