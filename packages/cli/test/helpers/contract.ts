import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addressed,
  confirmJudgment,
  isUnconfirmedAgentJudgment,
  localGrant,
  nodeGrant,
  recordJudgment,
  type Memory,
  type Place,
  type NodeRef,
} from '@oortmem/core';
import { openSqliteStore } from '@oortmem/store-sqlite';
import type { FakeCloud } from './fake-cloud.js';
import { FAKE_DIMENSION, hashEmbedder } from './sdk-fakes.js';

/**
 * The SDK contract suite's shared pieces (CON-108 §10): the JSON cases, the fixture secrets, the
 * matchers and the seeding. The TypeScript runner (src/sdk/contract.test.ts) and the Python
 * runner's harness (src/sdk/python.test.ts) both use them, so both run the same cases on the
 * same stores.
 */

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../contract/sdk',
);

export type Transport = 'local' | 'cloud';
export type FailSpec = NonNullable<FakeCloud['fail']>;

export interface Step {
  call: string;
  /** The handle to call: a name saved by a `scoped` step's `as`; default the root. */
  on?: string;
  as?: string;
  args?: unknown;
  expect?: { result?: unknown; error?: unknown };
  save?: Record<string, string>;
  cloud?: { fail?: FailSpec };
}

export interface Case {
  id: string;
  description?: string;
  transports: Transport[];
  seed?: string;
  options?: Record<string, unknown>;
  now?: string;
  /** `none`: no model adapters and no keys (local). */
  adapters?: 'fake' | 'none';
  /** Today's count in the shared agent judgment counter. */
  counter?: number;
  /** `agents.json` in the home: which agents keep a Star. */
  agents?: Record<string, { star: boolean }>;
  cloud?: {
    fail?: FailSpec;
    noKey?: boolean;
    memories?: number;
    /**
     * Per-user memory (CON-132): `server-key`, the key acts for end users; `legacy`, an Oort Cloud
     * from before it (Oort-User ignored). Absent: a current cloud, a key without the capability.
     */
    endUsers?: 'server-key' | 'legacy';
  };
  expectCreate?: { error: unknown };
  steps: Step[];
}

export interface SeedMemory {
  id: string;
  text: string;
  type?: Memory['type'];
  level?: 'planet' | 'star';
  org?: string;
  user?: string;
  agent?: string;
  project?: string | null;
  pinned?: boolean;
  validFrom?: string;
  validTo?: string | null;
  expiredAt?: string | null;
  endReason?: Memory['endReason'];
  supersedes?: string | null;
  supersededBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** Where it is (spatial memory, CON-84); local transports only. */
  place?: Place;
}

export interface SeedJudgment {
  subject: string;
  verdict: string;
  reason: string;
  domain: string;
  by: string;
  ref?: string;
  via?: 'cli' | 'mcp';
  confirmed?: boolean;
}

export interface Seed {
  memories?: SeedMemory[];
  judgments?: SeedJudgment[];
}

export const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

export const CASES = fs
  .readdirSync(path.join(ROOT, 'cases'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .flatMap((f) => readJson<Case[]>(path.join(ROOT, 'cases', f)).map((c) => ({ file: f, c })));

/** The fixture secrets (base64, so the public-repo check stays clean), decoded at runtime. */
export const SECRETS = fs
  .readFileSync(path.resolve(ROOT, '../../packages/core/test/fixtures/secrets.b64.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.length > 0)
  .map((l) => {
    const tab = l.indexOf('\t');
    const [secret = '', ...rest] = Buffer.from(l.slice(tab + 1), 'base64')
      .toString('utf8')
      .split('\t');
    return { kind: l.slice(0, tab), secret, text: rest.join('\t') };
  });

export const secretText = (kind: string): string => {
  const s = SECRETS.find((x) => x.kind === kind);
  if (s === undefined) throw new Error(`no fixture secret of kind ${kind}`);
  return s.text;
};

/** No fixture secret anywhere in what a call returned or threw. */
export function expectNoSecret(v: unknown): void {
  const text = JSON.stringify(v, (_k, x: unknown) =>
    x instanceof Error ? { ...x, message: x.message } : x,
  );
  for (const s of SECRETS) {
    if (s.secret.length >= 8 && text.includes(s.secret)) {
      throw new Error(`a fixture secret (${s.kind}) came back in a result`);
    }
  }
}

/** `${name}` from saved values (a whole-string reference keeps the value itself), `${secret:kind}`. */
export function substitute(v: unknown, saved: Map<string, unknown>): unknown {
  if (typeof v === 'string') {
    const whole = /^\$\{([^}]+)\}$/.exec(v);
    if (whole !== null && !whole[1]!.startsWith('secret:') && saved.has(whole[1]!)) {
      return saved.get(whole[1]!);
    }
    return v.replace(/\$\{([^}]+)\}/g, (m, name: string) => {
      if (name.startsWith('secret:')) return secretText(name.slice(7));
      if (name.startsWith('repeat:')) {
        const [, n, ch] = /^repeat:(\d+):(.*)$/.exec(name) ?? [];
        return (ch ?? 'x').repeat(Number(n));
      }
      return saved.has(name) ? String(saved.get(name)) : m;
    });
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, saved));
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, saved)]));
  }
  return v;
}

