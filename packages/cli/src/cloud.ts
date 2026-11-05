import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncludeLevel, Memory, RecallMode, RecallResult, Tier } from '@oortmem/core';
import type { Env } from './io.js';
import { ACCOUNT_URL } from './relay.js';
import { Refusal, shown, writeOwnerOnly } from './util.js';

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
  | 'network'
  | 'hive-not-enabled'
  | 'refused';

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

function messageFor(kind: CloudErrorKind, status: number, apiRaw?: string): string {
  // The API's own words are printed: never with control characters in them.
  const api = apiRaw === undefined ? undefined : shown(apiRaw);
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
    case 'hive-not-enabled':
      return 'Constellations are not enabled for this account yet (an invite-only beta). Your memories stay in your Planet.';
    case 'refused':
      return `Oort Cloud refused this (HTTP ${status})${api !== undefined ? `: ${api}` : '.'}`;
    case 'network':
      return 'Oort Cloud is unreachable: check your network, then try again.';
  }
}

/** The kind an API status (and `{ error: { code } }`) stands for. */
export function cloudErrorKind(status: number, code?: string): CloudErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 402) return 'payment-required';
  if (status === 403) {
    if (code === 'cloud_not_enabled') return 'not-enabled';
    if (code === 'hive_not_enabled') return 'hive-not-enabled';
    // Any other 403 explains itself (a Constellation's rules, a plan limit).
    return 'refused';
  }
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

/** A Constellation as one of its members sees it (hive beta). */
export interface CloudConstellation {
  id: string;
  name: string;
  role: 'maintainer' | 'member' | 'reader';
  owner: boolean;
  members: number;
  policy: string;
  joinedAt: string;
}

export type CloudRole = 'maintainer' | 'member' | 'reader';
export type CloudRight = 'read' | 'share' | 'maintain';

/** A space a caller can reach, as `/v1/whoami` lists it (CON-64). */
export type CloudSpace =
  | { level: 'planet' }
  | { level: 'constellation'; id: string; name: string; role: CloudRole; rights: CloudRight[] };

/** A Galaxy (a team, CON-97) and your role in it: owner, admin or member. */
export type CloudGalaxyRole = 'owner' | 'admin' | 'member';

export interface CloudGalaxy {
  id: string;
  name: string;
  slug: string | null;
  role: CloudGalaxyRole;
  members: number;
  constellations: number;
}

/** A person in a Galaxy, as its people see them: never an account id. */
export interface CloudGalaxyMember {
  /** The id to name this member by (`gm_…`). */
  member: string;
  role: CloudGalaxyRole;
  you: boolean;
  email: string | null;
  joinedAt: string;
}

export interface CloudWhoami {
  account: string;
  plan: string;
  via: string;
  /** What this key (and agent, when one was named) reaches; absent from an older API. */
  spaces?: CloudSpace[];
  /** Your Galaxies and your role in each (CON-97); absent when you have none. */
  galaxies?: Pick<CloudGalaxy, 'id' | 'name' | 'slug' | 'role'>[];
  /** `narrowed`: the key was limited to some spaces when it was made. */
  scope?: 'full' | 'narrowed';
}

/** An invite as the inviter sees it: the token only ever appears inside `link`. */
export interface CloudInvite {
  id: string;
  constellationId: string;
  constellation: string;
  role: CloudRole;
  /** A hint of the invited address (`ma…@example.com`), never the address itself. */
  email: string;
  expiresAt: string;
  link: string;
  emailed: boolean;
  /** Why nothing was emailed (a daily email limit, or the send failed); the link still works. */
  note?: string;
}

export interface CloudPendingInvite {
  id: string;
  role: CloudRole;
  email: string;
  createdAt: string;
  expiresAt: string;
}

/** A member of a Constellation, as its members see them: never an account id. */
export interface CloudMember {
  /** The id to name this member by (`mb_…`). */
  member: string;
  role: CloudRole;
  owner: boolean;
  you: boolean;
  email: string | null;
  joinedAt: string;
  stars: { agent: string; rights: string[] }[];
}

/** A new Oort Cloud key: shown once, never stored by Oort. */
export interface CloudKey {
  id: string;
  key: string;
  prefix: string;
  name: string;
  /** Canonical scope (`planet`, `c_…:read`), or null for a key that carries everything. */
  scope: string[] | null;
}

/** Something the share gate found in the text that would be shared. */
export interface ShareFinding {
  kind: string;
  start: number;
  end: number;
}

/** A share's answer: a preview (`confirmed: false`), or the new copy's id once confirmed. */
export interface CloudShareResult {
  confirmed: boolean;
  memoryId: string;
  constellation: string;
  /** The Constellation the preview resolved; the confirm names this id, never the name again. */
  constellationId: string;
  /** Exactly the text that is (or would be) shared: secrets already redacted. */
  text: string;
  findings: ShareFinding[];
  /** A preview's signed token, valid for a few minutes: the confirm presents it. */
  previewToken?: string;
  id?: string;
  /**
   * What the Constellation did with a confirmed share (CON-66): `added`, `updated` (shared
   * again), `reinforced` or `refined` (an existing memory), `superseded` or `corrected` (an
   * earlier memory ended), `history` (an older claim), or `contested` (held for a maintainer).
   * Absent from an older API.
   */
  outcome?: string;
}

