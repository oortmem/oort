import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  addressed,
  confirmJudgment,
  isUnconfirmedAgentJudgment,
  localGrant,
  nodeGrant,
  recordJudgment,
  setAgentStar,
  type Memory,
  type NodeRef,
} from '@oortmem/core';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { tmpdir } from '../../test/helpers.js';
import { fakeCloud, fakeMemory, type FakeCloud } from '../../test/helpers/fake-cloud.js';
import { FAKE_DIMENSION, fakeAdapters, hashEmbedder } from '../../test/helpers/sdk-fakes.js';
import { createOortWith } from './create.js';
import type { Oort, RecallResult } from './types.js';
import { formatForPrompt } from './views.js';

/**
 * The SDK contract suite's TypeScript runner (CON-108 §10). The cases live in `contract/sdk/` as
 * JSON, in camelCase wire names, so the Python runner (0.7) reads the same files. Each case runs
 * on every transport it names: `local` (the in-process engine with deterministic fakes, through
 * the internal test hook) and `cloud` (the shared fake Oort Cloud).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../contract/sdk');

type Transport = 'local' | 'cloud';
type FailSpec = NonNullable<FakeCloud['fail']>;

interface Step {
  call: string;
  /** The handle to call: a name saved by a `scoped` step's `as`; default the root. */
  on?: string;
  as?: string;
  args?: unknown;
  expect?: { result?: unknown; error?: unknown };
  save?: Record<string, string>;
  cloud?: { fail?: FailSpec };
}

interface Case {
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
  cloud?: { fail?: FailSpec; noKey?: boolean; memories?: number };
  expectCreate?: { error: unknown };
  steps: Step[];
}

interface SeedMemory {
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
}

interface SeedJudgment {
  subject: string;
  verdict: string;
  reason: string;
  domain: string;
  by: string;
  ref?: string;
  via?: 'cli' | 'mcp';
  confirmed?: boolean;
}

interface Seed {
  memories?: SeedMemory[];
  judgments?: SeedJudgment[];
}

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

