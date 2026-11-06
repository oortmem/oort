import { MissingCredentialError } from '@oortmem/core';
import { OortCloudError, type CloudErrorKind } from './cloud.js';
import { OortRelayError } from './relay.js';
import { PROVIDER_ENV, type Provider } from './keychain.js';
import { Refusal, shown, type ErrorCode } from './util.js';

/**
 * How an error becomes an `oort.v1` error (docs/cli.md, "JSON output"), with no terminal and no
 * commander, so the CLI (output.ts) and the SDK (src/sdk/errors.ts) share one table (CON-107,
 * CON-108).
 */

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  /** A command that fixes it, or null where none does. */
  fix: string | null;
  exitCode: number;
  /**
   * `true` when trying the same again later can succeed: a network failure, a service that is
   * busy or down, a rate limit, a store locked by another process. Absent otherwise (optional and
   * additive, as `OortError.retryable` is for the SDK).
   */
  retryable?: true;
  /** Seconds the service asked to wait (its `Retry-After`), when it sent one. */
  retryAfter?: number;
}

const shownOrNull = (fix: string | undefined): string | null =>
  fix === undefined ? null : shown(fix);

/**
 * The first runnable `oort …` command quoted in a message (`` `oort login` ``), skipping ones with
 * placeholders (`<id>`, `…`): the fix most refusals already name.
 */
export function fixInMessage(message: string): string | undefined {
  for (const m of message.matchAll(/`(oort [^`]+)`/g)) {
    const c = m[1]!;
    if (!/[<>…]|\.\.\./.test(c)) return c;
  }
  return undefined;
}

const CLOUD_CODE: Record<CloudErrorKind, ErrorCode> = {
  unauthorized: 'needs-login',
  'payment-required': 'refused',
  'not-enabled': 'refused',
  'hive-not-enabled': 'refused',
  'rate-limit': 'refused',
  'too-large': 'usage',
  'not-found': 'not-found',
  'ambiguous-prefix': 'ambiguous-id',
  'bad-request': 'usage',
  busy: 'network',
  refused: 'refused',
  network: 'network',
};

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** A connection that failed (refused, reset, DNS, timeout), from fetch or a socket. */
export function isNetworkError(e: Error): boolean {
  const cause = (e as { cause?: { code?: unknown } }).cause;
  const code = (e as { code?: unknown }).code ?? cause?.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  return e.name === 'TypeError' && e.message === 'fetch failed';
}

const ENV_PROVIDER = Object.fromEntries(
  Object.entries(PROVIDER_ENV).map(([p, v]) => [v, p as Provider]),
) as Record<string, Provider | undefined>;

/** Error names (other packages' classes) that are a problem with the input, not a bug. */
const USAGE_ERRORS = new Set([
  'JudgmentInputError',
  'JudgmentPackError',
  'ExportFormatError',
  'EmbedderMismatchError',
]);
const REFUSED_ERRORS = new Set(['GrantError', 'ScopeDeniedError']);

/**
 * Every error but commander's (output.ts handles those) as its `oort.v1` code, fix and exit code:
 * the CLI's refusals (`Refusal` and its `code`), Oort Cloud and relay refusals by kind, a missing
 * key, network failures, and anything else as `internal`. `rerun` gives the "again with --yes"
 * fix for the command that ran. No terminal, no commander: the SDK builds its errors on this.
 */
export function describeError(e: unknown, rerun: (flag: string) => string): ErrorInfo {
  const err = e instanceof Error ? e : new Error(String(e));
  // Exit codes stay as docs/cli.md has them: 2 for the CLI's own refusals and usage errors (1
  // for one coded `internal`), 1 for anything raised outside them (an adapter's relay or key
  // error, a network failure), whatever its code.
  const own = err instanceof Refusal;
  const make = (
    code: ErrorCode,
    message: string,
    fix?: string,
    exitCode?: number,
    retry: { retryable?: boolean; retryAfter?: number | undefined } = {},
  ): ErrorInfo => ({
    code,
    message,
    fix: shownOrNull(fix ?? fixInMessage(message)),
    exitCode: exitCode ?? (own && code !== 'internal' ? 2 : 1),
    // As the SDK's errors: every network error is retryable, and so is a rate limit.
    ...((retry.retryable === true || code === 'network') && { retryable: true as const }),
    ...(retry.retryAfter !== undefined && { retryAfter: retry.retryAfter }),
  });
  if (err instanceof OortCloudError) {
    return make(CLOUD_CODE[err.kind], err.message, undefined, undefined, {
      retryable: err.kind === 'rate-limit',
      retryAfter: err.retryAfterSec,
    });
  }
  if (err instanceof Refusal) {
    const fix = err.fix ?? (err.code === 'needs-confirmation' ? rerun('--yes') : undefined);
    return make(err.code, err.message, fix, err.exitCode);
  }
  if (err instanceof OortRelayError) {
    const code: ErrorCode =
      err.kind === 'unauthorized' ? 'needs-login' : err.kind === 'busy' ? 'network' : 'refused';
    return make(code, err.message, code === 'needs-login' ? 'oort login' : undefined, undefined, {
      retryable: err.kind === 'rate-limit',
      retryAfter: err.retryAfterSec,
    });
  }
  if (err instanceof MissingCredentialError) {
    const provider = ENV_PROVIDER[err.envVar];
    return make(
      'needs-key',
      err.message,
      provider === 'voyage'
        ? 'oort models pull'
        : provider !== undefined
          ? `oort keys set ${provider}`
          : undefined,
    );
  }
  if (USAGE_ERRORS.has(err.name)) return make('usage', err.message);
  if (REFUSED_ERRORS.has(err.name)) return make('refused', err.message);
  if (isNetworkError(err)) return make('network', err.message);
  // The local store stayed locked by another process: the SDK's `store-busy`, retryable.
  if ((err as { code?: unknown }).code === 'SQLITE_BUSY') {
    return make('internal', err.message, undefined, undefined, { retryable: true });
  }
  return make('internal', err.message);
}
