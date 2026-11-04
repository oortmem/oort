import { localScope, type Memory, type MemoryType } from '@oortmem/core';
import { fakeEmbedding } from './fake-embed.js';
import { createRng, type Rng } from './prng.js';

/** The reference "now" synthetic data is generated against (stable, so seeds are reproducible). */
export const GENERATOR_NOW = new Date('2026-11-01T00:00:00.000Z');

export const PROJECTS = [
  'atlas-1a2b3c4d',
  'borealis-5e6f7a8b',
  'cinder-9c0d1e2f',
  'delta-3a4b5c6d',
  'ember-7e8f9a0b',
] as const;

export const EMBEDDING_DIMENSION = 512;

const DAY_MS = 86_400_000;

const SERVICES = [
  'auth-service',
  'billing-api',
  'ingest-worker',
  'search-gateway',
  'notify-relay',
  'media-proxy',
  'report-builder',
  'sync-daemon',
  'edge-router',
  'audit-logger',
  'profile-store',
  'queue-runner',
];
const LIBS = [
  'zod',
  'drizzle-orm',
  'fastify',
  'vitest',
  'pino',
  'undici',
  'better-sqlite3',
  'commander',
  'ioredis',
  'esbuild',
  'prisma',
  'tsup',
];
const TOOLS = ['pnpm', 'npm', 'yarn', 'bun'];
const DIRS = [
  'src/server',
  'src/lib',
  'packages/core',
  'scripts',
  'infra/terraform',
  'db/migrations',
];
const FILES = ['routes', 'config', 'client', 'schema', 'worker', 'handlers', 'index', 'retry'];
const TOPICS = [
  'connection pooling',
  'cache invalidation',
  'rate limiting',
  'schema migrations',
  'log redaction',
  'token refresh',
  'webhook retries',
  'feature flags',
];
const ALTERNATIVES = ['a message queue', 'cron jobs', 'a sidecar', 'a shared library', 'polling'];
const REASONS = [
  'it keeps startup under a second',
  'the team already runs it in production',
  'it removes a whole class of race conditions',
  'the previous approach leaked file descriptors',
  'it halves the memory footprint',
  'reviewers asked for stricter typing',
];
const ERRORS = [
  'ECONNRESET',
  'SQLITE_BUSY',
  'ERR_MODULE_NOT_FOUND',
  'ETIMEDOUT',
  'ENOSPC',
  'EADDRINUSE',
];
const PREFS = [
  'two-space indentation',
  'single quotes',
  'named exports only',
  'small commits with imperative subjects',
  'tests next to the source file',
  'early returns over nested conditionals',
  'explicit return types on exported functions',
];
const FILLERS = [
  'This was confirmed while reviewing the pull request.',
  'It came up again during the weekly planning call.',
  'The change is documented in the runbook.',
  'Nothing else depends on it yet.',
  'Follow up if the numbers drift.',
  'It was verified locally and in staging.',
  'The older behaviour still works behind a flag.',
  'Check the CI logs if this fails again.',
  'It matters because several other modules import from there.',
  'The same rule applies to every package in the monorepo.',
  'Keep this in mind when touching the deploy scripts.',
  'A short note was added to the contributing guide.',
];

interface Draft {
  head: string;
  entities: string[];
  type: MemoryType;
}

function isoDate(rng: Rng, now: Date): string {
  return new Date(now.getTime() - rng.int(365) * DAY_MS).toISOString().slice(0, 10);
}

function port(rng: Rng): number {
  return rng.range(1024, 9999);
}

function path(rng: Rng): string {
  return `${rng.pick(DIRS)}/${rng.pick(FILES)}.ts`;
}

