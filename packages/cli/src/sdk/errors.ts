import { MissingCredentialError } from '@oortmem/core';
import { OortCloudError } from '../cloud.js';
import { describeError } from '../describe-error.js';
import { PROVIDER_ENV } from '../keychain.js';
import { OortRelayError } from '../relay.js';
import { Refusal } from '../util.js';

/**
 * The SDK's errors (CON-108 §5): the ten `oort.v1` codes as classes, each with a stable `reason`.
 * Built on the CLI's `describeError` (one table for both), without its CLI-only fixes (`--yes`,
 * `oort --help`). Messages name fields, never their values, and never carry a key.
 */

export type OortErrorCode =
  | 'usage'
  | 'not-found'
  | 'ambiguous-id'
  | 'needs-key'
  | 'needs-login'
  | 'needs-confirmation'
  | 'cloud-only'
  | 'network'
  | 'refused'
  | 'internal';

export interface OortErrorOptions {
  fix?: string | null;
  reason?: string;
  status?: number;
  retryable?: boolean;
  retryAfter?: number;
}

export class OortError extends Error {
  readonly code: OortErrorCode;
  /** A runnable `oort …` command where one fixes it, else null. */
  readonly fix: string | null;
  /** A finer, stable string (`principal-required`, `daily-limit`, …). */
  readonly reason?: string;
  /** The HTTP status (cloud). */
  readonly status?: number;
  readonly retryable: boolean;
  /** Seconds the service asked to wait before a retry (`Retry-After`), when it said. */
  readonly retryAfter?: number;

  constructor(code: OortErrorCode, message: string, opts: OortErrorOptions = {}) {
    super(message);
    this.name = 'OortError';
    this.code = code;
    this.fix = opts.fix ?? null;
    if (opts.reason !== undefined) this.reason = opts.reason;
    if (opts.status !== undefined && opts.status > 0) this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    if (opts.retryAfter !== undefined) this.retryAfter = opts.retryAfter;
  }
}

export class OortUsageError extends OortError {
  constructor(message: string, opts: OortErrorOptions = {}) {
    super('usage', message, opts);
    this.name = 'OortUsageError';
  }
}
export class OortNotFoundError extends OortError {
  constructor(message: string, opts: OortErrorOptions = {}) {
    super('not-found', message, opts);
    this.name = 'OortNotFoundError';
  }
}
export class OortAmbiguousIdError extends OortError {
  constructor(message: string, opts: OortErrorOptions = {}) {
    super('ambiguous-id', message, opts);
    this.name = 'OortAmbiguousIdError';
  }
}
export type ModelRole = 'embed' | 'rerank' | 'decide' | 'write';
export class OortNeedsKeyError extends OortError {
  readonly role: ModelRole;
  /** The environment variable that would supply the key. */
  readonly envVar: string;
  constructor(message: string, role: ModelRole, envVar: string, opts: OortErrorOptions = {}) {
    super('needs-key', message, { reason: 'missing-key', ...opts });
    this.name = 'OortNeedsKeyError';
    this.role = role;
    this.envVar = envVar;
  }
}
export class OortNeedsLoginError extends OortError {
  constructor(message: string, opts: OortErrorOptions = {}) {
    super('needs-login', message, { fix: 'oort login', ...opts });
    this.name = 'OortNeedsLoginError';
  }
}
export class OortNeedsConfirmationError extends OortError {
  constructor(message: string, opts: OortErrorOptions = {}) {
    super('needs-confirmation', message, opts);
    this.name = 'OortNeedsConfirmationError';
  }
}
export class OortCloudOnlyError extends OortError {
  constructor(message: string, opts: OortErrorOptions = {}) {
    super('cloud-only', message, opts);
    this.name = 'OortCloudOnlyError';
  }
}
export class OortNetworkError extends OortError {
  constructor(message: string, opts: OortErrorOptions = {}) {
    super('network', message, { retryable: true, ...opts });
    this.name = 'OortNetworkError';
  }
}
export class OortRefusedError extends OortError {
  constructor(message: string, opts: OortErrorOptions = {}) {
    super('refused', message, opts);
    this.name = 'OortRefusedError';
  }
}
export class OortInternalError extends OortError {
  constructor(message: string, opts: OortErrorOptions = {}) {
    super('internal', message, opts);
    this.name = 'OortInternalError';
  }
}

