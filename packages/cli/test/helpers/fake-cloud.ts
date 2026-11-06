import { randomUUID } from 'node:crypto';
import CONTRACT from '../cloud-contract.json' with { type: 'json' };

/**
 * An in-process Oort Cloud that follows `cloud-contract.json`: the routes, the request and response
 * shapes and the error shape. No request ever leaves the process. Memories are plain JSON objects
 * (what the API returns: a memory without its embedding).
 */
export type FakeMemory = Record<string, unknown> & {
  id: string;
  text: string;
  scope: Record<string, unknown>;
  tier: string;
  pinned: boolean;
};

export interface FakeCloud {
  fetch: typeof fetch;
  memories: Map<string, FakeMemory>;
  /** `METHOD path` of every request, in order. */
  seen: string[];
  /** Bodies sent to /v1/observe. */
  observed: Record<string, unknown>[];
  /** Import calls so far, and how many succeed before the network "drops" (undefined: never). */
  imports: number;
  failImportsAfter?: number;
  /** Forced status for every route (402, 403 cloud_not_enabled, 429, 503…). */
  refuse?: { status: number; code: string; message: string };
  /**
   * Forced failures per route (the SDK contract suite, CON-108 §10.2): `METHOD /path`, with
   * `:id`-style segments matching any one segment. A number answers that status with the API's
   * usual code for it; `network` drops the connection; `garbage` answers 200 with a body that is
   * not JSON.
   */
  fail?: Record<
    string,
    number | 'network' | 'garbage' | { status: number; code: string; retryAfter?: string }
  >;
  /** Never answers a recall (for hook timeouts). */
  hangRecall?: boolean;
  /** What a recall reports in `degraded` (a server-side stage that was skipped). */
  recallDegraded?: string[];
  /** The plan has lapsed: every route answers 402 except export, which works in every state. */
  lapsed?: boolean;
  /** Stores the next observe, then drops the connection before answering (a crash mid-request). */
  dropAfterObserve?: boolean;
  /** Answers already given per turnRef: a repeat gets the same answer with `duplicate: true`. */
  turns: Map<string, Record<string, unknown>>;
  /** Every `from` sent to /v1/import, in order. */
  importFroms: number[];
  key: string;
  /** The hive beta (CON-63): off answers 403 hive_not_enabled on every Constellation route. */
  hive: FakeHive;
  /** Bodies sent to /v1/recall, and the agent each /v1/whoami named (CON-64). */
  recalls: Record<string, unknown>[];
  whoamiAgents: (string | null)[];
  /** Bodies sent to POST /v1/keys. */
  keyRequests: Record<string, unknown>[];
  /** Whether the key in use is narrowed (whoami's `scope`). */
  narrowed?: boolean;
}

/** A Galaxy as the API lists it (CON-97). */
export interface FakeGalaxy {
  id: string;
  name: string;
  slug: string | null;
  role: string;
  members: number;
  constellations: number;
}

export interface FakeHive {
  enabled: boolean;
  /** CON-97: the account's Galaxies, and each one's people. */
  galaxies: Map<string, FakeGalaxy>;
  galaxyMembers: Map<string, Record<string, unknown>[]>;
  /** Bodies sent to POST /v1/constellations. */
  creates: Record<string, unknown>[];
  /** CON-102: archived Constellations, by id, with the date they are deleted. */
  archived: Map<string, string>;
  constellations: Map<string, { id: string; name: string; role: string; owner: boolean }>;
  /** Shared copies, by id, with the Constellation they are in. */
  shared: Map<string, FakeMemory & { constellation: string; sourceId: string }>;
  /** Every share request body, in order. */
  requests: Record<string, unknown>[];
  /** Each project's privacy as clients stated it (absent: unknown). */
  privacy: Map<string, boolean>;
  /** Preview tokens handed out: what each one binds. */
  previews: Map<string, { mem: string; cid: string; text: string; pii: boolean }>;
  /** CON-64: each Constellation's members (you included, as `you: true`). */
  members: Map<string, FakeMember[]>;
  /** Pending invites per Constellation. */
  invites: Map<
    string,
    { id: string; role: string; email: string; createdAt: string; expiresAt: string }[]
  >;
  /** Attached agents per Constellation: agent → rights asked. */
  stars: Map<string, Map<string, string[]>>;
  /** Bound project ids per Constellation. */
  projects: Map<string, Set<string>>;
  policy: Map<string, string>;
  /** CON-66: each Constellation's supersedeTrust (absent: member). */
  supersedeTrust: Map<string, string>;
  /** CON-66: open contests per Constellation. */
  contests: Map<string, FakeContest[]>;
  /** Set: confirmed shares answer with this outcome (what the vault's Stage C decided). */
  shareOutcome?: string;
  /** Members a Constellation may hold before plan_limit (a test knob, not a plan rule). */
  memberLimit: number;
  /** Set: invites answer with this note (a daily email limit was reached). */
  inviteNote?: string;
}

