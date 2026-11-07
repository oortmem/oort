import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { setAgentStar } from '@oortmem/core';
import { tmpdir } from '../../test/helpers.js';
import {
  CASES,
  DEFAULT_NOW,
  ROOT,
  SECRETS,
  errorShape,
  expectMatch,
  expectNoSecret,
  pick,
  readJson,
  readJudgment,
  seedLocal,
  seedMemory,
  substitute,
  type Case,
  type Seed,
  type SeedMemory,
  type Step,
  type Transport,
} from '../../test/helpers/contract.js';
import { fakeCloud, fakeMemory, type FakeCloud } from '../../test/helpers/fake-cloud.js';
import { fakeAdapters } from '../../test/helpers/sdk-fakes.js';
import { createOortWith } from './create.js';
import type { Oort, RecallResult } from './types.js';
import { formatForPrompt } from './views.js';

/**
 * The SDK contract suite's TypeScript runner (CON-108 §10). The cases live in `contract/sdk/` as
 * JSON, in camelCase wire names, and the Python runner (python/tests/contract_runner.py, driven
 * by python.test.ts) reads the same files. Each case runs on every transport it names: `local`
 * (the in-process engine with deterministic fakes, through the internal test hook) and `cloud`
 * (the shared fake Oort Cloud).
 */

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