const CASES = fs
  .readdirSync(path.join(ROOT, 'cases'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .flatMap((f) => readJson<Case[]>(path.join(ROOT, 'cases', f)).map((c) => ({ file: f, c })));

/** The fixture secrets (base64, so the public-repo check stays clean), decoded at runtime. */
const SECRETS = fs
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

const secretText = (kind: string): string => {
  const s = SECRETS.find((x) => x.kind === kind);
  if (s === undefined) throw new Error(`no fixture secret of kind ${kind}`);
  return s.text;
};

/** No fixture secret anywhere in what a call returned or threw. */
function expectNoSecret(v: unknown): void {
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
function substitute(v: unknown, saved: Map<string, unknown>): unknown {
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
function pick(v: unknown, p: string): unknown {
  let cur = v;
  for (const part of p.replace(/^\$/, '').match(/\.[^.[]+|\[\d+\]/g) ?? []) {
    if (cur === null || cur === undefined) return undefined;
    cur = part.startsWith('[')
      ? (cur as unknown[])[Number(part.slice(1, -1))]
      : (cur as Record<string, unknown>)[part.slice(1)];
  }
  return cur;
}

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

/**
 * The matchers (§10.1): `$type`, `$len`, `$some`, `$every`, `$none`, `$absent`, `$regex`,
 * `$approx` (with `$tol`). Plain objects match a subset (unknown result fields are ignored);
 * arrays match element by element.
 */
function matches(actual: unknown, expected: unknown, at: string, problems: string[]): void {
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

function expectMatch(actual: unknown, expected: unknown, what: string): void {
  const problems: string[] = [];
  matches(actual, expected, '$', problems);
  if (problems.length > 0) {
    throw new Error(
      `${what}:\n  ${problems.join('\n  ')}\nactual: ${JSON.stringify(actual, null, 2).slice(0, 2000)}`,
    );
  }
}

const errorShape = (e: unknown): Record<string, unknown> => {
  const x = e as Record<string, unknown>;
  return {
    name: x['name'],
    code: x['code'],
    reason: x['reason'],
    fix: x['fix'],
    status: x['status'],
    retryable: x['retryable'],
    role: x['role'],
    envVar: x['envVar'],
    message: x['message'],
  };
};

// In the past: the store's own listing reads the real clock, so a later `now` would hide new records.
const DEFAULT_NOW = '2026-11-05T12:00:00.000Z';

function seedMemory(s: SeedMemory): Memory {
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
    source: { harness: 'seed', decisions: [] },
    createdAt: created,
    updatedAt: s.updatedAt ?? created,
  } as Memory;
}

/** Writes a case's seed into a fresh local store, as each memory's own node's writer. */
async function seedLocal(home: string, seed: Seed, now: string): Promise<void> {
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
async function readJudgment(home: string, id: string): Promise<Record<string, unknown>> {
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

async function call(oort: Oort, step: Step, args: Record<string, unknown>): Promise<unknown> {
  switch (step.call) {
    case 'recall': {
      const { query, ...opts } = args;
      return oort.recall(query as string, opts);
    }
    case 'observe':
      return oort.observe(args as never);
    case 'remember': {
      const { facts, ...opts } = args;
      return oort.remember(facts as string[], opts);
    }
    case 'forget': {
      const { id, ...opts } = args;
      return oort.forget(id as string, opts);
    }
    case 'pin':
      return oort.pin(args['id'] as string);
    case 'unpin':
      return oort.unpin(args['id'] as string);
    case 'recent':
      return oort.recent(args);
    case 'explain':
      return oort.explain(args['id'] as string);
    case 'whoami':
      return oort.whoami();
    case 'consolidate':
      return oort.consolidate(args);
    case 'scoped':
      return oort.scoped(args);
    case 'judge.record':
      return oort.judge.record(args as never);
    case 'judge.apply': {
      const { item, ...opts } = args;
      return oort.judge.apply(item as string, opts);
    }
    case 'judge.list':
      return oort.judge.list(args);
    case 'judge.confirm':
      return oort.judge.confirm(args['id'] as string);
    case 'formatForPrompt': {
      const { result, ...opts } = args;
      return formatForPrompt(result as RecallResult, opts);
    }
    default:
      throw new Error(`unknown call ${step.call}`);
  }
}

async function runCase(c: Case, transport: Transport): Promise<void> {
  const root = tmpdir('oort-contract-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const now = c.now ?? DEFAULT_NOW;
  const seed: Seed =
    c.seed === undefined ? {} : readJson(path.join(ROOT, 'seeds', `${c.seed}.json`));
  const saved = new Map<string, unknown>();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const [id, a] of Object.entries(c.agents ?? {})) setAgentStar(home, id, a.star);
  if (c.counter !== undefined) {
    fs.writeFileSync(
      path.join(home, 'judge-mcp-count.json'),
      JSON.stringify({ day: now.slice(0, 10), count: c.counter }),
    );
  }
  const options = substitute(c.options ?? {}, saved) as Record<string, unknown>;
  const key = ['oort', 'sk', 'contract'.padEnd(43, 'C')].join('_');
  let fake: FakeCloud | undefined;
  let create: () => Promise<Oort>;
  if (transport === 'local') {
    await seedLocal(home, seed, now);
    const none = c.adapters === 'none';
    create = () =>
      createOortWith(
        {
          mode: 'local',
          home,
          cwd,
          env: { HOME: root, OORT_NO_KEYCHAIN: '1' },
          ...(none && { keySources: [] }),
          ...options,
        },
        { ...(!none && { adapters: fakeAdapters() }), now: () => new Date(now) },
      );
  } else {
    fake = fakeCloud(key);
    for (const raw of seed.memories ?? []) {
      const s = substitute(raw, saved) as SeedMemory;
      if ((s.level ?? 'planet') !== 'planet' || (s.user ?? 'self') !== 'self') continue;
      const m = seedMemory(s);
      fake.memories.set(
        m.id,
        fakeMemory({ ...(m as unknown as Record<string, unknown>), id: m.id }),
      );
    }
    for (let i = 0; i < (c.cloud?.memories ?? 0); i++) {
      const at = new Date(Date.parse(now) - i * 60_000).toISOString();
      const m = fakeMemory({ text: `bulk memory number ${i}`, updatedAt: at, createdAt: at });
      fake.memories.set(m.id, m);
    }
    if (c.cloud?.fail !== undefined) fake.fail = { ...c.cloud.fail };
    const env: Record<string, string> = { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1' };
    if (c.cloud?.noKey !== true) env['OORT_API_KEY'] = key;
    const f = fake;
    create = () =>
      createOortWith(
        { mode: 'cloud', cwd, env, fetch: f.fetch, keySources: ['env'], ...options },
        { now: () => new Date(now) },
      );
  }
  if (c.expectCreate !== undefined) {
    const err = await create().then(
      () => undefined,
      (e: unknown) => e,
    );
    if (err === undefined) throw new Error('createOort was expected to fail');
    expectNoSecret(errorShape(err));
    expectMatch(errorShape(err), substitute(c.expectCreate.error, saved), 'createOort error');
    return;
  }
  const oort = await create();
  const handles = new Map<string, Oort>([['root', oort]]);
  try {
    for (const [i, step] of c.steps.entries()) {
      const what = `step ${i} (${step.call})`;
      const args = substitute(step.args ?? {}, saved) as Record<string, unknown>;
      if (fake !== undefined) fake.fail = { ...c.cloud?.fail, ...step.cloud?.fail };
      let result: unknown;
      let error: unknown;
      try {
        if (step.call === 'reader.judgment') {
          result = await readJudgment(home, args['id'] as string);
        } else {
          const h = handles.get(step.on ?? 'root');
          if (h === undefined) throw new Error(`${what}: no handle named ${step.on}`);
          result = await call(h, step, args);
        }
      } catch (e) {
        error = e;
      }
      if (step.as !== undefined && result !== undefined) handles.set(step.as, result as Oort);
      const expected = substitute(step.expect ?? {}, saved) as {
        result?: unknown;
        error?: unknown;
      };
      if (error !== undefined) {
        expectNoSecret(errorShape(error));
        if (expected.error === undefined) {
          throw new Error(`${what} threw ${JSON.stringify(errorShape(error))}`);
        }
        expectMatch(errorShape(error), expected.error, `${what} error`);
        continue;
      }
      if (expected.error !== undefined) {
        throw new Error(
          `${what} was expected to fail, got ${JSON.stringify(result).slice(0, 500)}`,
        );
      }
      if (step.call !== 'scoped') expectNoSecret(result);
      if (expected.result !== undefined) expectMatch(result, expected.result, `${what} result`);
      for (const [name, p] of Object.entries(step.save ?? {})) saved.set(name, pick(result, p));
    }
  } finally {
    await oort.close();
  }
}

describe('SDK contract suite (contract/sdk)', () => {
  it('has unique case ids and only known transports', () => {
    const ids = CASES.map((x) => x.c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { c } of CASES) {
      expect(c.transports.length).toBeGreaterThan(0);
      for (const t of c.transports) expect(['local', 'cloud']).toContain(t);
    }
  });

  for (const transport of ['local', 'cloud'] as const) {
    describe(transport, () => {
      for (const { file, c } of CASES.filter((x) => x.c.transports.includes(transport))) {
        it(`${file}: ${c.id}`, () => runCase(c, transport), 30_000);
      }
    });
  }
});

describe('no fixture secret ever comes back (§6.1)', () => {
  for (const transport of ['local', 'cloud'] as const) {
    it(`${transport}: every fixture secret, observed, remembered or used as a query`, async () => {
      const root = tmpdir('oort-contract-secrets-');
      const home = path.join(root, 'home');
      const key = ['oort', 'sk', 'secrets'.padEnd(43, 'S')].join('_');
      const fake = fakeCloud(key);
      const oort =
        transport === 'local'
          ? await createOortWith(
              { mode: 'local', home, cwd: root, env: { HOME: root, OORT_NO_KEYCHAIN: '1' } },
              { adapters: fakeAdapters(), now: () => new Date(DEFAULT_NOW) },
            )
          : await createOortWith(
              {
                mode: 'cloud',
                cwd: root,
                env: { HOME: root, OORT_API_KEY: key, OORT_NO_KEYCHAIN: '1' },
                fetch: fake.fetch,
                keySources: ['env'],
              },
              { now: () => new Date(DEFAULT_NOW) },
            );
      try {
        for (const s of SECRETS) {
          expectNoSecret(await oort.observe({ user: s.text, assistant: 'Noted.' }));
          if (s.text.length <= 500) expectNoSecret(await oort.remember(s.text));
          if (Buffer.byteLength(s.text) <= 2048) {
            const r = await oort.recall(s.text, { limit: 50 });
            expectNoSecret(r);
            expectNoSecret(formatForPrompt(r));
          }
        }
        expectNoSecret(await oort.recent({ limit: 100 }));
      } finally {
        await oort.close();
      }
    }, 120_000);
  }
});
