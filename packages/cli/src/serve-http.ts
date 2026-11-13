import { createHash, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import * as path from 'node:path';
import type { Env } from './io.js';
import {
  OortNeedsLoginError,
  OortNetworkError,
  OortRefusedError,
  OortUsageError,
  toOortError,
  type OortError,
} from './sdk/errors.js';
import type { JudgeRole, Oort, OortOptions, RecallResult, ScopedOptions } from './sdk/types.js';
import { budgetOf } from './sdk/views.js';
import { NAME } from './sdk/validate.js';

/**
 * The memory protocol `oort serve` speaks over HTTP/1.1 with JSON (CON-108 §8.1): the same
 * operations as the SDK, for the Python client and any other language. Served on the daemon's
 * Unix socket (first-byte routing: hook frames start with 0x00, HTTP with a method letter) and,
 * with `--listen`, on a TCP port that requires a bearer token (service mode, §9.4).
 *
 * Every request runs through an SDK handle (`createOort` + `scoped`), so the grants, scope rules,
 * judgment rules, limits and error codes are exactly the in-process SDK's: this module only maps
 * routes and headers to SDK calls, and results and errors to the `oort.v1` envelope.
 *
 * - No CORS headers, and any request with an `Origin` header is refused: a browser page can
 *   reach neither the socket (through a proxy) nor a loopback listener (DNS rebinding).
 * - Bodies are JSON objects of at most 4 MiB, headers at most 16 KiB, 30 s per request.
 * - No request names a file to read or write: `Oort-Cwd` only selects the project, as a hook's
 *   cwd does, and the TCP listener refuses it.
 */

/** The protocol major, in every path (`/v1`) and in `GET /v1/health`. */
export const HTTP_PROTOCOL = 1;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_HEADER_BYTES = 16 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
/** The TCP listener waits less for a request's headers: an idle connection holds a slot. */
const SERVICE_HEADERS_TIMEOUT_MS = 5_000;
/** How often Node closes connections past their timeouts (default 30 s; slots free sooner). */
const CONNECTIONS_CHECK_MS = 1_000;
const KEEP_ALIVE_MS = 5_000;
/** What this daemon serves beyond the core routes (`GET /v1/health`). */
export const CAPABILITIES = ['judgments', 'consolidate', 'links'] as const;
/** A root handle is replaced once it is this old, so edited config and keys are picked up. */
export const HANDLE_TTL_MS = 60_000;
/** At most this many root handles (one per cwd, org and judge role) stay open. */
export const HANDLE_MAX = 8;
/** A replaced handle closes this long after, when no request can still be using it. */
const HANDLE_CLOSE_GRACE_MS = REQUEST_TIMEOUT_MS + 5_000;
/** A service token: 256 bits, base64url (what `oort serve token` makes). */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;

export type HandleFactory = (options: OortOptions) => Promise<Oort>;

/** Service mode (`--listen`): the tokens' SHA-256 digests and the one org they act in. */
export interface ServiceAuth {
  digests: Buffer[];
  org: string;
  /**
   * The digests now, asked on every request: a token file that was rotated or removed changes
   * the answer with no restart. Absent: `digests` is fixed (`OORT_SERVE_TOKEN`).
   */
  reload?: (log?: (line: string) => void) => readonly Buffer[];
  /** Read the token file again on the next request (SIGHUP). */
  forceReload?: () => void;
}

/** Where the TCP listener is bound: loopback binds check the Host header (DNS rebinding). */
export interface ServiceBind {
  host: string;
  port?: number;
}

/** `Oort-User: -` on the TCP listener: deliberate org-level (or agent-level) memory. */
export const NO_USER = '-';

export interface MemoryApiOptions {
  home: string;
  /** The daemon's environment: wiring reads keys and config from it. */
  env: Env;
  version: string;
  /** Makes a root handle; `createOort` in the daemon, a fake-model factory in tests only. */
  create: HandleFactory;
  /** The cwd a request without `Oort-Cwd` resolves config from (no project). */
  warmCwd: string;
  /** Every request counts as activity for the idle exit. */
  touch: () => void;
  stopping: () => boolean;
  now?: () => number;
}

/** Thrown inside a request: an error the envelope reports as is. */
class Reject extends Error {
  constructor(
    readonly err: OortError,
    readonly httpStatus?: number,
  ) {
    super(err.message);
  }
}

const usage = (message: string, reason = 'invalid-argument'): Reject =>
  new Reject(new OortUsageError(message, { reason }));

/** The HTTP status for an error code; the envelope's `code` wins over it (§8.1.2). */
export function statusFor(e: OortError): number {
  switch (e.code) {
    case 'usage':
      return e.reason === 'too-large' ? 413 : 400;
    case 'needs-login':
      return 401;
    case 'refused':
    case 'cloud-only':
    case 'needs-key':
      return 403;
    case 'not-found':
      return 404;
    case 'ambiguous-id':
    case 'needs-confirmation':
      return 409;
    case 'network':
      return 503;
    case 'internal':
      return 500;
  }
}

/** An `OortError` as the envelope's `error`: its stable fields only, never a stack or a cause. */
export function errorBody(e: OortError): Record<string, unknown> {
  const x = e as OortError & { role?: string; envVar?: string };
  return {
    code: e.code,
    message: e.message,
    fix: e.fix,
    ...(e.reason !== undefined && { reason: e.reason }),
    retryable: e.retryable,
    ...(e.retryAfter !== undefined && { retryAfter: e.retryAfter }),
    ...(e.status !== undefined && { status: e.status }),
    ...(x.role !== undefined && { role: x.role }),
    ...(x.envVar !== undefined && { envVar: x.envVar }),
  };
}

/** The scope a request names in its headers, checked. */
interface RequestScope {
  cwd: string | undefined;
  projectConfig: boolean;
  project: string | null | undefined;
  agent: string | undefined;
  /** `undefined`: no `Oort-User` header; `''`: present and empty (refused by the SDK). */
  user: string | undefined;
  org: string;
  role: JudgeRole;
  operator: string | undefined;
}

const header = (req: http.IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  if (Array.isArray(v)) throw usage(`${name} was given more than once.`);
  return v;
};

/**
 * The request's scope headers (§8.1.3). On the TCP listener the token decides the org, the
 * project must be named, the cwd is refused (it would read a file on the server) and judgments
 * are recorded in agent role only.
 */
function scopeOf(req: http.IncomingMessage, service: ServiceAuth | undefined): RequestScope {
  const rawCwd = header(req, 'oort-cwd');
  const rawProject = header(req, 'oort-project');
  const rawConfig = header(req, 'oort-project-config');
  const agent = header(req, 'oort-agent');
  const rawUser = header(req, 'oort-user');
  const rawOrg = header(req, 'oort-org');
  const rawRole = header(req, 'oort-judge-role');
  const operator = header(req, 'oort-operator');
  if (service !== undefined) {
    if (rawCwd !== undefined) {
      throw usage('Oort-Cwd is refused on the TCP listener: name the project with Oort-Project.');
    }
    if (rawOrg !== undefined) {
      throw usage('Oort-Org is refused on the TCP listener: the service token decides the org.');
    }
    if (rawProject === undefined) {
      throw usage('Oort-Project is required on the TCP listener (`-` for no project).');
    }
    // Fail closed: a request that forgot its end user must not act as the org's one shared
    // Planet. Deliberate org-level (or agent-level) memory says so with `Oort-User: -`.
    if (rawUser === undefined) {
      throw usage(
        'Oort-User is required on the TCP listener: name the end user, or send `Oort-User: -` for org-level (or agent-level, with Oort-Agent) memory.',
        'user-missing',
      );
    }
    if (rawRole !== undefined && rawRole !== 'agent') {
      throw new Reject(
        new OortRefusedError(
          'Expert-role judgments are refused on the TCP listener: a service token is not a person.',
          { reason: 'expert-only' },
        ),
      );
    }
  }
  const user = service !== undefined && rawUser === NO_USER ? undefined : rawUser;
  let cwd: string | undefined;
  if (rawCwd !== undefined) {
    try {
      cwd = decodeURIComponent(rawCwd);
    } catch {
      throw usage('Oort-Cwd is not percent-encoded UTF-8.');
    }
    if (!path.isAbsolute(cwd) || cwd.includes('\0') || cwd.length > 4096) {
      throw usage('Oort-Cwd must be an absolute path.');
    }
  }
  let project: string | null | undefined;
  if (rawProject !== undefined) {
    if (rawProject === '-') project = null;
    else if (NAME.test(rawProject)) project = rawProject;
    else throw usage('Oort-Project is not a project id (or `-` for none).');
  }
  if (rawConfig !== undefined && rawConfig !== '0' && rawConfig !== '1') {
    throw usage('Oort-Project-Config must be 0 or 1.');
  }
  if (rawRole !== undefined && rawRole !== 'agent' && rawRole !== 'expert') {
    throw usage('Oort-Judge-Role must be agent or expert.');
  }
  if (operator !== undefined && (operator.trim() === '' || operator.length > 128)) {
    throw usage('Oort-Operator must be 1 to 128 characters.');
  }
  return {
    cwd,
    // The listener never reads a repository's config: it has no cwd of the caller's.
    projectConfig: service === undefined && rawConfig !== '0',
    project,
    agent: agent === undefined || agent === '' ? undefined : agent,
    user,
    org: service?.org ?? rawOrg ?? 'local',
    role: rawRole === 'expert' ? 'expert' : 'agent',
    operator: rawRole === 'expert' ? operator : undefined,
  };
}

interface Entry {
  root: Oort;
  at: number;
}

/**
 * Root handles keyed by what a root fixes (cwd, project config, org, judge role and operator).
 * A request's agent, user and project are a `scoped()` handle derived from its root: the SDK's
 * own rules decide what that handle may read and write.
 */
class Handles {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Entry>>();
  private closed = false;

  constructor(
    private readonly o: MemoryApiOptions,
    private readonly now: () => number,
  ) {}

  private options(s: RequestScope): OortOptions {
    // The client's own OORT_AGENT travels as Oort-Agent: the daemon's never applies to it.
    const { OORT_AGENT: _agent, ...env } = this.o.env;
    return {
      mode: 'local',
      home: this.o.home,
      env,
      cwd: s.cwd ?? this.o.warmCwd,
      // The daemon never migrates the store (unchanged from the hooks' daemon).
      migrate: false,
      ...(!s.projectConfig && { projectConfig: false }),
      ...(s.org !== 'local' && { org: s.org }),
      ...(s.role === 'expert' && {
        judge: { role: 'expert', ...(s.operator !== undefined && { operator: s.operator }) },
      }),
    };
  }

  async get(s: RequestScope): Promise<Oort> {
    if (this.closed) throw stopping();
    const key = JSON.stringify([s.cwd ?? null, s.projectConfig, s.org, s.role, s.operator ?? null]);
    const hit = this.entries.get(key);
    if (hit !== undefined && this.now() - hit.at <= HANDLE_TTL_MS) {
      this.entries.delete(key);
      this.entries.set(key, hit); // most recently used last
      return hit.root;
    }
    let p = this.pending.get(key);
    if (p === undefined) {
      p = this.o.create(this.options(s)).then((root) => {
        if (this.closed) {
          void root.close();
          throw stopping();
        }
        const old = this.entries.get(key);
        if (old !== undefined) this.closeLater(old.root);
        this.entries.delete(key);
        const entry = { root, at: this.now() };
        this.entries.set(key, entry);
        this.evict();
        return entry;
      });
      this.pending.set(key, p);
      void p.catch(() => {}).finally(() => this.pending.delete(key));
    }
    return (await p).root;
  }

  private evict(): void {
    while (this.entries.size > HANDLE_MAX) {
      const [oldest] = this.entries.keys();
      if (oldest === undefined) return;
      const e = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (e !== undefined) this.closeLater(e.root);
    }
  }

  private closeLater(root: Oort): void {
    setTimeout(() => void root.close().catch(() => {}), HANDLE_CLOSE_GRACE_MS).unref();
  }

  get size(): number {
    return this.entries.size;
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.pending.values());
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(all.map((e) => e.root.close()));
  }
}