/** `$`, `.key` and `[n]` paths into a result. */
export function pick(v: unknown, p: string): unknown {
  let cur = v;
  for (const part of p.replace(/^\$/, '').match(/\.[^.[]+|\[\d+\]/g) ?? []) {
    if (cur === null || cur === undefined) return undefined;
    cur = part.startsWith('[')
      ? (cur as unknown[])[Number(part.slice(1, -1))]
      : (cur as Record<string, unknown>)[part.slice(1)];
  }
  return cur;
}

export const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

/**
 * The matchers (§10.1): `$type`, `$len`, `$some`, `$every`, `$none`, `$absent`, `$regex`,
 * `$approx` (with `$tol`). Plain objects match a subset (unknown result fields are ignored);
 * arrays match element by element.
 */
export function matches(actual: unknown, expected: unknown, at: string, problems: string[]): void {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    const e = expected as Record<string, unknown>;
    const ops = Object.keys(e).filter((k) => k.startsWith('$'));
    if (ops.length > 0) {
      for (const op of ops) {
        const x = e[op];
        switch (op) {
          case '$type':
            if (typeOf(actual) !== x)
              problems.push(`${at}: type ${typeOf(actual)}, not ${String(x)}`);
            break;
          case '$len': {
            const n = (actual as { length?: number } | null)?.length;
            if (n !== x) problems.push(`${at}: length ${String(n)}, not ${String(x)}`);
            break;
          }
          case '$some':
          case '$every':
          case '$none': {
            if (!Array.isArray(actual)) {
              problems.push(`${at}: not an array`);
              break;
            }
            const ok = actual.map((a, i) => {
              const p: string[] = [];
              matches(a, x, `${at}[${i}]`, p);
              return p.length === 0;
            });
            if (op === '$some' && !ok.some(Boolean)) problems.push(`${at}: no element matches`);
            if (op === '$every' && !ok.every(Boolean)) problems.push(`${at}: an element differs`);
            if (op === '$none' && ok.some(Boolean)) problems.push(`${at}: an element matches`);
            break;
          }
          case '$absent':
            if (actual !== undefined) problems.push(`${at}: present`);
            break;
          case '$regex':
            if (typeof actual !== 'string' || !new RegExp(String(x)).test(actual))
              problems.push(`${at}: ${JSON.stringify(actual)} does not match /${String(x)}/`);
            break;
          case '$approx': {
            const tol = typeof e['$tol'] === 'number' ? e['$tol'] : 1e-6;
            if (typeof actual !== 'number' || Math.abs(actual - Number(x)) > tol)
              problems.push(`${at}: ${String(actual)} is not about ${String(x)}`);
            break;
          }
          case '$tol':
            break;
          default:
            problems.push(`${at}: unknown matcher ${op}`);
        }
      }
      return;
    }
    if (actual === null || typeof actual !== 'object') {
      problems.push(`${at}: ${JSON.stringify(actual)} is not an object`);
      return;
    }
    for (const [k, x] of Object.entries(e)) {
      matches((actual as Record<string, unknown>)[k], x, `${at}.${k}`, problems);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      problems.push(`${at}: ${JSON.stringify(actual)} is not an array of ${expected.length}`);
      return;
    }
    expected.forEach((x, i) => matches(actual[i], x, `${at}[${i}]`, problems));
    return;
  }
  if (actual !== expected)
    problems.push(`${at}: ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`);
}

export function expectMatch(actual: unknown, expected: unknown, what: string): void {
  const problems: string[] = [];
  matches(actual, expected, '$', problems);
  if (problems.length > 0) {
    throw new Error(
      `${what}:\n  ${problems.join('\n  ')}\nactual: ${JSON.stringify(actual, null, 2).slice(0, 2000)}`,
    );
  }
}

export const errorShape = (e: unknown): Record<string, unknown> => {
  const x = e as Record<string, unknown>;
  return {
    name: x['name'],
    code: x['code'],
    reason: x['reason'],
    fix: x['fix'],
    status: x['status'],
    retryable: x['retryable'],
    retryAfter: x['retryAfter'],
    role: x['role'],
    envVar: x['envVar'],
    message: x['message'],
  };
};

