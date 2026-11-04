import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Memory, RecallMode, RecallResult, Tier } from '@oortmem/core';
import type { Env } from './io.js';
import { ACCOUNT_URL } from './relay.js';
import { Refusal, writeOwnerOnly } from './util.js';

/**
 * Oort Cloud, as the CLI sees it: where the API is, which store this machine uses, and what the
 * API's refusals mean. The API itself lives in the private oortcloud repo (apps/cloud); the routes
 * and shapes the CLI relies on are pinned in `test/cloud-contract.json`.
 */

export const DEFAULT_CLOUD_URL = 'https://api.oortcloud.dev';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The API root: `OORT_CLOUD_URL` when set and non-empty (local dev against `wrangler dev`), else
 * `DEFAULT_CLOUD_URL`. Only https, or http to a loopback host: the Oort key travels in every
 * request.
 */
export function cloudUrl(env: Env): { url: string } | { error: string } {
  const raw = env['OORT_CLOUD_URL'];
  if (raw === undefined || raw === '') return { url: DEFAULT_CLOUD_URL };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'OORT_CLOUD_URL is not a URL; unset it to use Oort Cloud.' };
  }
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  if (!ok || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
    return {
      error:
        'OORT_CLOUD_URL must be an https URL (or http to localhost) with no credentials or query; unset it to use Oort Cloud.',
    };
  }
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

// ---------------------------------------------------------------------------------------------
// Which store this machine uses. A home-directory file the CLI owns, never a repo file: a cloned
// repository must not be able to send memories anywhere.

export type StoreMode = 'local' | 'cloud';

export interface ImportProgress {
  /** A fingerprint of the export being uploaded (count and first and last id). */
  fingerprint: string;
  /** Memory lines already accepted by the cloud. */
  done: number;
  total: number;
  updatedAt: string;
}

export interface CloudSettings {
  store: StoreMode;
  import?: ImportProgress;
}

export const cloudSettingsPath = (home: string): string => path.join(home, 'cloud.json');

export function readCloudSettings(home: string): CloudSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(cloudSettingsPath(home), 'utf8'));
  } catch {
    return { store: 'local' };
  }
  const r = raw as { store?: unknown; import?: unknown } | null;
  const store: StoreMode = r?.store === 'cloud' ? 'cloud' : 'local';
  const imp = r?.import as Partial<ImportProgress> | undefined;
  const progress =
    imp !== undefined &&
    typeof imp.fingerprint === 'string' &&
    typeof imp.done === 'number' &&
    typeof imp.total === 'number'
      ? {
          fingerprint: imp.fingerprint,
          done: imp.done,
          total: imp.total,
          updatedAt: typeof imp.updatedAt === 'string' ? imp.updatedAt : '',
        }
      : undefined;
  return { store, ...(progress !== undefined && { import: progress }) };
}

export function writeCloudSettings(home: string, s: CloudSettings): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  writeOwnerOnly(cloudSettingsPath(home), `${JSON.stringify(s, null, 2)}\n`, true);
}

// ---------------------------------------------------------------------------------------------
// Errors.

export type CloudErrorKind =
  | 'unauthorized'
  | 'payment-required'
  | 'not-enabled'
  | 'rate-limit'
  | 'too-large'
  | 'not-found'
  | 'ambiguous-prefix'
  | 'bad-request'
  | 'busy'
  | 'network';

/** Kinds the account has to fix, or that pass with time: a hook's queue waits instead. */
const HOLD: ReadonlySet<CloudErrorKind> = new Set([
  'unauthorized',
  'payment-required',
  'not-enabled',
  'rate-limit',
  'busy',
  'network',
]);

/**
 * A refusal from Oort Cloud the user can act on: one line saying what happened and the fix. It
 * never carries the key or the request. The API's own message is used where it explains a limit
 * (the monthly cap says which and when it resets).
 */
export class OortCloudError extends Refusal {
  readonly kind: CloudErrorKind;
  readonly status: number;
  /** The drain keeps the line queued instead of counting an attempt. */
  readonly holdQueue: boolean;

  constructor(kind: CloudErrorKind, status: number, apiMessage?: string) {
    super(messageFor(kind, status, apiMessage));
    this.name = 'OortCloudError';
    this.kind = kind;
    this.status = status;
    this.holdQueue = HOLD.has(kind);
  }
}

function messageFor(kind: CloudErrorKind, status: number, api?: string): string {
  switch (kind) {
    case 'unauthorized':
      return `Oort Cloud rejected the Oort key (HTTP ${status}): it is unknown or revoked. Run \`oort login\` again.`;
    case 'payment-required':
      return `Oort Pro is not active on this account (HTTP 402). Subscribe or update billing at ${ACCOUNT_URL}, or run \`oort cloud use --local\`. \`oort cloud export\` still works.`;
    case 'not-enabled':
      return 'Oort Cloud is not enabled for this account yet (HTTP 403). Your memories stay on this machine; run `oort cloud use --local`.';
    case 'rate-limit':
      return `Oort Cloud limit reached (HTTP 429)${api !== undefined ? `: ${api}` : '.'} Usage is at ${ACCOUNT_URL}.`;
    case 'too-large':
      return `Oort Cloud refused a request that is too large (HTTP 413)${api !== undefined ? `: ${api}` : '.'}`;
    case 'not-found':
      return 'No such memory in Oort Cloud.';
    case 'ambiguous-prefix':
      return 'That id prefix matches more than one memory in Oort Cloud; give more of the id.';
    case 'bad-request':
      return `Oort Cloud refused the request (HTTP ${status})${api !== undefined ? `: ${api}` : '.'}`;
    case 'busy':
      return `Oort Cloud is busy or down, try again shortly (HTTP ${status}).`;
    case 'network':
      return 'Oort Cloud is unreachable: check your network, then try again.';
  }
}