const stopping = (): Reject =>
  new Reject(
    new OortNetworkError('The daemon is stopping; try again.', { reason: 'shutting-down' }),
  );

/** The request body as a JSON object (POST), or `{}` (GET, DELETE). */
async function bodyOf(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method !== 'POST') return {};
  const declared = Number(req.headers['content-length'] ?? NaN);
  // A POST that carries nothing (pin, unpin, confirm) needs no content type.
  if (
    declared === 0 ||
    (req.headers['content-length'] === undefined && req.headers['transfer-encoding'] === undefined)
  ) {
    return {};
  }
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw usage('The body must be application/json.');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw usage('The request body is over 4 MiB.', 'too-large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw usage('The request body is over 4 MiB.', 'too-large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let v: unknown;
  try {
    v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw usage('The body is not JSON.', 'bad-request');
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw usage('The body must be a JSON object.', 'bad-request');
  }
  return v as Record<string, unknown>;
}

/** Query parameters, each at most once, and only the ones a route takes. */
function queryOf(url: URL, allowed: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of url.searchParams) {
    if (!allowed.includes(k)) throw usage(`Unknown query parameter ${safe(k)}.`);
    if (out.has(k)) throw usage(`${safe(k)} was given more than once.`);
    out.set(k, v);
  }
  return out;
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);