const TEMPLATES: Record<MemoryType, ((rng: Rng, now: Date) => Draft)[]> = {
  semantic: [
    (r) => {
      const s = r.pick(SERVICES);
      return {
        head: `${s} listens on port ${port(r)} in local development.`,
        entities: [s],
        type: 'semantic',
      };
    },
    (r) => {
      const p = path(r);
      const l = r.pick(LIBS);
      return {
        head: `The ${l} client is configured in ${p} and shared by every handler.`,
        entities: [l, p],
        type: 'semantic',
      };
    },
    (r) => {
      const t = r.pick(TOOLS);
      const s = r.pick(SERVICES);
      return {
        head: `${s} installs dependencies with ${t} and pins the lockfile in CI.`,
        entities: [s, t],
        type: 'semantic',
      };
    },
    (r, now) => {
      const l = r.pick(LIBS);
      const topic = r.pick(TOPICS);
      return {
        head: `Decision on ${isoDate(r, now)}: handle ${topic} with ${l} rather than ${r.pick(ALTERNATIVES)}, because ${r.pick(REASONS)}.`,
        entities: [l],
        type: 'semantic',
      };
    },
  ],
  episodic: [
    (r, now) => {
      const e = r.pick(ERRORS);
      const s = r.pick(SERVICES);
      return {
        head: `On ${isoDate(r, now)} ${s} failed with ${e} while running the integration suite.`,
        entities: [s, e],
        type: 'episodic',
      };
    },
    (r, now) => {
      const p = path(r);
      const s = r.pick(SERVICES);
      return {
        head: `Refactored ${p} in ${s} on ${isoDate(r, now)} after a review comment about error handling.`,
        entities: [s, p],
        type: 'episodic',
      };
    },
    (r, now) => {
      const s = r.pick(SERVICES);
      return {
        head: `Rolled back the ${s} deploy on ${isoDate(r, now)} when latency rose above the budget.`,
        entities: [s],
        type: 'episodic',
      };
    },
  ],
  procedural: [
    (r) => {
      const t = r.pick(TOOLS);
      const s = r.pick(SERVICES);
      return {
        head: `To run the ${s} tests use ${t} test --filter ${s} and set NODE_ENV=test first.`,
        entities: [s, t],
        type: 'procedural',
      };
    },
    (r) => {
      const s = r.pick(SERVICES);
      return {
        head: `Deploy ${s} by tagging a release, waiting for the build, then running scripts/deploy.sh ${s}.`,
        entities: [s, 'scripts/deploy.sh'],
        type: 'procedural',
      };
    },
    (r) => {
      const p = path(r);
      return {
        head: `Regenerate the fixtures after editing ${p} with the update script before committing.`,
        entities: [p],
        type: 'procedural',
      };
    },
  ],
  preference: [
    (r) => {
      const pref = r.pick(PREFS);
      return {
        head: `The user prefers ${pref} in this codebase.`,
        entities: [],
        type: 'preference',
      };
    },
    (r) => {
      const t = r.pick(TOOLS);
      return {
        head: `Always use ${t} for package management here, never mix package managers.`,
        entities: [t],
        type: 'preference',
      };
    },
    (r) => {
      const l = r.pick(LIBS);
      return {
        head: `Prefer ${l} over hand-rolled helpers when it is already a dependency.`,
        entities: [l],
        type: 'preference',
      };
    },
  ],
};

/** Weights for the four types: facts are the largest group, as in a real store. */
const TYPE_WEIGHTS: [MemoryType, number][] = [
  ['semantic', 0.4],
  ['episodic', 0.3],
  ['procedural', 0.15],
  ['preference', 0.15],
];

function pickType(rng: Rng): MemoryType {
  let x = rng.next();
  for (const [t, w] of TYPE_WEIGHTS) {
    if (x < w) return t;
    x -= w;
  }
  return 'semantic';
}

/** Pads `head` with filler sentences toward a random target length in [40, 500]. */
function withLength(rng: Rng, head: string): string {
  const target = rng.range(40, 500);
  let text = head;
  while (text.length < 40) text += ` ${rng.pick(FILLERS)}`;
  for (let tries = 0; tries < 24; tries++) {
    const f = rng.pick(FILLERS);
    if (text.length + 1 + f.length <= target) text += ` ${f}`;
  }
  return text.slice(0, 500);
}

function stubOf(head: string): string {
  return head.length <= 80 ? head : `${head.slice(0, 77).trimEnd()}...`;
}

interface Built {
  memory: Memory;
}