export interface FakeContest {
  action: 'SUPERSEDE' | 'CORRECT';
  openedAt: string;
  current: FakeMemory;
  challenger: FakeMemory;
}

export interface FakeMember {
  member: string;
  role: string;
  owner: boolean;
  you: boolean;
  email: string | null;
  joinedAt: string;
}

const MATCHERS = [
  ...CONTRACT.routes,
  ...CONTRACT.hive.routes,
  ...CONTRACT.galaxies.routes,
  ...CONTRACT.archive.routes,
  ...CONTRACT.keys.routes,
].map((r) => ({
  method: r.method,
  re: new RegExp(`^${r.path.replace(/\?.*$/, '').replace(/:[a-z]+/g, '[^/]+')}$`),
}));

const RIGHTS: Record<string, string[]> = {
  maintainer: ['read', 'share', 'maintain'],
  member: ['read', 'share'],
  reader: ['read'],
};

/** `maya@example.com` → `ma…@example.com`, as the API hints an address. */
const hint = (email: string): string => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}…@${domain}`;
};

/** What the API's share gate marks: here, email addresses only. */
function findings(text: string): { kind: string; start: number; end: number }[] {
  return [...text.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)].map((m) => ({
    kind: 'email',
    start: m.index,
    end: m.index + m[0].length,
  }));
}

const err = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status });

/** The API's usual error code for a status, for a forced failure given as a number. */
const STATUS_CODE: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  402: 'payment_required',
  403: 'cloud_not_enabled',
  404: 'not_found',
  409: 'ambiguous',
  413: 'too_large',
  429: 'rate_limit',
  500: 'internal',
  503: 'busy',
};

/** The forced failure for one request, if `fail` names its route. */
function forcedFailure(
  fail: FakeCloud['fail'],
  method: string,
  pathname: string,
): Response | undefined {
  if (fail === undefined) return undefined;
  for (const [route, what] of Object.entries(fail)) {
    const [m = '', p = ''] = route.split(' ');
    const re = new RegExp(`^${p.replace(/:[a-zA-Z]+/g, '[^/]+')}$`);
    if (m !== method || !re.test(pathname)) continue;
    if (what === 'network') throw new TypeError('fetch failed');
    if (what === 'garbage') return new Response('<html>not json</html>', { status: 200 });
    const { status, code, retryAfter } =
      typeof what === 'number'
        ? { status: what, code: STATUS_CODE[what] ?? 'error', retryAfter: undefined }
        : what;
    const res = err(status, code, `forced ${status}`);
    if (retryAfter !== undefined) res.headers.set('retry-after', retryAfter);
    return res;
  }
  return undefined;
}

export function fakeMemory(over: Partial<FakeMemory> & { id?: string } = {}): FakeMemory {
  const iso = '2026-10-01T00:00:00.000Z';
  return {
    id: over.id ?? randomUUID(),
    scope: { orgId: 'acct:a1', customerId: 'self', agentId: 'default' },
    type: 'semantic',
    text: 'The auth service listens on port 5582.',
    stub: 'auth service port',
    entities: ['auth-service'],
    salience: 0.5,
    pinned: false,
    tier: 'warm',
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom: iso,
    validTo: null,
    expiredAt: null,
    endReason: null,
    lastConfirmedAt: null,
    supersedes: null,
    supersededBy: null,
    source: { harness: 'oort-cloud', decisions: [] },
    activation: -1.5,
    createdAt: iso,
    updatedAt: iso,
    ...over,
  };
}

export function fakeCloud(key: string): FakeCloud {
  const c: FakeCloud = {
    memories: new Map(),
    seen: [],
    observed: [],
    imports: 0,
    turns: new Map(),
    importFroms: [],
    key,
    hive: {
      enabled: false,
      galaxies: new Map(),
      galaxyMembers: new Map(),
      creates: [],
      archived: new Map(),
      constellations: new Map(),
      shared: new Map(),
      requests: [],
      privacy: new Map(),
      previews: new Map(),
      members: new Map(),
      invites: new Map(),
      stars: new Map(),
      projects: new Map(),
      policy: new Map(),
      supersedeTrust: new Map(),
      contests: new Map(),
      memberLimit: 3,
    },
    recalls: [],
    whoamiAgents: [],
    keyRequests: [],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      c.seen.push(`${req.method} ${url.pathname}`);
      if (!MATCHERS.some((m) => m.method === req.method && m.re.test(url.pathname))) {
        return err(404, 'not_found', 'not a contract route');
      }
      if (req.headers.get('authorization') !== `Bearer ${c.key}`) {
        return err(401, 'unauthorized', 'unknown key');
      }
      if (c.refuse !== undefined) return err(c.refuse.status, c.refuse.code, c.refuse.message);
      const forced = forcedFailure(c.fail, req.method, url.pathname);
      if (forced !== undefined) return forced;
      const p = url.pathname;
      const byName = (ref: string) =>
        [...c.hive.constellations.values()].find((x) => x.id === ref || x.name === ref);
      if (c.lapsed === true && p !== '/v1/export') {
        return err(402, 'payment_required', 'Oort Pro is not active on this account.');
      }
      const project = (m: FakeMemory, want: string | null | undefined): boolean =>
        want === undefined || want === null
          ? true
          : m.scope['projectId'] === want || m.scope['projectId'] === undefined;
      const attached = (cid: string, agent: string): string[] | undefined =>
        c.hive.stars.get(cid)?.get(agent);
      if (p === '/v1/whoami') {
        const agent = url.searchParams.get('agent');
        c.whoamiAgents.push(agent);
        const spaces: Record<string, unknown>[] = [{ level: 'planet' }];
        if (c.hive.enabled) {
          for (const x of c.hive.constellations.values()) {
            let rights = RIGHTS[x.role] ?? [];
            if (agent !== null) {
              const asked = attached(x.id, agent);
              if (asked === undefined) continue;
              rights = rights.filter((r) => asked.includes(r));
            }
            spaces.push({ level: 'constellation', id: x.id, name: x.name, role: x.role, rights });
          }
        }
        const galaxies = c.hive.enabled
          ? [...c.hive.galaxies.values()].map((g) => ({
              id: g.id,
              name: g.name,
              slug: g.slug,
              role: g.role,
            }))
          : [];
        return Response.json({
          account: 'a1',
          plan: 'pro',
          via: 'key',
          spaces,
          ...(galaxies.length > 0 && { galaxies }),
          scope: c.narrowed === true ? 'narrowed' : 'full',
        });
      }
      if (p === '/v1/keys') {
        const b = (await req.json()) as { name?: string; scope?: string[] };
        c.keyRequests.push(b);
        if (b.scope !== undefined && !b.scope.includes('planet')) {
          return err(400, 'bad_request', "A key's scope must include planet.");
        }
        const scope =
          b.scope === undefined
            ? null
            : b.scope.map((s) => {
                const [ref = '', right] = s.split(':');
                const x = byName(ref);
                return ref === 'planet'
                  ? 'planet'
                  : `${x?.id ?? ref}${right === undefined ? '' : `:${right}`}`;
              });
        const made = ['oort', 'sk', 'made'.padEnd(43, 'K')].join('_');
        return Response.json(
          { id: 'k_1', key: made, prefix: made.slice(0, 12), name: b.name ?? 'oort cli', scope },
          { status: 201 },
        );
      }
      const hiveRoute =
        p.startsWith('/v1/constellations') ||
        p.startsWith('/v1/galaxies') ||
        /^\/v1\/memories\/[^/]+\/shares$/.test(p) ||
        (req.method === 'DELETE' && url.searchParams.has('everywhere'));
      if (hiveRoute && !c.hive.enabled) {
        return err(403, 'hive_not_enabled', 'Constellations are in an invite-only beta.');
      }
      const state = (project: unknown, priv: unknown) => {
        // As the API: private is sticky; a later false never clears it.
        if (typeof project === 'string' && typeof priv === 'boolean') {
          c.hive.privacy.set(project, priv || c.hive.privacy.get(project) === true);
        }
      };
      const byRef = (ref: string) =>
        [...c.hive.constellations.values()].find((x) => x.id === ref || x.name === ref);
      if (p === '/v1/constellations' && req.method === 'GET') {
        return Response.json({
          constellations: [...c.hive.constellations.values()].map((x) => ({
            ...x,
            members: 2,
            policy: 'confirm',
            joinedAt: '2026-11-05T00:00:00.000Z',
            ...(c.hive.archived.has(x.id) && { archivedUntil: c.hive.archived.get(x.id) }),
          })),
        });
      }
      const galaxyByRef = (ref: string) =>
        [...c.hive.galaxies.values()].find(
          (g) => g.id === ref || g.slug === ref || g.name.toLowerCase() === ref.toLowerCase(),
        );
      const adoptMatch = /^\/v1\/constellations\/([^/]+)\/adopt$/.exec(p);
      if (adoptMatch !== null) {
        const x = byRef(decodeURIComponent(adoptMatch[1] ?? ''));
        if (x === undefined) return err(404, 'not_found', 'No such Constellation.');
        const archived = c.hive.archived.get(x.id);
        if (!x.owner) return err(403, 'role_required', `Only the owner of ${x.name} can adopt it.`);
        if (archived === undefined) return err(409, 'not_archived', `${x.name} is not archived.`);
        c.hive.archived.delete(x.id);
        return Response.json({ id: x.id, adopted: true });
      }
      if (p === '/v1/galaxies') {
        return Response.json({ galaxies: [...c.hive.galaxies.values()] });
      }
      const galaxyMatch = /^\/v1\/galaxies\/([^/]+)\/members$/.exec(p);
      if (galaxyMatch !== null) {
        const g = galaxyByRef(decodeURIComponent(galaxyMatch[1] ?? ''));
        if (g === undefined) return err(404, 'not_found', 'No such Galaxy.');
        return Response.json({
          galaxy: { id: g.id, name: g.name, slug: g.slug, role: g.role },
          members: c.hive.galaxyMembers.get(g.id) ?? [],
        });
      }
      if (p === '/v1/constellations' && req.method === 'POST') {
        const b = (await req.json()) as { name: string; galaxy?: string };
        c.hive.creates.push(b);
        if (b.galaxy !== undefined) {
          // As the API: a change names the Galaxy by id only.
          const g = c.hive.galaxies.get(b.galaxy);
          if (g === undefined) {
            return galaxyByRef(b.galaxy) === undefined
              ? err(404, 'not_found', 'No such Galaxy.')
              : err(400, 'galaxy_by_id', 'Name the Galaxy by its id here.');
          }
          if (g.role !== 'owner' && g.role !== 'admin') {
            return err(
              403,
              'role_required',
              `Only an admin of ${g.name} can create Constellations in it.`,
            );
          }
        }
        if (c.hive.constellations.size >= 1) return err(403, 'plan_limit', 'One Constellation.');
        const x = { id: 'c_aaaaaaaaaaaaaaaa', name: b.name, role: 'maintainer', owner: true };
        c.hive.constellations.set(x.id, x);
        return Response.json(
          { ...x, members: 1, policy: 'confirm', joinedAt: '2026-11-05T00:00:00.000Z' },
          { status: 201 },
        );
      }
      const privacyMatch = /^\/v1\/projects\/([^/]+)\/privacy$/.exec(p);
      if (privacyMatch !== null && req.method === 'PUT') {
        if (!c.hive.enabled) return err(403, 'hive_not_enabled', 'invite-only beta');
        const project = decodeURIComponent(privacyMatch[1] ?? '');
        const b = (await req.json()) as { private?: unknown };
        if (typeof b.private !== 'boolean') return err(400, 'bad_request', 'private');
        c.hive.privacy.set(project, b.private);
        return Response.json({ project, private: b.private });
      }
      const manage =
        /^\/v1\/constellations\/([^/]+)(\/(invites|members|leave|stars|policy|projects|transfer|contested)(\/([^/]+))?)?$/.exec(
          p,
        );
      if (manage !== null && !(manage[2] === undefined && req.method === 'GET')) {
        const x = byRef(decodeURIComponent(manage[1] ?? ''));
        if (x === undefined) return err(404, 'not_found', 'No such Constellation.');
        const sub = manage[3];
        const arg = manage[5] === undefined ? undefined : decodeURIComponent(manage[5]);
        const members = c.hive.members.get(x.id) ?? [
          {
            member: 'mb_you000000001',
            role: x.role,
            owner: x.owner,
            you: true,
            email: null,
            joinedAt: '2026-11-05T00:00:00.000Z',
          },
        ];
        c.hive.members.set(x.id, members);
        const maintainer = x.role === 'maintainer';
        const needMaintainer = () =>
          err(403, 'role_required', 'Only a maintainer of this Constellation can do that.');
        const find = (ref: string) =>
          members.find(
            (m) =>
              m.member === ref || (m.email !== null && ref.includes('@') && m.email === hint(ref)),
          );
        const body = async () =>
          req.headers.get('content-type') === 'application/json'
            ? ((await req.json()) as Record<string, unknown>)
            : {};
        if (sub === 'invites' && req.method === 'POST') {
          if (!maintainer) return needMaintainer();
          const b = await body();
          const pending = c.hive.invites.get(x.id) ?? [];
          if (members.length + pending.length >= c.hive.memberLimit) {
            return err(403, 'plan_limit', 'This Constellation is full on your plan.');
          }
          const role = typeof b['role'] === 'string' ? b['role'] : 'member';
          const inv = {
            id: `i_${pending.length + 1}`,
            role,
            email: hint(String(b['email'])),
            createdAt: '2026-11-05T00:00:00.000Z',
            expiresAt: '2026-11-12T00:00:00.000Z',
          };
          pending.push(inv);
          c.hive.invites.set(x.id, pending);
          return Response.json(
            {
              id: inv.id,
              constellationId: x.id,
              constellation: x.name,
              role,
              email: inv.email,
              expiresAt: inv.expiresAt,
              link: `https://oortcloud.dev/invite#oort_iv_${'t'.repeat(43)}`,
              emailed: false,
              ...(c.hive.inviteNote !== undefined && { note: c.hive.inviteNote }),
            },
            { status: 201 },
          );
        }
        if (sub === 'invites' && req.method === 'GET') {
          if (!maintainer) return needMaintainer();
          return Response.json({ invites: c.hive.invites.get(x.id) ?? [] });
        }
        if (sub === 'invites' && req.method === 'DELETE') {
          if (!maintainer) return needMaintainer();
          const pending = c.hive.invites.get(x.id) ?? [];
          const left = pending.filter((i) => i.id !== arg);
          c.hive.invites.set(x.id, left);
          return Response.json({ revoked: left.length < pending.length });
        }
        if (sub === 'members' && req.method === 'GET' && arg === undefined) {
          const stars = c.hive.stars.get(x.id) ?? new Map<string, string[]>();
          return Response.json({
            members: members.map((m) => ({
              ...m,
              stars: m.you
                ? [...stars.entries()].map(([agent, asked]) => ({
                    agent,
                    rights: (RIGHTS[x.role] ?? []).filter((r) => asked.includes(r)),
                  }))
                : [],
            })),
          });
        }
        if (sub === 'members' && arg !== undefined) {
          if (!maintainer) return needMaintainer();
          const m = find(arg);
          if (m === undefined) return err(404, 'not_found', 'No such member.');
          if (m.owner) return err(409, 'owner_cannot_be_removed', 'The owner stays a maintainer.');
          if (req.method === 'DELETE') {
            c.hive.members.set(
              x.id,
              members.filter((y) => y !== m),
            );
            return Response.json({ removed: true });
          }
          const b = await body();
          m.role = String(b['role']);
          return Response.json({ member: m.member, role: m.role });
        }
        if (sub === 'leave') {
          if (x.owner) {
            return err(
              409,
              'owner_cannot_leave',
              'Transfer ownership or delete the Constellation.',
            );
          }
          c.hive.constellations.delete(x.id);
          return Response.json({ left: true });
        }
        if (sub === 'stars' && req.method === 'POST') {
          if (x.role === 'reader')
            return err(403, 'role_required', 'Readers cannot attach agents.');
          const b = await body();
          const asked = b['share'] === true ? ['read', 'share'] : ['read'];
          const stars = c.hive.stars.get(x.id) ?? new Map<string, string[]>();
          stars.set(String(b['agent']), asked);
          c.hive.stars.set(x.id, stars);
          const rights = (RIGHTS[x.role] ?? []).filter((r) => asked.includes(r));
          return Response.json({ agent: b['agent'], asked, rights });
        }
        if (sub === 'stars' && req.method === 'DELETE') {
          const stars = c.hive.stars.get(x.id);
          const had = stars?.delete(arg ?? '') ?? false;
          return Response.json({ detached: had });
        }
        if (sub === 'policy') {
          if (!maintainer) return needMaintainer();
          if (c.narrowed === true) return err(403, 'scope_denied', 'This key is narrowed.');
          const b = await body();
          if (b['policy'] === undefined && b['supersedeTrust'] === undefined) {
            return err(400, 'bad_request', 'Send policy, supersedeTrust, or both.');
          }
          if (b['policy'] !== undefined) c.hive.policy.set(x.id, String(b['policy']));
          if (b['supersedeTrust'] !== undefined) {
            if (b['supersedeTrust'] !== 'member' && b['supersedeTrust'] !== 'maintainer') {
              return err(400, 'bad_request', 'supersedeTrust must be member or maintainer.');
            }
            c.hive.supersedeTrust.set(x.id, String(b['supersedeTrust']));
          }
          return Response.json({
            policy: c.hive.policy.get(x.id) ?? 'confirm',
            supersedeTrust: c.hive.supersedeTrust.get(x.id) ?? 'member',
            policyVersion: 2,
          });
        }
        if (sub === 'contested' && req.method === 'GET' && arg === undefined) {
          return Response.json({ contested: c.hive.contests.get(x.id) ?? [] });
        }
        if (sub === 'contested' && req.method === 'POST' && arg !== undefined) {
          if (!maintainer) return needMaintainer();
          if (c.narrowed === true) return err(403, 'scope_denied', 'This key is narrowed.');
          const b = await body();
          const keep = String(b['keep']);
          const open = c.hive.contests.get(x.id) ?? [];
          const has = (k: FakeContest, id: string) => k.current.id === id || k.challenger.id === id;
          const found = open.filter((k) => has(k, arg) && has(k, keep));
          if (found.length !== 1)
            return err(404, 'not_found', 'No open contest holds these memories.');
          const k = found[0]!;
          c.hive.contests.set(
            x.id,
            open.filter((o) => o !== k),
          );
          const keptChallenger = keep === k.challenger.id;
          return Response.json({
            kept: keep,
            ended: keptChallenger ? k.current.id : k.challenger.id,
            action: keptChallenger ? k.action : 'RETRACT',
            nodeVersion: 7,
          });
        }
        if (sub === 'projects' && arg !== undefined) {
          if (!maintainer) return needMaintainer();
          const set = c.hive.projects.get(x.id) ?? new Set<string>();
          if (req.method === 'PUT') set.add(arg);
          else set.delete(arg);
          c.hive.projects.set(x.id, set);
          return Response.json({ project: arg, bound: req.method === 'PUT' });
        }
        if (sub === 'transfer') {
          if (!x.owner) return err(403, 'role_required', 'Only the owner can transfer ownership.');
          const b = await body();
          const m = find(String(b['member']));
          if (m === undefined) return err(404, 'not_found', 'No such member.');
          x.owner = false;
          return Response.json({ owner: true, member: m.member });
        }
        if (sub === undefined && req.method === 'DELETE') {
          if (!x.owner) return err(403, 'role_required', 'Only the owner can delete it.');
          c.hive.constellations.delete(x.id);
          return Response.json({ deleted: true, memories: 0 });
        }
      }
      const shareMatch = /^\/v1\/constellations\/([^/]+)\/share$/.exec(p);
      if (shareMatch !== null) {
        const ref = decodeURIComponent(shareMatch[1] ?? '');
        const b = (await req.json()) as {
          memoryId: string;
          text?: string;
          confirm?: boolean;
          project?: string;
          projectPrivate?: boolean;
          previewToken?: string;
          acknowledgedFindings?: boolean;
        };
        c.hive.requests.push({ to: ref, ...b });
        state(b.project, b.projectPrivate);
        // As the API: a confirm names the previewed id; a name several share is refused.
        const isId = /^c_[a-z0-9]{16}$/.test(ref);
        if (b.confirm === true && !isId) {
          return err(400, 'confirm_by_id', 'Confirm with the constellationId of the preview.');
        }
        const named = [...c.hive.constellations.values()].filter((x) => x.name === ref);
        if (!isId && named.length > 1) {
          const list = named.map((x) => `${x.name} (${x.id.slice(0, 6)})`).join(', ');
          return err(
            409,
            'ambiguous_constellation',
            `Several of your Constellations have this name: ${list}.`,
          );
        }
        const to = isId ? c.hive.constellations.get(ref) : byRef(ref);
        if (to === undefined) return err(404, 'not_found', 'No such Constellation.');
        const m = c.memories.get(b.memoryId);
        if (m === undefined) return err(404, 'not_found', 'No memory with this id.');
        if (b.confirm === true) {
          const pv = b.previewToken === undefined ? undefined : c.hive.previews.get(b.previewToken);
          if (pv === undefined || pv.mem !== m.id || pv.cid !== to.id || pv.text !== b.text) {
            return err(409, 'preview_required', 'Preview this share again, then confirm it.');
          }
          if (pv.pii && b.acknowledgedFindings !== true) {
            return err(409, 'findings_unacknowledged', 'Acknowledge the personal data first.');
          }
        }
        if (b.confirm === true && to.role === 'reader') {
          return err(403, 'share_denied', 'Your role in this Constellation cannot share.');
        }
        // The memory's own project decides, as stated by a client inside it.
        const project = m.scope['projectId'];
        if (typeof project === 'string') {
          const priv = c.hive.privacy.get(project);
          if (priv === true) {
            return err(403, 'share_denied', 'Memories from a private project stay inside it.');
          }
          if (priv === undefined) {
            return err(
              409,
              'project_privacy_unknown',
              "Oort doesn't know whether this memory's project is private. Set \"private\": false in that project's oort.config.json, or run `oort project privacy public` inside it, then share again.",
            );
          }
        }
        const text = b.text ?? m.text;
        const base = {
          memoryId: m.id,
          constellation: to.name,
          constellationId: to.id,
          text,
          findings: findings(text),
        };
        if (b.confirm !== true) {
          const previewToken = `pv_${randomUUID()}`;
          c.hive.previews.set(previewToken, {
            mem: m.id,
            cid: to.id,
            text,
            pii: base.findings.length > 0,
          });
          return Response.json({ confirmed: false, ...base, previewToken });
        }
        // One live copy per (source, Constellation): sharing again updates it.
        const copyId = `copy-${m.id}-${to.id}`;
        const copy = { ...fakeMemory({ id: copyId, text }), constellation: to.id, sourceId: m.id };
        c.hive.shared.set(copy.id, copy);
        return Response.json({
          confirmed: true,
          ...base,
          id: copy.id,
          ...(c.hive.shareOutcome !== undefined && { outcome: c.hive.shareOutcome }),
        });
      }
      if (p === '/v1/recall') {
        const b = (await req.json()) as {
          text: string;
          project?: string;
          k?: number;
          projectPrivate?: boolean;
        };
        c.recalls.push(b);
        state(b.project, b.projectPrivate);
        if (c.hangRecall === true) return new Promise<Response>(() => {});
        const words = b.text
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 3);
        const include = (b as { include?: string[] }).include;
        const wantsHive = include === undefined || include.includes('constellation');
        const wantsPlanet =
          include === undefined || include.includes('planet') || include.includes('self');
        if (include?.includes('constellation') && c.hive.constellations.size === 0) {
          return err(400, 'scope_denied', 'This recall cannot read constellation.');
        }
        const match = (m: FakeMemory) => words.some((w) => m.text.toLowerCase().includes(w));
        const own = wantsPlanet
          ? [...c.memories.values()].filter((m) => project(m, b.project) && match(m))
          : [];
        // An agent reads only the Constellations it is attached to (CON-64).
        const agent = (b as { agent?: string }).agent;
        const shared = wantsHive
          ? [...c.hive.shared.values()]
              .filter((x) => agent === undefined || attached(x.constellation, agent) !== undefined)
              .filter(match)
          : [];
        const hits = [
          ...own.map((m) => ({ ...m, origin: undefined as unknown })),
          ...shared.map(({ constellation, sourceId: _s, ...m }) => ({
            ...m,
            address: { level: 'hive', orgId: 'org:g1', hiveId: constellation },
            origin: {
              level: 'hive',
              space: 'Constellation',
              node: `Constellation ${c.hive.constellations.get(constellation)?.name ?? constellation}`,
              from: 'from a Constellation',
              home: false,
              author: 'default',
            },
          })),
        ];
        return Response.json({
          memories: hits.slice(0, b.k ?? 10).map(({ origin, ...m }) => ({
            ...m,
            ...(origin !== undefined && { origin }),
            explanation: { fused: 1, rrf: 1, coverage: 1, activation: 0, hydrated: false },
          })),
          timings: { totalMs: 2 },
          ...(c.recallDegraded !== undefined && { degraded: c.recallDegraded }),
        });
      }
      if (p === '/v1/observe') {
        const b = (await req.json()) as Record<string, unknown>;
        c.observed.push(b);
        state(b['project'], b['projectPrivate']);
        const o = b['observation'] as { user: string };
        const ref = typeof b['turnRef'] === 'string' ? b['turnRef'] : undefined;
        if (ref !== undefined && ref.length > 128)
          return err(400, 'bad_request', 'turnRef too long');
        const seenTurn = ref === undefined ? undefined : c.turns.get(ref);
        if (seenTurn !== undefined) return Response.json({ ...seenTurn, duplicate: true });
        const m = fakeMemory({
          text: o.user,
          ...(typeof b['project'] === 'string' && {
            scope: {
              orgId: 'acct:a1',
              customerId: 'self',
              agentId: 'default',
              projectId: b['project'],
            },
          }),
        });
        c.memories.set(m.id, m);
        const answer = {
          outcome: 'added',
          memories: [{ id: m.id, action: 'added' }],
          counts: { added: 1 },
        };
        if (ref !== undefined) c.turns.set(ref, answer);
        if (c.dropAfterObserve === true) {
          c.dropAfterObserve = false;
          throw new TypeError('fetch failed'); // saved, but the answer never arrives
        }
        return Response.json(answer);
      }
      if (p === '/v1/memories') {
        const q = url.searchParams;
        const all = [...c.memories.values()]
          .filter((m) => project(m, q.get('project')))
          .filter((m) => q.get('tier') === null || m.tier === q.get('tier'))
          .filter((m) => q.get('pinned') === null || m.pinned === (q.get('pinned') === 'true'));
        const limit = Math.min(Number(q.get('limit') ?? '50'), CONTRACT.limits.listLimit);
        const start = q.get('cursor') === null ? 0 : Number.parseInt(q.get('cursor') ?? '0', 36);
        const page = all.slice(start, start + limit);
        const next = start + page.length;
        return Response.json({
          memories: page,
          ...(next < all.length && { next: next.toString(36) }),
        });
      }
      const sharesMatch = /^\/v1\/memories\/([^/]+)\/shares$/.exec(p);
      if (sharesMatch !== null) {
        const id = decodeURIComponent(sharesMatch[1] ?? '');
        return Response.json({
          shares: [...c.hive.shared.values()]
            .filter((x) => x.sourceId === id)
            .map((x) => ({
              constellation: x.constellation,
              name: c.hive.constellations.get(x.constellation)?.name ?? null,
              id: x.id,
              at: '2026-11-05T00:00:00.000Z',
              withdrawnAt: null,
            })),
        });
      }
      if (req.method === 'DELETE' && url.searchParams.has('everywhere')) {
        const id = decodeURIComponent(p.split('/').pop() ?? '');
        if (!c.memories.has(id)) return err(404, 'not_found', 'No such memory.');
        c.memories.delete(id);
        const withdrawn: string[] = [];
        for (const x of c.hive.shared.values()) {
          if (x.sourceId !== id) continue;
          c.hive.shared.delete(x.id);
          withdrawn.push(x.constellation);
        }
        return Response.json({ withdrawn, requested: [], unreachable: [] });
      }
      const idMatch = /^\/v1\/memories\/([^/]+)(\/(pin|unpin))?$/.exec(p);
      if (idMatch !== null) {
        const ref = decodeURIComponent(idMatch[1] ?? '');
        let m = c.memories.get(ref);
        if (
          m === undefined &&
          ref.length >= 8 &&
          idMatch[3] === undefined &&
          req.method === 'GET'
        ) {
          const hits = [...c.memories.values()].filter((x) => x.id.startsWith(ref));
          if (hits.length > 1)
            return err(409, 'ambiguous', `${hits.length} memories start with this prefix.`);
          m = hits[0];
        }
        if (m === undefined) return err(404, 'not_found', 'No such memory.');
        const id = m.id;
        if (idMatch[3] !== undefined) {
          c.memories.set(id, { ...m, pinned: idMatch[3] === 'pin' });
          return new Response(null, { status: 204 });
        }
        if (req.method === 'DELETE') {
          c.memories.delete(id);
          return new Response(null, { status: 204 });
        }
        return Response.json(m);
      }
      if (p === '/v1/stats') {
        const tiers = { hot: 0, warm: 0, cold: 0 } as Record<string, number>;
        for (const m of c.memories.values()) tiers[m.tier] = (tiers[m.tier] ?? 0) + 1;
        return Response.json({
          tiers,
          memories: c.memories.size,
          databaseBytes: 4096,
          lastConsolidatedAt: null,
        });
      }
      if (p === '/v1/export') {
        const lines = [
          JSON.stringify({ oort: 'export', version: 1, memories: c.memories.size, scopes: [] }),
          ...[...c.memories.values()].map((m) => JSON.stringify(m)),
        ];
        return new Response(lines.map((l) => `${l}\n`).join(''), {
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }
      if (p === '/v1/import') {
        c.imports++;
        if (c.failImportsAfter !== undefined && c.imports > c.failImportsAfter) {
          throw new TypeError('fetch failed'); // the network drops
        }
        const text = await req.text();
        if (Buffer.byteLength(text) > CONTRACT.limits.importBytes) {
          return err(413, 'too_large', 'Send at most 10 MB per request.');
        }
        const lines = text.split('\n').filter((l) => l.length > 0);
        const from = Number(url.searchParams.get('from') ?? '0');
        c.importFroms.push(from);
        const manifest = JSON.parse(lines[0] ?? '{}') as { oort?: string; version?: number };
        if (manifest.oort !== 'export' || manifest.version !== 1) {
          return err(400, 'bad_request', 'The first line must be an Oort export manifest.');
        }
        let imported = 0;
        let skipped = 0;
        const begin = from === 0 ? 1 : from;
        const end = Math.min(lines.length, begin + CONTRACT.limits.importLinesPerCall);
        for (let i = begin; i < end; i++) {
          const m = JSON.parse(lines[i] as string) as FakeMemory;
          if (c.memories.has(m.id)) skipped++;
          else {
            // As the real import does: every line is re-scoped to the account's own Planet (its
            // project kept), whichever principal or author the line names.
            const projectId = m.scope['projectId'];
            c.memories.set(m.id, {
              ...m,
              scope: {
                orgId: 'acct:a1',
                customerId: 'self',
                agentId: 'default',
                ...(typeof projectId === 'string' && { projectId }),
              },
              embedding: undefined,
            } as FakeMemory);
            imported++;
          }
        }
        return Response.json({
          imported,
          skipped,
          reembedded: 0,
          ...(end < lines.length && { next: end }),
        });
      }
      return err(404, 'not_found', 'unhandled');
    }) as typeof fetch,
  };
  return c;
}