function intParam(q: Map<string, string>, name: string): number | undefined {
  const v = q.get(name);
  if (v === undefined) return undefined;
  if (!/^\d{1,6}$/.test(v)) throw usage(`${name} must be a whole number.`);
  return Number(v);
}

function boolParam(q: Map<string, string>, name: string): boolean | undefined {
  const v = q.get(name);
  if (v === undefined) return undefined;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  throw usage(`${name} must be 1 or 0.`);
}

function idOf(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw usage('The id is not percent-encoded UTF-8.');
  }
}

type Call = (h: Oort, body: Record<string, unknown>) => Promise<unknown>;

interface Route {
  method: string;
  /** For logs: the pattern, never the path (an id is not logged). */
  name: string;
  match: RegExp;
  query?: readonly string[];
  call: (m: RegExpExecArray, q: Map<string, string>) => Call;
}

const ID = '([^/]+)';

/** Every route but the handshakes: one SDK call each, with the body as its arguments. */
const ROUTES: Route[] = [
  {
    method: 'GET',
    name: 'GET /v1/whoami',
    match: /^\/v1\/whoami$/,
    call: () => (h) => h.whoami(),
  },
  {
    method: 'POST',
    name: 'POST /v1/recall',
    match: /^\/v1\/recall$/,
    call: () => async (h, b) => {
      const { query, ...opts } = b;
      const r = await h.recall(query as string, opts);
      // The block budget `formatForPrompt` would default to (the config's), for other languages.
      const budget = budgetOf(r as RecallResult);
      return budget === undefined ? r : { ...r, budgetChars: budget };
    },
  },
  {
    method: 'POST',
    name: 'POST /v1/observe',
    match: /^\/v1\/observe$/,
    call: () => (h, b) => h.observe(b as never),
  },
  {
    method: 'POST',
    name: 'POST /v1/remember',
    match: /^\/v1\/remember$/,
    call: () => (h, b) => {
      const { facts, ...opts } = b;
      return h.remember(facts as string[], opts);
    },
  },
  {
    method: 'GET',
    name: 'GET /v1/memories',
    match: /^\/v1\/memories$/,
    query: ['since', 'limit'],
    call: (_m, q) => (h) => {
      const limit = intParam(q, 'limit');
      const since = q.get('since');
      return h.recent({
        ...(since !== undefined && { since }),
        ...(limit !== undefined && { limit }),
      });
    },
  },
  {
    method: 'GET',
    name: 'GET /v1/memories/:id/explain',
    match: new RegExp(`^/v1/memories/${ID}/explain$`),
    call: (m) => (h) => h.explain(idOf(m[1]!)),
  },
  {
    method: 'DELETE',
    name: 'DELETE /v1/memories/:id',
    match: new RegExp(`^/v1/memories/${ID}$`),
    query: ['everywhere'],
    call: (m, q) => (h) => {
      const everywhere = boolParam(q, 'everywhere');
      return h.forget(idOf(m[1]!), everywhere === undefined ? {} : { everywhere });
    },
  },
  {
    method: 'POST',
    name: 'POST /v1/memories/:id/pin',
    match: new RegExp(`^/v1/memories/${ID}/pin$`),
    call: (m) => (h) => h.pin(idOf(m[1]!)),
  },
  {
    method: 'POST',
    name: 'POST /v1/memories/:id/unpin',
    match: new RegExp(`^/v1/memories/${ID}/unpin$`),
    call: (m) => (h) => h.unpin(idOf(m[1]!)),
  },
  {
    method: 'POST',
    name: 'POST /v1/links',
    match: /^\/v1\/links$/,
    call: () => (h, b) => {
      const { from, to, ...rest } = b;
      const extra = Object.keys(rest)[0];
      if (extra !== undefined) throw usage(`Unknown field ${safe(extra)}.`);
      return h.link(from as string, to as string);
    },
  },
  {
    method: 'DELETE',
    name: 'DELETE /v1/links',
    match: /^\/v1\/links$/,
    query: ['from', 'to'],
    call: (_m, q) => (h) => h.unlink(q.get('from') as string, q.get('to') as string),
  },
  {
    method: 'POST',
    name: 'POST /v1/judgments',
    match: /^\/v1\/judgments$/,
    call: () => (h, b) => h.judge.record(b as never),
  },
  {
    method: 'POST',
    name: 'POST /v1/judgments/apply',
    match: /^\/v1\/judgments\/apply$/,
    call: () => (h, b) => {
      const { item, ...opts } = b;
      return h.judge.apply(item as string, opts);
    },
  },
  {
    method: 'POST',
    name: 'POST /v1/judgments/:id/confirm',
    match: new RegExp(`^/v1/judgments/${ID}/confirm$`),
    call: (m) => (h) => h.judge.confirm(idOf(m[1]!)),
  },
  {
    method: 'GET',
    name: 'GET /v1/judgments',
    match: /^\/v1\/judgments$/,
    query: ['domain', 'by', 'all', 'limit'],
    call: (_m, q) => (h) => {
      const all = boolParam(q, 'all');
      const limit = intParam(q, 'limit');
      const domain = q.get('domain');
      const by = q.get('by');
      return h.judge.list({
        ...(domain !== undefined && { domain }),
        ...(by !== undefined && { by }),
        ...(all !== undefined && { all }),
        ...(limit !== undefined && { limit }),
      });
    },
  },
  {
    method: 'POST',
    name: 'POST /v1/consolidate',
    match: /^\/v1\/consolidate$/,
    call: () => (h, b) => h.consolidate(b),
  },
];