/** The kind an API status (and `{ error: { code } }`) stands for. */
export function cloudErrorKind(status: number, code?: string): CloudErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 402) return 'payment-required';
  if (status === 403) return code === 'cloud_not_enabled' ? 'not-enabled' : 'unauthorized';
  if (status === 404) return 'not-found';
  if (status === 409 && code === 'ambiguous') return 'ambiguous-prefix';
  if (status === 413) return 'too-large';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'busy';
  return 'bad-request';
}

// ---------------------------------------------------------------------------------------------
// The client.

export type CloudMemory = Omit<Memory, 'embedding'>;

export interface CloudStats {
  tiers: Record<Tier, number>;
  memories: number;
  databaseBytes: number;
  lastConsolidatedAt: string | null;
}

export interface CloudObservation {
  user: string;
  assistant: string;
  at?: string;
  session?: string;
  tools?: string[];
}

export interface CloudObserveResult {
  outcome: string;
  memories: { id?: string; action: string }[];
  counts: Record<string, number>;
  /** The turnRef was seen before: the turn is already saved and nothing was done. */
  duplicate?: true;
}

export interface CloudImportResult {
  imported: number;
  skipped: number;
  reembedded: number;
  next?: number;
}

export interface CloudClient {
  readonly url: string;
  whoami(): Promise<{ account: string; plan: string; via: string }>;
  recall(q: {
    text: string;
    project?: string;
    k?: number;
    asOf?: string;
    knownAt?: string;
    mode?: RecallMode;
  }): Promise<RecallResult>;
  /** `turnRef` makes a retry safe: the API saves each turn once and answers `duplicate`. */
  observe(b: {
    project?: string;
    observation: CloudObservation;
    turnRef?: string;
  }): Promise<CloudObserveResult>;
  list(q?: {
    project?: string;
    tier?: Tier;
    type?: string;
    q?: string;
    pinned?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<{ memories: CloudMemory[]; next?: string }>;
  /** By id, or by a unique prefix of at least 8 characters (409 `ambiguous` when several match). */
  get(ref: string): Promise<CloudMemory>;
  forget(id: string): Promise<void>;
  pin(id: string, pinned: boolean): Promise<void>;
  stats(): Promise<CloudStats>;
  /** The v1 export, as JSON Lines text. */
  exportText(): Promise<string>;
  /**
   * Posts export lines (the first is the manifest). One call imports at most 1,000 lines; when
   * `next` is set, post the same lines again with `from = next` to continue.
   */
  importLines(lines: string[], from?: number): Promise<CloudImportResult>;
}

export interface CloudClientOptions {
  url: string;
  key: string;
  fetch?: typeof fetch;
  /** Per-request timeout; the hooks pass their own budget. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createCloudClient(opts: CloudClientOptions): CloudClient {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call(
    method: string,
    route: string,
    body?: { json?: unknown; text?: string },
  ): Promise<Response> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    const headers: Record<string, string> = { authorization: `Bearer ${opts.key}` };
    let payload: string | undefined;
    if (body?.json !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body.json);
    } else if (body?.text !== undefined) {
      headers['content-type'] = 'application/x-ndjson';
      payload = body.text;
    }
    let res: Response;
    try {
      res = await doFetch(`${opts.url}${route}`, {
        method,
        headers,
        ...(payload !== undefined && { body: payload }),
        signal: abort.signal,
        redirect: 'error',
      });
    } catch {
      throw new OortCloudError('network', 0);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        error?: { code?: unknown; message?: unknown };
      };
      const code = typeof err.error?.code === 'string' ? err.error.code : undefined;
      const message = typeof err.error?.message === 'string' ? err.error.message : undefined;
      throw new OortCloudError(cloudErrorKind(res.status, code), res.status, message);
    }
    return res;
  }
  const json = async <T>(method: string, route: string, body?: unknown): Promise<T> =>
    (await (
      await call(method, route, body === undefined ? undefined : { json: body })
    ).json()) as T;
  const idPath = (id: string): string => `/v1/memories/${encodeURIComponent(id)}`;

  return {
    url: opts.url,
    whoami: () => json('GET', '/v1/whoami'),
    recall: (q) => json('POST', '/v1/recall', q),
    observe: (b) => json('POST', '/v1/observe', b),
    list: (q = {}) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
      const qs = p.toString();
      return json('GET', `/v1/memories${qs === '' ? '' : `?${qs}`}`);
    },
    get: (id) => json('GET', idPath(id)),
    forget: async (id) => {
      await call('DELETE', idPath(id));
    },
    pin: async (id, pinned) => {
      await call('POST', `${idPath(id)}/${pinned ? 'pin' : 'unpin'}`);
    },
    stats: () => json('GET', '/v1/stats'),
    exportText: async () => (await call('GET', '/v1/export')).text(),
    importLines: async (lines, from = 0) =>
      (await (
        await call('POST', `/v1/import?from=${from}`, {
          text: lines.map((l) => `${l}\n`).join(''),
        })
      ).json()) as CloudImportResult,
  };
}

/** The shortest id prefix the API looks up (it answers 404 below this). */
export const MIN_ID_PREFIX = 8;

/**
 * A memory by id or unique id prefix (what `oort inspect` prints), looked up by the API itself:
 * a prefix that matches several memories is refused with a clear message.
 */
export async function findCloudMemory(client: CloudClient, ref: string): Promise<CloudMemory> {
  try {
    return await client.get(ref);
  } catch (e) {
    if (e instanceof OortCloudError && e.kind === 'not-found' && ref.length < MIN_ID_PREFIX) {
      throw new Refusal(`Give at least ${MIN_ID_PREFIX} characters of the memory id.`);
    }
    throw e;
  }
}