// In the past: the store's own listing reads the real clock, so a later `now` would hide new records.
export const DEFAULT_NOW = '2026-11-05T12:00:00.000Z';

export function seedMemory(s: SeedMemory): Memory {
  const level = s.level ?? 'planet';
  const scope = {
    orgId: s.org ?? 'local',
    customerId: s.user ?? 'self',
    agentId: s.agent ?? 'anonymous',
    ...(s.project != null && { projectId: s.project }),
  };
  const created = s.createdAt ?? '2026-10-01T00:00:00.000Z';
  return {
    id: s.id,
    scope,
    ...(level === 'star' &&
      addressed(
        {
          level: 'agent',
          orgId: scope.orgId,
          agentId: scope.agentId,
          ...(s.project != null && { projectId: s.project }),
        },
        { agentId: scope.agentId },
      )),
    type: s.type ?? 'semantic',
    text: s.text,
    stub: s.text.slice(0, 40),
    entities: [],
    salience: 0.5,
    pinned: s.pinned ?? false,
    tier: 'warm',
    accessLog: { count: 0, recent: [], compactedSum: 0, compactedAt: null },
    validFrom: s.validFrom ?? created,
    validTo: s.validTo ?? null,
    expiredAt: s.expiredAt ?? null,
    endReason: s.endReason ?? null,
    lastConfirmedAt: null,
    supersedes: s.supersedes ?? null,
    supersededBy: s.supersededBy ?? null,
    ...(s.place !== undefined && { place: s.place }),
    source: { harness: 'seed', decisions: [] },
    createdAt: created,
    updatedAt: s.updatedAt ?? created,
  } as Memory;
}

/** Writes a case's seed into a fresh local store, as each memory's own node's writer. */
export async function seedLocal(home: string, seed: Seed, now: string): Promise<void> {
  const store = await openSqliteStore({
    path: path.join(home, 'oort.sqlite'),
    coldDir: path.join(home, 'cold'),
    dimension: FAKE_DIMENSION,
  });
  const embed = hashEmbedder();
  try {
    for (const raw of seed.memories ?? []) {
      const s = substitute(raw, new Map()) as SeedMemory;
      const m = seedMemory(s);
      const [v] = await embed.embed([m.text], 'document');
      const principal = {
        orgId: s.org ?? 'local',
        customerId: s.user ?? 'self',
        agentId: s.agent ?? 'anonymous',
      };
      const node: NodeRef =
        (s.level ?? 'planet') === 'star'
          ? { level: 'agent', orgId: principal.orgId, agentId: principal.agentId }
          : { level: 'user', orgId: principal.orgId, customerId: principal.customerId };
      const grant = nodeGrant({ principal, read: [{ node, projectIds: 'all' }] });
      await store.upsert(grant, { ...m, ...(v !== undefined && { embedding: v }) });
    }
    for (const j of seed.judgments ?? []) {
      const scope = { orgId: 'local', customerId: 'self', agentId: 'anonymous' };
      const grant = localGrant({ ...scope, projectIds: [null] });
      const r = await recordJudgment(
        {
          subject: j.subject,
          verdict: j.verdict,
          reason: j.reason,
          domain: j.domain,
          by: j.by,
          ...(j.ref !== undefined && { ref: j.ref }),
        },
        {
          store,
          grant,
          scope,
          embed,
          via: j.via ?? 'cli',
          harness: 'seed',
          now: new Date(Date.parse(now) - 86_400_000),
        },
      );
      if (j.confirmed === true)
        await confirmJudgment(store, grant, r.memory, 'seed', new Date(now));
    }
  } finally {
    await store.close();
  }
}

/** Reads a judgment as a 0.5.x reader does: the stored record and core's own predicate. */
export async function readJudgment(home: string, id: string): Promise<Record<string, unknown>> {
  const store = await openSqliteStore({
    path: path.join(home, 'oort.sqlite'),
    coldDir: path.join(home, 'cold'),
    dimension: FAKE_DIMENSION,
  });
  try {
    const grant = localGrant({
      orgId: 'local',
      customerId: 'self',
      agentId: 'anonymous',
      projectIds: [null],
    });
    const m = await store.get(grant, id);
    if (m?.judgment === undefined) return { found: false };
    return {
      found: true,
      via: m.judgment.via,
      harness: m.source.harness,
      unconfirmedAgent: isUnconfirmedAgentJudgment(m.judgment),
      text: m.text,
    };
  } finally {
    await store.close();
  }
}

/** Sets the fake cloud's per-user memory as a case's `cloud.endUsers` names it (CON-132). */
export function endUsersOf(fake: FakeCloud, c: Case): void {
  if (c.cloud?.endUsers === 'legacy') fake.endUsers.server = 'legacy';
  if (c.cloud?.endUsers === 'server-key') fake.endUsers.serverKey = true;
}