/** A Constellation's policy, as the policy route answers it. */
export interface CloudPolicy {
  policy: string;
  /** Absent from an older API. */
  supersedeTrust?: string;
  policyVersion: number;
}

/** A hive memory as a contest shows it (only what the CLI prints). */
export interface CloudContestMemory {
  id: string;
  text: string;
  validFrom: string;
}

/** Two current memories held against each other until a maintainer keeps one (CON-66). */
export interface CloudContest {
  /** What the challenger asked for: SUPERSEDE or CORRECT. */
  action: string;
  openedAt: string;
  current: CloudContestMemory;
  challenger: CloudContestMemory;
}

export interface CloudResolved {
  kept: string;
  ended: string;
  /** SUPERSEDE or CORRECT (the challenger kept), or RETRACT (the challenger turned down). */
  action: string;
  nodeVersion: number;
}

/** A copy of one of the account's memories in a Constellation. */
export interface CloudShareEdge {
  constellation: string;
  name: string | null;
  id: string;
  at: string;
  withdrawnAt: string | null;
}

export interface CloudClient {
  readonly url: string;
  /** With `agent`, the spaces list only what that agent may reach. */
  whoami(agent?: string): Promise<CloudWhoami>;
  recall(q: {
    text: string;
    project?: string;
    k?: number;
    asOf?: string;
    knownAt?: string;
    mode?: RecallMode;
    /** Levels to read; the API answers 400 `scope_denied` for one this account cannot read. */
    include?: IncludeLevel[];
    /** Whether `project` (the one this runs in) is private: the cloud records it for sharing. */
    projectPrivate?: boolean;
    /** The agent asking: it reads only the Constellations it is attached to (CON-64). */
    agent?: string;
  }): Promise<RecallResult>;
  /** The account's Constellations (hive beta; 403 `hive_not_enabled` outside it). */
  constellations(): Promise<CloudConstellation[]>;
  /** In a Galaxy (`galaxy`: id, slug or name) when you are its admin or owner (CON-97). */
  createConstellation(name: string, galaxy?: string): Promise<CloudConstellation>;
  /** Your Galaxies and your role in each (hive beta; 403 `hive_not_enabled` outside it). */
  galaxies(): Promise<CloudGalaxy[]>;
  /** The people of one of your Galaxies, by id, slug or name. */
  galaxyMembers(galaxy: string): Promise<{
    galaxy: Pick<CloudGalaxy, 'id' | 'name' | 'slug' | 'role'>;
    members: CloudGalaxyMember[];
  }>;
  /**
   * Shares a memory with a Constellation: without `confirm`, a preview of exactly what would be
   * shared (by id or name; a name several of yours share is refused); with it, the copy, which
   * the API accepts only against the preview's `constellationId`.
   */
  share(
    to: string,
    b: {
      memoryId: string;
      text?: string;
      confirm?: boolean;
      /** The project the share runs in, and whether it is private (recorded by the cloud). */
      project?: string;
      projectPrivate?: boolean;
      /** The preview's token: a confirm must present it with exactly the previewed text. */
      previewToken?: string;
      /** The person read the personal data the preview found and shares it anyway. */
      acknowledgedFindings?: boolean;
    },
  ): Promise<CloudShareResult>;
  /** Invites an email address to a Constellation (maintainers only). */
  invite(c: string, email: string, role?: CloudRole): Promise<CloudInvite>;
  /** The invites nobody has accepted yet (maintainers only). */
  invites(c: string): Promise<CloudPendingInvite[]>;
  revokeInvite(c: string, invite: string): Promise<{ revoked: boolean }>;
  members(c: string): Promise<CloudMember[]>;
  /** `member` is an `mb_…` id or the member's invited email address. */
  setRole(c: string, member: string, role: CloudRole): Promise<{ member: string; role: CloudRole }>;
  removeMember(c: string, member: string): Promise<{ removed: boolean }>;
  leave(c: string): Promise<{ left: boolean }>;
  /** Lets one of your agents read (and with `share`, share into) a Constellation. */
  attach(
    c: string,
    agent: string,
    share?: boolean,
  ): Promise<{ agent: string; asked: string[]; rights: string[] }>;
  detach(c: string, agent: string): Promise<{ detached: boolean }>;
  /** Sets the share policy, `supersedeTrust`, or both (maintainers only). */
  setPolicy(
    c: string,
    set: { policy?: 'confirm' | 'open'; supersedeTrust?: 'member' | 'maintainer' },
  ): Promise<CloudPolicy>;
  /** The open contests in a Constellation (CON-66). */
  contested(c: string): Promise<CloudContest[]>;
  /** Keeps `keep` of the open contest holding `id` and `keep` (maintainers only). */
  resolve(c: string, id: string, keep: string): Promise<CloudResolved>;
  bindProject(c: string, project: string): Promise<{ project: string; bound: boolean }>;
  unbindProject(c: string, project: string): Promise<{ project: string; bound: boolean }>;
  transfer(c: string, member: string): Promise<{ owner: boolean; member: string }>;
  deleteConstellation(c: string): Promise<{ deleted: boolean; memories: number }>;
  /** A new Oort Cloud key, narrowed to `scope` when given (`planet`, `<c>[:read|:share]`). */
  createKey(b: { name?: string; scope?: string[] }): Promise<CloudKey>;
  /** The owner's explicit privacy choice for a project (the only way to clear private). */
  setProjectPrivacy(project: string, priv: boolean): Promise<{ project: string; private: boolean }>;
  /** The Constellation copies of one memory. */
  shares(id: string): Promise<CloudShareEdge[]>;
  /** Forgets a memory and withdraws the copies only this person contributed to. */
  forgetEverywhere(
    id: string,
  ): Promise<{ withdrawn: string[]; requested: string[]; unreachable: string[] }>;
  /** `turnRef` makes a retry safe: the API saves each turn once and answers `duplicate`. */
  observe(b: {
    project?: string;
    /** Whether `project` (the one this runs in) is private: the cloud records it for sharing. */
    projectPrivate?: boolean;
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
  const cPath = (c: string, rest = ''): string =>
    `/v1/constellations/${encodeURIComponent(c)}${rest}`;

  return {
    url: opts.url,
    whoami: (agent) =>
      json('GET', `/v1/whoami${agent === undefined ? '' : `?agent=${encodeURIComponent(agent)}`}`),
    invite: (c, email, role) =>
      json('POST', cPath(c, '/invites'), { email, ...(role !== undefined && { role }) }),
    invites: async (c) =>
      (await json<{ invites: CloudPendingInvite[] }>('GET', cPath(c, '/invites'))).invites,
    revokeInvite: (c, invite) => json('DELETE', cPath(c, `/invites/${encodeURIComponent(invite)}`)),
    members: async (c) =>
      (await json<{ members: CloudMember[] }>('GET', cPath(c, '/members'))).members,
    setRole: (c, member, role) =>
      json('PUT', cPath(c, `/members/${encodeURIComponent(member)}`), { role }),
    removeMember: (c, member) => json('DELETE', cPath(c, `/members/${encodeURIComponent(member)}`)),
    leave: (c) => json('POST', cPath(c, '/leave')),
    attach: (c, agent, share) =>
      json('POST', cPath(c, '/stars'), { agent, ...(share === true && { share: true }) }),
    detach: (c, agent) => json('DELETE', cPath(c, `/stars/${encodeURIComponent(agent)}`)),
    setPolicy: (c, set) => json('PUT', cPath(c, '/policy'), set),
    contested: async (c) =>
      (await json<{ contested: CloudContest[] }>('GET', cPath(c, '/contested'))).contested,
    resolve: (c, id, keep) =>
      json('POST', cPath(c, `/contested/${encodeURIComponent(id)}`), { keep }),
    bindProject: (c, project) => json('PUT', cPath(c, `/projects/${encodeURIComponent(project)}`)),
    unbindProject: (c, project) =>
      json('DELETE', cPath(c, `/projects/${encodeURIComponent(project)}`)),
    transfer: (c, member) => json('POST', cPath(c, '/transfer'), { member }),
    deleteConstellation: (c) => json('DELETE', cPath(c)),
    createKey: (b) => json('POST', '/v1/keys', b),
    recall: (q) => json('POST', '/v1/recall', q),
    constellations: async () =>
      (await json<{ constellations: CloudConstellation[] }>('GET', '/v1/constellations'))
        .constellations,
    createConstellation: (name, galaxy) =>
      json('POST', '/v1/constellations', { name, ...(galaxy !== undefined && { galaxy }) }),
    galaxies: async () => (await json<{ galaxies: CloudGalaxy[] }>('GET', '/v1/galaxies')).galaxies,
    galaxyMembers: (g) => json('GET', `/v1/galaxies/${encodeURIComponent(g)}/members`),
    share: (to, b) => json('POST', `/v1/constellations/${encodeURIComponent(to)}/share`, b),
    setProjectPrivacy: (project, priv) =>
      json('PUT', `/v1/projects/${encodeURIComponent(project)}/privacy`, { private: priv }),
    shares: async (id) =>
      (await json<{ shares: CloudShareEdge[] }>('GET', `${idPath(id)}/shares`)).shares,
    forgetEverywhere: (id) => json('DELETE', `${idPath(id)}?everywhere=1`),
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
