import type { Env } from './io.js';

/**
 * The Oort Pro relay, as the CLI sees it: where it is, which models it
 * serves, and what its refusals mean. The relay itself is `apps/relay`; the
 * contract test in `relay.test.ts` runs the adapters against its handler.
 */

export const DEFAULT_RELAY_URL = 'https://relay.oortcloud.dev';
export const ACCOUNT_URL = 'https://oortcloud.dev/account';
/** Where an Oort key is revoked; `oort logout` never revokes one itself. */
export const REVOKE_HINT = 'revoke it at oortcloud.dev/account';

/** Each adapter's root under the relay (the paths `apps/relay` routes). */
export const RELAY_PATHS = {
  voyage: '/v1/voyage',
  typesafe: '/v1/typesafe',
  anthropic: '/v1/anthropic/v1',
} as const;

/** The models the relay allows (`MODELS` in apps/relay/src/relay.ts; a test keeps them equal). */
export const RELAY_MODELS = {
  embed: ['voyage-3.5-lite'],
  rerank: ['rerank-3-lite', 'rerank-2.5-lite'],
  write: ['claude-haiku-5-5'],
} as const;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The relay root: `OORT_RELAY_URL` when set and non-empty (for local dev
 * against `wrangler dev`), else `DEFAULT_RELAY_URL`. Only https, or http to a
 * loopback host, is accepted: the Oort key travels in every request.
 */
export function relayUrl(env: Env): { url: string } | { error: string } {
  const raw = env['OORT_RELAY_URL'];
  if (raw === undefined || raw === '') return { url: DEFAULT_RELAY_URL };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'OORT_RELAY_URL is not a URL; unset it to use the Oort Pro relay.' };
  }
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  if (!ok || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
    return {
      error:
        'OORT_RELAY_URL must be an https URL (or http to localhost) with no credentials or query; unset it to use the Oort Pro relay.',
    };
  }
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

export type RelayErrorKind = 'unauthorized' | 'payment-required' | 'rate-limit' | 'busy';

/**
 * A relay refusal the user can act on, in the same shape as
 * `MissingCredentialError`: one line that says what happened and the fix.
 * It never carries the key, the request or the relay's own body.
 */
/**
 * A `Retry-After` header as whole seconds from now (delta seconds, or an HTTP date); undefined
 * when absent or unreadable.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/** `Retry-After` from an adapter error's response headers (a `Headers` or a plain record). */
function retryAfterOf(e: unknown): number | undefined {
  const h = (e as { headers?: unknown } | null)?.headers;
  if (h === undefined || h === null) return undefined;
  const raw =
    typeof (h as Headers).get === 'function'
      ? (h as Headers).get('retry-after')
      : (h as Record<string, unknown>)['retry-after'];
  return parseRetryAfter(typeof raw === 'string' ? raw : undefined);
}

export class OortRelayError extends Error {
  readonly kind: RelayErrorKind;
  readonly status: number;
  /** Seconds the relay asked to wait (its `Retry-After`), when it said. */
  readonly retryAfterSec: number | undefined;

  /**
   * `relayMessage` is the relay's own line for a 429 (the monthly cap says which pool and when it
   * resets, a rate limit says per key or per account), as the adapters keep it; without one the
   * message is the generic 429 text. `busy` is the relay's 503: a provider is rate-limited or
   * failing for every Pro user, so it is never this account's cap.
   */
  constructor(kind: RelayErrorKind, status: number, relayMessage?: string, retryAfterSec?: number) {
    super(
      kind === 'busy'
        ? `Oort Pro is busy, try again shortly (HTTP ${status}).`
        : kind === 'rate-limit' && relayMessage !== undefined
          ? `Oort Pro limit reached (HTTP 429): ${relayMessage}${relayMessage.includes(ACCOUNT_URL) ? '' : ` Usage is at ${ACCOUNT_URL}.`}`
          : kind === 'payment-required'
            ? `Oort Pro is not active on this account (HTTP 402). Subscribe or update billing at ${ACCOUNT_URL}, or set your own keys with \`oort keys set <provider>\`.`
            : kind === 'rate-limit'
              ? `Oort Pro limit reached (HTTP 429): too many requests in 10 seconds, or this month's included use is used up. Usage is at ${ACCOUNT_URL}.`
              : `The relay rejected the Oort key (HTTP 401): it is unknown or revoked. Run \`oort login\` again, or create a key at ${ACCOUNT_URL}.`,
    );
    this.name = 'OortRelayError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/** The relay error an adapter error stands for (adapters keep the HTTP status), if any. */
export function relayErrorOf(e: unknown): OortRelayError | undefined {
  if (e instanceof OortRelayError) return e;
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 402) return new OortRelayError('payment-required', 402);
  if (status === 429) {
    const msg = (e as { relayMessage?: unknown }).relayMessage;
    return new OortRelayError(
      'rate-limit',
      429,
      typeof msg === 'string' ? msg : undefined,
      retryAfterOf(e),
    );
  }
  if (status === 401 || status === 403) return new OortRelayError('unauthorized', status);
  if (status === 503) return new OortRelayError('busy', 503, undefined, retryAfterOf(e));
  return undefined;
}

/**
 * `adapter` with every method's 401, 402, 429 and 503 rethrown as an
 * `OortRelayError`, reported to `onError` as well. Other errors pass through
 * unchanged, so callers that fail soft (recall, hooks) still do.
 */
export function viaRelay<T extends object>(adapter: T, onError: (e: OortRelayError) => void): T {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } catch (e) {
          const r = relayErrorOf(e);
          if (r === undefined) throw e;
          onError(r);
          throw r;
        }
      };
    },
  });
}
