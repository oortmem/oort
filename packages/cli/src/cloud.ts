import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncludeLevel, Memory, RecallMode, RecallResult, Tier } from '@oortmem/core';
import {
  TIMING_HEADER,
  connectedSince,
  keepAliveFetch,
  poolKnowsConnections,
  timedFetch,
  parseServerTiming,
  type CloudTiming,
  lexicalFirstOf,
} from './cloud-http.js';
import type { Env } from './io.js';
import { ACCOUNT_URL, parseRetryAfter } from './relay.js';
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
  | 'end-user-limit'
  | 'end-users-unsupported'
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
  /**
   * The API's own `error.code` (`preview_required`, `cloud_not_enabled`), or `timeout` for a
   * request this client gave up on: finer than `kind`, for the SDK's `reason`. Never shown.
   */
  readonly apiCode: string | undefined;
  /** Seconds the API asked to wait (its `Retry-After` on a 429 or 503), when it said. */
  readonly retryAfterSec: number | undefined;

  constructor(
    kind: CloudErrorKind,
    status: number,
    apiMessage?: string,
    apiCode?: string,
    retryAfterSec?: number,
  ) {
    super(messageFor(kind, status, apiMessage));
    this.name = 'OortCloudError';
    this.kind = kind;
    this.status = status;
    this.holdQueue = HOLD.has(kind);
    this.apiCode = apiCode;
    this.retryAfterSec = retryAfterSec;
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
    case 'end-user-limit':
      return `Oort Cloud refused a new end user (HTTP 402)${api !== undefined ? `: ${api}` : '.'}`;
    case 'end-users-unsupported':
      return status === 404 ? END_USERS_NOT_OFFERED : END_USERS_UNSUPPORTED;
    case 'refused':
      return `Oort Cloud refused this (HTTP ${status})${api !== undefined ? `: ${api}` : '.'}`;
    case 'network':
      return 'Oort Cloud is unreachable: check your network, then try again.';
  }
}

/**
 * Refused before any request names an end user: whoami does not list the key's `end-users`
 * capability. An Oort Cloud from before CON-132 ignores `Oort-User` and would write the end
 * user's memories into the account's own Planet, so the header is never sent to one.
 */
export const END_USERS_UNSUPPORTED =
  'Per-user memory needs Oort Cloud with server keys: whoami does not list the end-users capability for this Oort key (an Oort Cloud without per-user memory, or a key made without "Acts for end users"), so nothing was sent for this end user. Make a server key on https://oortcloud.dev/account.';

/**
 * An account's end-user route (count, erase) answered 404: an Oort Cloud from before CON-132. These
 * routes ask no whoami first, since whoami is refused while Pro has lapsed or the account is blocked
 * and an end user's deletion must still go through.
 */
export const END_USERS_NOT_OFFERED =
  'Per-user memory needs Oort Cloud with server keys: this Oort Cloud has no end-user routes (HTTP 404), so nothing was done for this end user. Make a server key on https://oortcloud.dev/account.';

/** The key capability that lets a server key act for its account's end users (CON-132). */
export const END_USERS_CAPABILITY = 'end-users';

/** The request header that names the end user a server key acts for (CON-132). */
export const END_USER_HEADER = 'Oort-User';