const ROLE_ENV: Record<ModelRole, string> = {
  embed: PROVIDER_ENV.voyage,
  rerank: PROVIDER_ENV.voyage,
  decide: PROVIDER_ENV.typesafe,
  write: PROVIDER_ENV.anthropic,
};

/** The role a `MissingCredentialError` is for, from its config key (`writer.apiKey` is `write`). */
function roleOf(configKey: string): ModelRole {
  const section = configKey.split('.')[0];
  if (section === 'writer') return 'write';
  return section === 'embed' || section === 'rerank' || section === 'decide' ? section : 'embed';
}

/** The fix a role's missing key takes: free local models for embed and rerank, else a vendor key. */
export function keyFix(role: ModelRole): string {
  if (role === 'embed' || role === 'rerank') return 'oort models pull';
  return `oort keys set ${role === 'decide' ? 'typesafe' : 'anthropic'}`;
}

export function needsKey(role: ModelRole, what: string): OortNeedsKeyError {
  return new OortNeedsKeyError(
    `${what} needs the ${role} model, and no key or local model serves it.`,
    role,
    ROLE_ENV[role],
    { fix: keyFix(role) },
  );
}

/** A fix the CLI offers that an SDK caller cannot run: "the same again with --yes", `oort --help`. */
function sdkFix(fix: string | null): string | null {
  if (fix === null || fix === '' || fix.includes('--yes') || fix.startsWith('oort --help'))
    return null;
  return fix;
}

/** A safe class name for a message: letters and digits only. */
const safeName = (e: Error): string => e.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 64) || 'Error';

/** Oort Cloud's refusal as its SDK class, with the reason its kind and the API's code give. */
function fromCloud(e: OortCloudError): OortError {
  const info = describeError(e, () => '');
  const opts = {
    fix: sdkFix(info.fix),
    status: e.status,
    ...(e.retryAfterSec !== undefined && { retryAfter: e.retryAfterSec }),
  };
  switch (e.kind) {
    case 'unauthorized':
      return new OortNeedsLoginError(e.message, {
        ...opts,
        fix: 'oort login',
        reason: 'key-rejected',
      });
    case 'rate-limit':
      // A limit that passes with time: retry later (after `retryAfter` when the API says).
      return new OortRefusedError(e.message, { ...opts, reason: e.kind, retryable: true });
    case 'payment-required':
    case 'not-enabled':
    case 'hive-not-enabled':
      return new OortRefusedError(e.message, { ...opts, reason: e.kind });
    case 'refused':
      return new OortRefusedError(e.message, { ...opts, reason: 'forbidden' });
    case 'too-large':
      return new OortUsageError(e.message, { ...opts, reason: 'too-large' });
    case 'not-found':
      return new OortNotFoundError(e.message, opts);
    case 'ambiguous-prefix':
      return new OortAmbiguousIdError(e.message, opts);
    case 'busy':
      return new OortNetworkError(e.message, { ...opts, reason: 'busy' });
    case 'network':
      return new OortNetworkError(e.message, {
        ...opts,
        reason: e.apiCode === 'timeout' ? 'timeout' : 'unreachable',
      });
    case 'bad-request':
      // Defined here: the CLI reads every 409 but `ambiguous` as a bad request.
      if (e.status === 409 && e.apiCode === 'preview_required')
        return new OortNeedsConfirmationError(e.message, { ...opts, reason: 'preview-required' });
      if (e.status === 409 && e.apiCode === 'findings_unacknowledged')
        return new OortNeedsConfirmationError(e.message, {
          ...opts,
          reason: 'findings-unacknowledged',
        });
      if (e.apiCode === 'scope_denied')
        return new OortRefusedError(e.message, { ...opts, reason: 'scope-denied' });
      return new OortUsageError(e.message, { ...opts, reason: 'bad-request' });
  }
}