/** True when one of `digests` is the SHA-256 of the request's bearer token (constant time). */
export function tokenMatches(
  authorization: string | undefined,
  digests: readonly Buffer[],
): boolean {
  // The scheme is case-insensitive (RFC 7235 section 2.1).
  const m = /^bearer ([^\s]+)$/i.exec(authorization ?? '');
  const given = createHash('sha256')
    .update(m?.[1] ?? '')
    .digest();
  let ok = false;
  // Every digest is compared, so the time taken does not say which (or whether one) matched.
  for (const d of digests) if (timingSafeEqual(given, d) && m !== null) ok = true;
  return ok;
}

const isLoopbackHost = (host: string): boolean =>
  host === 'localhost' || host === '::1' || host.startsWith('127.');

/** The Host values a loopback listener answers to: its own names and the port it listens on. */
export function allowedHost(host: string | undefined, bound: string, port: number): boolean {
  if (host === undefined) return false;
  const names = ['localhost', '127.0.0.1', '[::1]', bound.includes(':') ? `[${bound}]` : bound];
  const h = host.toLowerCase();
  return names.some((n) => h === `${n.toLowerCase()}:${port}` || (port === 80 && h === n));
}

export const digestOf = (token: string): Buffer => createHash('sha256').update(token).digest();

export interface MemoryApi {
  /** A server that is never listened on: the daemon hands it the socket's HTTP connections. */
  readonly server: http.Server;
  /** Service mode's own server (`--listen`), when made. */
  serviceServer(auth: ServiceAuth, log: (line: string) => void, bind?: ServiceBind): http.Server;
  readonly handles: number;
  close(): Promise<void>;
}