/** Whether a whoami answer lists the `end-users` capability: exactly that string, in a list. */
export function endUsersAllowed(me: unknown): boolean {
  const caps = (me as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(caps) && caps.includes(END_USERS_CAPABILITY);
}

/** The kind an API status (and `{ error: { code } }`) stands for. */
export function cloudErrorKind(status: number, code?: string): CloudErrorKind {
  if (status === 401) return 'unauthorized';
  // A plan's end-user limit (CON-132), not a lapsed plan: the end users already there keep working.
  if (status === 402 && code === 'end_user_limit') return 'end-user-limit';
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
  /** Archived (its team's organization was deleted): read-only, and deleted on this date. */
  archivedUntil?: string;
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
  /** Added, not yet joined on oortcloud.dev: shown to admins only, and granted nothing. */
  pending?: boolean;
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
  /**
   * What this key may do beyond its account's own memory: `end-users` for a server key that
   * acts for end users (CON-132). Absent from an older API, and for every other key.
   */
  capabilities?: string[];
}

/** How many end users the account has, and how many its plan includes (CON-132). */
export interface CloudEndUserCount {
  endUsers: number;
  limit: number;
}

/** What erasing an end user removed: counts only (CON-132). */
export interface CloudEndUserErasure {
  memories: number;
  coldCopies: number;
  turnRefs: number;
  cursors: number;
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
  /** CON-67: the members a memory needs to survive an erasure. Absent from an older API. */
  minSupport?: number;
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
  /** CON-67: false once you left that Constellation. Absent from an older API. */
  member?: boolean;
  id: string;
  at: string;
  /** When it was withdrawn; `null` (or absent, from an older API) while the copy is live. */
  withdrawnAt?: string | null;
}

/** What `DELETE /v1/memories/:id?everywhere=1` answers: Constellation ids (CON-67). */
export interface CloudForgetEverywhere {
  /** The copies only you contributed to: withdrawn. */
  withdrawn: string[];
  /** Others contributed: a removal request went to the maintainers, and the copy stays. */
  requested: string[];
  /** Not reached (try again later; a Constellation you left needs a full key). The copy stays. */
  unreachable: string[];
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
    /**
     * false: rank without the reranker (CON-101). `'gate-miss'`: rerank only when the relevance
     * gate would drop every candidate (CON-131); an API from before it answers 400.
     */
    rerank?: boolean | 'gate-miss';
    /** false: no query embedding, lexical recall only (CON-101). An older API ignores it. */
    embed?: boolean;
    /**
     * Lexical first (core's `recall.lexicalFirst`): true lets a clear lexical answer skip the
     * query embedding, false always embeds. An older API ignores it (and runs lexical first).
     */
    lexicalFirst?: boolean;
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
    set: {
      policy?: 'confirm' | 'open';
      supersedeTrust?: 'member' | 'maintainer';
      minSupport?: number;
    },
  ): Promise<CloudPolicy>;
  /** The open contests in a Constellation (CON-66). */
  contested(c: string): Promise<CloudContest[]>;
  /** Keeps `keep` of the open contest holding `id` and `keep` (maintainers only). */
  resolve(c: string, id: string, keep: string): Promise<CloudResolved>;
  bindProject(c: string, project: string): Promise<{ project: string; bound: boolean }>;
  unbindProject(c: string, project: string): Promise<{ project: string; bound: boolean }>;
  transfer(c: string, member: string): Promise<{ owner: boolean; member: string }>;
  deleteConstellation(c: string): Promise<{ deleted: boolean; memories: number }>;
  /**
   * The owner adopts an archived Constellation (its team's organization was deleted, CON-102)
   * into their own account: theirs, and writable again.
   */
  adoptConstellation(c: string): Promise<{ id: string; adopted: boolean }>;
  /** A new Oort Cloud key, narrowed to `scope` when given (`planet`, `<c>[:read|:share]`). */
  createKey(b: { name?: string; scope?: string[] }): Promise<CloudKey>;
  /** The owner's explicit privacy choice for a project (the only way to clear private). */
  setProjectPrivacy(project: string, priv: boolean): Promise<{ project: string; private: boolean }>;
  /** The Constellation copies of one memory. */
  shares(id: string): Promise<CloudShareEdge[]>;
  /**
   * Forgets a memory (already forgotten is fine) and withdraws the copies only this person
   * contributed to; elsewhere it files a removal request with the maintainers.
   */
  forgetEverywhere(id: string): Promise<CloudForgetEverywhere>;
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
  /**
   * This client acting for end user `id` (CON-132): every memory request sends `Oort-User`, and
   * reads and writes that end user's Planet only. Before the first one, the client checks once
   * that whoami lists the key's `end-users` capability (refused with `end-users-unsupported`
   * otherwise): an Oort Cloud without per-user memory would ignore the header and write the
   * account's own Planet. whoami itself is sent without the header.
   */
  forEndUser(id: string): CloudClient;
  /**
   * How many end users the account has (a server key). The account's end-user routes ask no
   * whoami first: Oort Cloud refuses other keys itself, and an older one answers 404
   * (`end-users-unsupported`).
   */
  endUsersCount(): Promise<CloudEndUserCount>;
  /** Erases end user `id` completely (a server key; open whatever the plan's state). */
  eraseEndUser(id: string): Promise<CloudEndUserErasure>;
  /**
   * End user `id`'s memories as export JSON Lines, the manifest first (CON-137; a server key; the
   * same capability check). An erased or unknown end user's export is the manifest alone.
   */
  exportEndUser(id: string): Promise<string>;
}