/**
 * Any error as an `OortError`. An `OortError` passes through. Engine refusals keep their message
 * (it holds no input values); vendor and unknown errors keep their class name only, never a
 * message or cause that could echo an option or a key.
 */
export function toOortError(e: unknown): OortError {
  if (e instanceof OortError) return e;
  if (e instanceof OortCloudError) return fromCloud(e);
  const err = e instanceof Error ? e : new Error('non-error thrown');
  if (err instanceof MissingCredentialError) {
    const role = roleOf(err.configKey);
    return new OortNeedsKeyError(err.message, role, err.envVar, { fix: keyFix(role) });
  }
  if (err.name === 'StoreMigrationRequiredError') {
    return new OortRefusedError(
      'The store needs a migration and migrate is false; run `oort doctor`, or create the handle with migrate: true.',
      { fix: 'oort doctor', reason: 'migration-required' },
    );
  }
  if ((err as { code?: unknown }).code === 'SQLITE_BUSY') {
    return new OortInternalError('The local store stayed locked by another process; try again.', {
      reason: 'store-busy',
      retryable: true,
    });
  }
  if (err.name === 'EmbedderMismatchError') {
    return new OortUsageError(err.message, { fix: 'oort reembed', reason: 'embedder-mismatch' });
  }
  if (err.name === 'GrantError' || err.name === 'ScopeDeniedError') {
    return new OortRefusedError(err.message, { reason: 'scope-denied' });
  }
  if (err.name === 'JudgmentInputError' || err.name === 'ExportFormatError') {
    return new OortUsageError(err.message, { reason: 'invalid-argument' });
  }
  const own = err instanceof Refusal || err instanceof OortRelayError;
  const info = describeError(err, () => '');
  const fix = sdkFix(info.fix);
  if (err instanceof OortRelayError) {
    if (err.kind === 'unauthorized')
      return new OortNeedsLoginError(err.message, { reason: 'key-rejected', status: err.status });
    const after = err.retryAfterSec === undefined ? {} : { retryAfter: err.retryAfterSec };
    if (err.kind === 'busy')
      return new OortNetworkError(err.message, {
        reason: 'busy',
        status: err.status,
        fix,
        ...after,
      });
    return new OortRefusedError(err.message, {
      reason: err.kind,
      status: err.status,
      fix,
      ...after,
      ...(err.kind === 'rate-limit' && { retryable: true }),
    });
  }
  if (own) {
    const reason = err.message.startsWith('scope_denied') ? 'scope-denied' : undefined;
    const opts = { fix, ...(reason !== undefined && { reason }) };
    switch (info.code) {
      case 'usage':
        return new OortUsageError(err.message, opts);
      case 'not-found':
        return new OortNotFoundError(err.message, opts);
      case 'ambiguous-id':
        return new OortAmbiguousIdError(err.message, opts);
      case 'needs-login':
        return new OortNeedsLoginError(err.message, { ...opts, reason: 'no-key' });
      case 'needs-confirmation':
        return new OortNeedsConfirmationError(err.message, opts);
      case 'cloud-only':
        return new OortCloudOnlyError(err.message, opts);
      case 'network':
        return new OortNetworkError(err.message, opts);
      case 'refused':
        return new OortRefusedError(err.message, opts);
      case 'needs-key':
        return new OortNeedsKeyError(err.message, 'write', ROLE_ENV.write, opts);
      case 'internal':
        return new OortInternalError(err.message, opts);
    }
  }
  if (info.code === 'network') {
    return new OortNetworkError(`Could not reach a model or Oort service (${safeName(err)}).`, {
      reason: 'unreachable',
    });
  }
  return new OortInternalError(`An internal error stopped this call (${safeName(err)}).`);
}