function build(
  rng: Rng,
  id: string,
  draft: Draft,
  at: { createdAt: Date },
  now: Date,
  projectId: string | undefined,
): Built {
  const text = withLength(rng, draft.head);
  const createdAt = at.createdAt;
  const count = Math.floor(rng.next() ** 2 * 10);
  const spanMs = Math.max(now.getTime() - createdAt.getTime(), 0);
  const recent = Array.from({ length: count }, () =>
    new Date(now.getTime() - rng.next() * spanMs).toISOString(),
  ).sort();
  const iso = createdAt.toISOString();
  return {
    memory: {
      id,
      scope: localScope(projectId),
      type: draft.type,
      text,
      stub: stubOf(draft.head),
      entities: draft.entities,
      salience: Math.round((0.1 + rng.next() * 0.9) * 1000) / 1000,
      pinned: rng.next() < 0.1,
      tier: 'warm',
      accessLog: { count, recent, compactedSum: 0, compactedAt: null },
      validFrom: iso,
      validTo: null,
      expiredAt: null,
      endReason: null,
      lastConfirmedAt: null,
      supersedes: null,
      supersededBy: null,
      source: { harness: 'synthetic', sessionId: `session-${rng.int(60)}`, decisions: [] },
      embedding: fakeEmbedding(text, EMBEDDING_DIMENSION),
      createdAt: iso,
      updatedAt: iso,
    },
  };
}

/** About this share of all memories sit in supersede chains (members of A to B to C). */
const CHAIN_SHARE = 0.05;

function chainStatements(rng: Rng, subject: string): string[] {
  const kind = rng.int(3);
  if (kind === 0) {
    const ports = new Set<number>();
    while (ports.size < 3) ports.add(port(rng));
    return [...ports].map((p) => `${subject} listens on port ${p} in local development.`);
  }
  if (kind === 1) {
    const tools = rng.shuffle(TOOLS).slice(0, 3);
    return tools.map(
      (t) => `${subject} installs dependencies with ${t} and pins the lockfile in CI.`,
    );
  }
  const libs = rng.shuffle(LIBS).slice(0, 3);
  return libs.map((l) => `${subject} validates requests with ${l} in its request handlers.`);
}

/**
 * `n` deterministic synthetic developer memories: all four types, 40 to 500
 * characters, 512-d int8 embeddings derived from the text, access logs spread
 * over a year, 10% pinned, and 5% of the memories in A to B to C supersede chains (facts).
 * Spread across five projects and global. The same `(n, seed)` always yields
 * the same memories.
 */
export function generateMemories(n: number, seed: number, opts: { now?: Date } = {}): Memory[] {
  const now = opts.now ?? GENERATOR_NOW;
  const rng = createRng(seed);
  const projectOf = (): string | undefined => {
    const i = rng.int(PROJECTS.length + 1);
    return i === PROJECTS.length ? undefined : PROJECTS[i];
  };
  const tag = `m${seed}`;
  const out: Memory[] = [];

  const chains = Math.floor((n * CHAIN_SHARE) / 3);
  for (let c = 0; c < chains; c++) {
    const subject = `${rng.pick(SERVICES)}-${c}`;
    const statements = chainStatements(rng, subject);
    const projectId = projectOf();
    let start = now.getTime() - (200 + rng.next() * 160) * DAY_MS;
    const links: Memory[] = [];
    for (const head of statements) {
      const draft: Draft = { head, entities: [subject], type: 'semantic' };
      const { memory } = build(
        rng,
        `${tag}-${out.length + links.length}`,
        draft,
        { createdAt: new Date(start) },
        now,
        projectId,
      );
      links.push(memory);
      start += (40 + rng.next() * 50) * DAY_MS;
    }
    links.forEach((m, i) => {
      const prev = links[i - 1];
      const next = links[i + 1];
      m.supersedes = prev?.id ?? null;
      if (next !== undefined) {
        m.supersededBy = next.id;
        m.validTo = next.validFrom;
        m.expiredAt = next.createdAt;
        m.endReason = 'superseded';
        m.updatedAt = next.createdAt;
      }
    });
    out.push(...links);
  }

  while (out.length < n) {
    const type = pickType(rng);
    const draft = rng.pick(TEMPLATES[type])(rng, now);
    const createdAt = new Date(now.getTime() - rng.next() * 365 * DAY_MS);
    out.push(build(rng, `${tag}-${out.length}`, draft, { createdAt }, now, projectOf()).memory);
  }

  // Chains were generated first; shuffle so they are spread through the store.
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const a = out[i] as Memory;
    out[i] = out[j] as Memory;
    out[j] = a;
  }
  return out.slice(0, Math.max(n, 0));
}