export interface CloudClientOptions {
  url: string;
  key: string;
  fetch?: typeof fetch;
  /** Per-request timeout; the hooks pass their own budget. */
  timeoutMs?: number;
  /**
   * Keep connections open between requests (`oort serve`, `oort mcp`): requests go through the
   * process's keep-alive pool (`cloud-http.ts`) instead of the global fetch. Ignored with `fetch`.
   */
  keepAlive?: boolean;
  /**
   * `OORT_HOOK_TIMING=1`: ask the API for its Server-Timing breakdown, and time the connection's
   * own phases too (through a pool that connects exactly as the global fetch does).
   */
  serverTiming?: boolean;
}

/**
 * A recall's result with where its time went added to `timings` (numbers only), so the hook log
 * shows it beside the API's own stages: `cloudMs` (the whole request), `cloudHeadersMs` and
 * `cloudBodyMs`, `cloudConnected` (1 when it opened a connection, 0 when it reused one; only
 * known for the keep-alive pool), `cloudDnsMs`, `cloudTcpMs` and
 * `cloudTlsMs` when known, `cloudRecallMs` (the API's recall itself), each Server-Timing
 * metric as `server<Name>Ms`, and `serverLexicalFirstHit` (1: the API answered from its lexical
 * search without embedding the prompt, 0: it embedded) when the API said.
 */
