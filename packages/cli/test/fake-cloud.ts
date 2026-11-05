import { randomUUID } from 'node:crypto';
import CONTRACT from './cloud-contract.json' with { type: 'json' };

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
}

const MATCHERS = CONTRACT.routes.map((r) => ({
  method: r.method,
  re: new RegExp(`^${r.path.replace(':id', '[^/]+')}$`),
}));

const err = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status });

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
      const p = url.pathname;
      if (c.lapsed === true && p !== '/v1/export') {
        return err(402, 'payment_required', 'Oort Pro is not active on this account.');
      }
      const project = (m: FakeMemory, want: string | null | undefined): boolean =>
        want === undefined || want === null
          ? true
          : m.scope['projectId'] === want || m.scope['projectId'] === undefined;
      if (p === '/v1/whoami') return Response.json({ account: 'a1', plan: 'pro', via: 'key' });
      if (p === '/v1/recall') {
        const b = (await req.json()) as { text: string; project?: string; k?: number };
        if (c.hangRecall === true) return new Promise<Response>(() => {});
        const words = b.text
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 3);
        const hits = [...c.memories.values()].filter(
          (m) => project(m, b.project) && words.some((w) => m.text.toLowerCase().includes(w)),
        );
        return Response.json({
          memories: hits.slice(0, b.k ?? 10).map((m) => ({
            ...m,
            explanation: { fused: 1, rrf: 1, coverage: 1, activation: 0, hydrated: false },
          })),
          timings: { totalMs: 2 },
          ...(c.recallDegraded !== undefined && { degraded: c.recallDegraded }),
        });
      }
      if (p === '/v1/observe') {
        const b = (await req.json()) as Record<string, unknown>;
        c.observed.push(b);
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