/** The memory API: one handler, served on the socket and (in service mode) on TCP. */
export function createMemoryApi(o: MemoryApiOptions): MemoryApi {
  const now = o.now ?? Date.now;
  const handles = new Handles(o, now);

  const send = (
    res: http.ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ): number => {
    const text = JSON.stringify({ schema: 'oort.v1', ...body });
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(text);
    return status;
  };

  const fail = (res: http.ServerResponse, e: unknown): number => {
    const err = e instanceof Reject ? e.err : toOortError(e);
    const status =
      e instanceof Reject && e.httpStatus !== undefined ? e.httpStatus : statusFor(err);
    return send(res, status, { ok: false, error: errorBody(err) });
  };

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    service: ServiceAuth | undefined,
    hostOk?: (host: string | undefined) => boolean,
    log?: (line: string) => void,
  ): Promise<{ status: number; route: string }> => {
    let route = 'unknown';
    try {
      // A browser page never reaches the daemon: no CORS, and any Origin is refused.
      if (req.headers.origin !== undefined) {
        throw new Reject(
          new OortRefusedError('Requests from a browser page are refused.', {
            reason: 'origin-refused',
          }),
        );
      }
      // A loopback listener answers only to its own names: a rebound DNS name is refused.
      if (hostOk !== undefined && !hostOk(req.headers.host)) {
        throw new Reject(
          new OortRefusedError('This Host is not allowed on a loopback listener.', {
            reason: 'host-refused',
          }),
        );
      }
      const url = new URL(req.url ?? '/', 'http://oort.invalid');
      const method = req.method ?? 'GET';
      if (method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/readyz')) {
        route = `GET ${url.pathname}`;
        const ready = !o.stopping();
        const status = url.pathname === '/healthz' || ready ? 200 : 503;
        return { status: send(res, status, { ok: ready, data: { ready } }), route };
      }
      if (
        service !== undefined &&
        !tokenMatches(req.headers.authorization, service.reload?.(log) ?? service.digests)
      ) {
        throw new Reject(
          new OortNeedsLoginError('A valid service token is required (Authorization: Bearer).', {
            fix: null,
            reason: 'token-rejected',
          }),
        );
      }
      if (method === 'GET' && url.pathname === '/v1/health') {
        route = 'GET /v1/health';
        return {
          status: send(res, 200, {
            ok: true,
            data: {
              version: o.version,
              protocol: HTTP_PROTOCOL,
              mode: service === undefined ? 'local' : 'service',
              capabilities: [...CAPABILITIES],
            },
            warnings: [],
          }),
          route,
        };
      }
      const r = ROUTES.find((x) => x.match.test(url.pathname) && x.method === method);
      if (r === undefined) {
        const known = ROUTES.some((x) => x.match.test(url.pathname));
        throw new Reject(
          new OortUsageError(
            known ? `${safe(method)} is not allowed here.` : 'No such route in protocol v1.',
            { reason: known ? 'method-not-allowed' : 'unknown-route' },
          ),
          known ? 405 : 404,
        );
      }
      route = r.name;
      if (o.stopping()) throw stopping();
      o.touch();
      const call = r.call(r.match.exec(url.pathname)!, queryOf(url, r.query ?? []));
      const scope = scopeOf(req, service);
      const body = await bodyOf(req);
      const root = await handles.get(scope);
      const scoped: ScopedOptions = {
        ...(scope.project !== undefined && { project: scope.project }),
        ...(scope.agent !== undefined && { agent: scope.agent }),
        ...(scope.user !== undefined && { user: scope.user }),
      };
      const h = root.scoped(scoped);
      const data = (await call(h, body)) as Record<string, unknown>;
      const warnings = Array.isArray(data['warnings']) ? data['warnings'] : [];
      return { status: send(res, 200, { ok: true, data, warnings }), route };
    } catch (e) {
      return { status: fail(res, e), route };
    }
  };

  const make = (
    service?: ServiceAuth,
    log?: (line: string) => void,
    bind?: ServiceBind,
  ): http.Server => {
    const loopbackBind = service !== undefined && bind !== undefined && isLoopbackHost(bind.host);
    const hostOk = loopbackBind
      ? (host: string | undefined): boolean => {
          const addr = server.address();
          const port = bind.port ?? (addr !== null && typeof addr === 'object' ? addr.port : 0);
          return allowedHost(host, bind.host, port);
        }
      : undefined;
    const server = http.createServer(
      {
        maxHeaderSize: MAX_HEADER_BYTES,
        requestTimeout: REQUEST_TIMEOUT_MS,
        headersTimeout: service === undefined ? HEADERS_TIMEOUT_MS : SERVICE_HEADERS_TIMEOUT_MS,
        keepAliveTimeout: KEEP_ALIVE_MS,
        connectionsCheckingInterval: CONNECTIONS_CHECK_MS,
      },
      (req, res) => {
        const t0 = performance.now();
        void handle(req, res, service, hostOk, log).then(({ status, route }) => {
          // Service logs (§9.7): the route pattern, status and time; never text, ids or scope.
          log?.(
            JSON.stringify({
              ts: new Date(now()).toISOString(),
              level: status >= 500 ? 'error' : 'info',
              msg: 'request',
              route,
              status,
              ms: Math.round(performance.now() - t0),
            }),
          );
        });
      },
    );
    server.on('clientError', (_e, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
      else socket.destroy();
    });
    return server;
  };

  const server = make();
  return {
    server,
    serviceServer: (auth, log, bind) => make(auth, log, bind),
    get handles() {
      return handles.size;
    },
    close: () => handles.closeAll(),
  };
}