export function withCloudTimings(r: RecallResult, t: CloudTiming): RecallResult {
  const timings: Record<string, number> = { ...r.timings };
  const serverTotal = r.timings?.['totalMs'];
  if (typeof serverTotal === 'number') timings['cloudRecallMs'] = serverTotal;
  timings['cloudMs'] = t.totalMs;
  timings['cloudHeadersMs'] = t.headersMs;
  timings['cloudBodyMs'] = t.bodyMs;
  if (t.connected !== undefined) timings['cloudConnected'] = t.connected ? 1 : 0;
  if (t.dnsMs !== undefined) timings['cloudDnsMs'] = t.dnsMs;
  if (t.tcpMs !== undefined) timings['cloudTcpMs'] = t.tcpMs;
  if (t.tlsMs !== undefined) timings['cloudTlsMs'] = t.tlsMs;
  if (t.lexicalFirst !== undefined)
    timings['serverLexicalFirstHit'] = t.lexicalFirst === 'hit' ? 1 : 0;
  for (const [name, ms] of Object.entries(t.server ?? {})) {
    timings[
      `server${name.charAt(0).toUpperCase()}${name.slice(1).replace(/[^A-Za-z0-9]/g, '')}Ms`
    ] = ms;
  }
  return { ...r, timings };
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createCloudClient(opts: CloudClientOptions): CloudClient {
  // Whether this key may act for end users, checked once (CON-132). Only a yes is kept: a refusal
  // or a failed check is asked again next time, so an Oort Cloud upgrade needs no restart.
  let endUsers: Promise<void> | undefined;
  const requireEndUsers = (): Promise<void> => {
    if (endUsers === undefined) {
      const check = (async () => {
        const me = (await (
          await timedCall('GET', '/v1/whoami', undefined, undefined)
        ).res.json()) as CloudWhoami;
        if (!endUsersAllowed(me)) {
          throw new OortCloudError('end-users-unsupported', 0);
        }
      })();
      endUsers = check;
      check.catch(() => {
        if (endUsers === check) endUsers = undefined;
      });
    }
    return endUsers;
  };
  /** An account's end-user route: a 404 is an Oort Cloud without them (`end-users-unsupported`). */
  const endUserRoute = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof OortCloudError && e.kind === 'not-found') {
        throw new OortCloudError('end-users-unsupported', 404);
      }
      throw e;
    }
  };
  const pooled =
    opts.fetch === undefined && (opts.keepAlive === true || opts.serverTiming === true);
  const doFetch =
    opts.fetch ??
    (opts.keepAlive === true
      ? keepAliveFetch
      : opts.serverTiming === true
        ? timedFetch
        : globalThis.fetch);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * `call`, with a clock: `done()` after reading the body says where the time went. With `user`,
   * the request names that end user (`Oort-User`), and only once the key's capability is known.
   */
  async function timedCall(
    method: string,
    route: string,
    body: { json?: unknown; text?: string } | undefined,
    user: string | undefined,
  ): Promise<{ res: Response; done: () => CloudTiming }> {
    if (user !== undefined) await requireEndUsers();
    const t0 = performance.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    const headers: Record<string, string> = { authorization: `Bearer ${opts.key}` };
    if (user !== undefined) headers[END_USER_HEADER] = user;
    if (opts.serverTiming === true) headers[TIMING_HEADER] = '1';
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
      throw new OortCloudError(
        'network',
        0,
        undefined,
        abort.signal.aborted ? 'timeout' : undefined,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as {
        error?: { code?: unknown; message?: unknown };
      };
      const code = typeof err.error?.code === 'string' ? err.error.code : undefined;
      const message = typeof err.error?.message === 'string' ? err.error.message : undefined;
      throw new OortCloudError(
        cloudErrorKind(res.status, code),
        res.status,
        message,
        code,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }
    const t1 = performance.now();
    const conn = connectedSince(t0);
    const server = parseServerTiming(res.headers.get('server-timing'));
    const lexicalFirst = lexicalFirstOf(res.headers.get('server-timing'));
    return {
      res,
      done: () => {
        const t2 = performance.now();
        return {
          // Behind a proxy the pool cannot see connections, so no record says nothing.
          ...(pooled &&
            (conn !== undefined || poolKnowsConnections()) && { connected: conn !== undefined }),
          ...(conn?.dnsMs !== undefined && { dnsMs: conn.dnsMs }),
          ...(conn?.tcpMs !== undefined && { tcpMs: conn.tcpMs }),
          ...(conn?.tlsMs !== undefined && { tlsMs: conn.tlsMs }),
          headersMs: t1 - t0,
          bodyMs: t2 - t1,
          totalMs: t2 - t0,
          ...(Object.keys(server).length > 0 && { server }),
          ...(lexicalFirst !== undefined && { lexicalFirst }),
        };
      },
    };
  }
  /** The client, acting as the account (`user` undefined) or for one end user. */
  const build = (user: string | undefined): CloudClient => {
    const call = async (
      method: string,
      route: string,
      body?: { json?: unknown; text?: string },
    ): Promise<Response> => (await timedCall(method, route, body, user)).res;
    const json = async <T>(method: string, route: string, body?: unknown): Promise<T> =>
      (await (
        await call(method, route, body === undefined ? undefined : { json: body })
      ).json()) as T;
    /** As the account, whatever this client is: whoami and the end-user routes never name one. */
    const accountJson = async <T>(method: string, route: string): Promise<T> =>
      (await (await timedCall(method, route, undefined, undefined)).res.json()) as T;
    const idPath = (id: string): string => `/v1/memories/${encodeURIComponent(id)}`;
    const cPath = (c: string, rest = ''): string =>
      `/v1/constellations/${encodeURIComponent(c)}${rest}`;

    return {
      url: opts.url,
      whoami: (agent) =>
        accountJson(
          'GET',
          `/v1/whoami${agent === undefined ? '' : `?agent=${encodeURIComponent(agent)}`}`,
        ),
      forEndUser: (id) => build(id),
      // No whoami first (security review, L-b): whoami is refused while Pro has lapsed or the
      // account is blocked, yet Oort Cloud keeps end-user erasure open then. It refuses a key that
      // is not a server key itself (403 end_users_not_allowed); an older one answers 404.
      endUsersCount: () => endUserRoute(accountJson('GET', '/v1/end-users/count')),
      exportEndUser: (id) =>
        endUserRoute(
          timedCall('GET', `/v1/end-users/${encodeURIComponent(id)}/export`, undefined, undefined),
        ).then((r) => r.res.text()),
      eraseEndUser: async (id) => {
        const r: unknown = await endUserRoute(
          accountJson<unknown>('DELETE', `/v1/end-users/${encodeURIComponent(id)}`),
        );
        // What was erased is the proof it happened: an answer without it is not a success.
        const e =
          typeof r === 'object' && r !== null ? (r as { erased?: unknown }).erased : undefined;
        if (typeof e !== 'object' || e === null || Array.isArray(e)) {
          throw new TypeError('Oort Cloud answered an erasure without what it erased.');
        }
        const got = e as Partial<Record<keyof CloudEndUserErasure, unknown>>;
        const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        return {
          memories: n(got.memories),
          coldCopies: n(got.coldCopies),
          turnRefs: n(got.turnRefs),
          cursors: n(got.cursors),
        };
      },
      invite: (c, email, role) =>
        json('POST', cPath(c, '/invites'), { email, ...(role !== undefined && { role }) }),
      invites: async (c) =>
        (await json<{ invites: CloudPendingInvite[] }>('GET', cPath(c, '/invites'))).invites,
      revokeInvite: (c, invite) =>
        json('DELETE', cPath(c, `/invites/${encodeURIComponent(invite)}`)),
      members: async (c) =>
        (await json<{ members: CloudMember[] }>('GET', cPath(c, '/members'))).members,
      setRole: (c, member, role) =>
        json('PUT', cPath(c, `/members/${encodeURIComponent(member)}`), { role }),
      removeMember: (c, member) =>
        json('DELETE', cPath(c, `/members/${encodeURIComponent(member)}`)),
      leave: (c) => json('POST', cPath(c, '/leave')),
      attach: (c, agent, share) =>
        json('POST', cPath(c, '/stars'), { agent, ...(share === true && { share: true }) }),
      detach: (c, agent) => json('DELETE', cPath(c, `/stars/${encodeURIComponent(agent)}`)),
      setPolicy: (c, set) => json('PUT', cPath(c, '/policy'), set),
      contested: async (c) =>
        (await json<{ contested: CloudContest[] }>('GET', cPath(c, '/contested'))).contested,
      resolve: (c, id, keep) =>
        json('POST', cPath(c, `/contested/${encodeURIComponent(id)}`), { keep }),
      bindProject: (c, project) =>
        json('PUT', cPath(c, `/projects/${encodeURIComponent(project)}`)),
      unbindProject: (c, project) =>
        json('DELETE', cPath(c, `/projects/${encodeURIComponent(project)}`)),
      transfer: (c, member) => json('POST', cPath(c, '/transfer'), { member }),
      deleteConstellation: (c) => json('DELETE', cPath(c)),
      adoptConstellation: (c) => json('POST', cPath(c, '/adopt'), {}),
      createKey: (b) => json('POST', '/v1/keys', b),
      recall: async (q) => {
        const { res, done } = await timedCall('POST', '/v1/recall', { json: q }, user);
        const r = (await res.json()) as RecallResult;
        return withCloudTimings(r, done());
      },
      constellations: async () =>
        (await json<{ constellations: CloudConstellation[] }>('GET', '/v1/constellations'))
          .constellations,
      createConstellation: (name, galaxy) =>
        json('POST', '/v1/constellations', { name, ...(galaxy !== undefined && { galaxy }) }),
      galaxies: async () =>
        (await json<{ galaxies: CloudGalaxy[] }>('GET', '/v1/galaxies')).galaxies,
      galaxyMembers: (g) => json('GET', `/v1/galaxies/${encodeURIComponent(g)}/members`),
      share: (to, b) => json('POST', `/v1/constellations/${encodeURIComponent(to)}/share`, b),
      setProjectPrivacy: (project, priv) =>
        json('PUT', `/v1/projects/${encodeURIComponent(project)}/privacy`, { private: priv }),
      shares: async (id) =>
        (await json<{ shares: CloudShareEdge[] }>('GET', `${idPath(id)}/shares`)).shares,
      forgetEverywhere: async (id) => {
        const r = await json<Partial<Record<keyof CloudForgetEverywhere, unknown>>>(
          'DELETE',
          `${idPath(id)}?everywhere=1`,
        );
        const ids = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        return {
          withdrawn: ids(r.withdrawn),
          requested: ids(r.requested),
          unreachable: ids(r.unreachable),
        };
      },
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
  };
  return build(undefined);
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

/** A full memory id: what the API needs to find the copies of a memory already forgotten. */
const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Constellation holding (or that held) a copy of one of your memories (CON-67). */
export interface SharedCopy {
  /** The Constellation's id. */
  constellation: string;
  /** Its name; `null` when the API no longer knows it. */
  name: string | null;
  /** `false` once you left it. */
  member: boolean;
}

/** Each Constellation the edges name, once, with its name (withdrawn edges included). */
export function copiesByConstellation(edges: readonly CloudShareEdge[]): Map<string, SharedCopy> {
  const out = new Map<string, SharedCopy>();
  for (const e of edges) {
    const had = out.get(e.constellation);
    out.set(e.constellation, {
      constellation: e.constellation,
      name: had?.name ?? e.name ?? null,
      member: had?.member ?? e.member ?? true,
    });
  }
  return out;
}

/** The Constellations that still hold a copy (an edge not withdrawn), once each. */
export function liveCopies(edges: readonly CloudShareEdge[]): SharedCopy[] {
  // Withdrawn only when the API gave a time: a missing `withdrawnAt` counts as live.
  return [
    ...copiesByConstellation(
      edges.filter((e) => e.withdrawnAt === null || e.withdrawnAt === undefined),
    ).values(),
  ];
}

/** The copy's Constellation as people read it: its name, else its id. Never escape sequences. */
export function copyName(c: SharedCopy): string {
  return shown(c.name ?? c.constellation);
}

/** `oort-core, checkout (you left)`. */
export function copiesLabel(copies: readonly SharedCopy[]): string {
  return copies.map((c) => copyName(c) + (c.member ? '' : ' (you left)')).join(', ');
}

/**
 * Where a memory is shared, for a plain forget: `[]` outside the hive beta (the route answers 403
 * `hive_not_enabled`) and from an API without the route; `undefined` when the lookup failed
 * otherwise (then nobody can say).
 */
export async function sharesOf(
  client: CloudClient,
  id: string,
): Promise<CloudShareEdge[] | undefined> {
  try {
    return await client.shares(id);
  } catch (e) {
    if (e instanceof OortCloudError && (e.kind === 'hive-not-enabled' || e.kind === 'not-found')) {
      return [];
    }
    return undefined;
  }
}

/** What `forget --everywhere` acts on (CON-67). */
export interface EverywhereTarget {
  id: string;
  /** `null`: already forgotten (a plain forget leaves the shared copies, and their edges). */
  memory: CloudMemory | null;
  /** Every share of it, withdrawn ones included. */
  edges: CloudShareEdge[];
}

/**
 * The memory `forget --everywhere` acts on, and its shares. A plain forget leaves the shared
 * copies: by its full id, a memory already forgotten is still found through their edges, so
 * `--everywhere` can withdraw them afterwards. Outside the hive beta the shares lookup is
 * refused (403 `hive_not_enabled`), before anything is forgotten.
 */
export async function everywhereTarget(
  client: CloudClient,
  ref: string,
): Promise<EverywhereTarget> {
  let memory: CloudMemory;
  try {
    memory = await findCloudMemory(client, ref);
  } catch (e) {
    if (!(e instanceof OortCloudError && e.kind === 'not-found' && FULL_ID.test(ref))) throw e;
    // Only a missing record means "no copies": a refusal (outside the hive beta), a network
    // failure or a 5xx is the real reason, and is what the person sees.
    let edges: CloudShareEdge[];
    try {
      edges = await client.shares(ref);
    } catch (s) {
      if (s instanceof OortCloudError && s.kind === 'not-found') throw e;
      throw s;
    }
    if (liveCopies(edges).length === 0) throw e;
    return { id: ref, memory: null, edges };
  }
  return { id: memory.id, memory, edges: await client.shares(memory.id) };
}

/** The everywhere answer, each Constellation named from the edges (its id where none). */
export function namedOutcome(
  r: CloudForgetEverywhere,
  edges: readonly CloudShareEdge[],
): { withdrawn: SharedCopy[]; requested: SharedCopy[]; unreachable: SharedCopy[] } {
  const by = copiesByConstellation(edges);
  const named = (ids: readonly string[]) =>
    [...new Set(ids)].map((id) => by.get(id) ?? { constellation: id, name: null, member: true });
  return {
    withdrawn: named(r.withdrawn),
    requested: named(r.requested),
    unreachable: named(r.unreachable),
  };
}
