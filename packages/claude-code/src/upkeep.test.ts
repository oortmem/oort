import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  appendAccess,
  addressed,
  isCurrent,
  type AccessLog,
  type Memory,
  type MemoryStore,
} from '@oortmem/core';
import { makeMemory as baseMemory, TG, vec } from '@oortmem/core/store-conformance';
import { openSqliteStore } from '@oortmem/store-sqlite';
import type { RemoteMemory } from './deps.js';
import { runHook } from './hooks.js';
import {
  CONSOLIDATE_BUDGET_MS,
  CONSOLIDATE_EVERY_MS,
  CONSOLIDATE_EVERY_SAVES,
  CONSOLIDATE_LOCK_STALE_MS,
  CONSOLIDATE_RESUME_AFTER_MS,
  CONSOLIDATE_RETRY_AFTER_MS,
  consolidateIfDue,
  consolidationDue,
  consolidationStateFile,
  readConsolidationState,
  type ConsolidationState,
} from './upkeep.js';
import {
  SESSION,
  makeDeps,
  mode,
  readLog,
  tempHome,
  writeTranscript,
  type TempHome,
} from '../test/helpers.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const iso = (d: Date): string => d.toISOString();

function logAt(...ats: Date[]): AccessLog {
  let log: AccessLog = { count: 0, recent: [], compactedSum: 0, compactedAt: null };
  for (const at of ats) log = appendAccess(log, at, { d: 0.5 });
  return log;
}

function makeMemory(o: Partial<Memory> & { id: string }): Memory {
  return baseMemory({ validFrom: iso(ago(400 * DAY)), ...o });
}

const state = (o: Partial<ConsolidationState>): ConsolidationState => ({
  v: 1,
  lastRunAt: null,
  lastCompleteAt: null,
  lastOutcome: null,
  savesSince: 0,
  ...o,
});

function writeState(home: string, s: Partial<ConsolidationState>): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(consolidationStateFile(home), JSON.stringify(state(s)));
}

/** A superseded memory (to cold) and an expiring one (expired, then cold). */
async function seedStale(store: MemoryStore): Promise<void> {
  await store.upsert(
    TG,
    makeMemory({
      id: 'superseded',
      embedding: vec(1, 1, 1, 1),
      validTo: iso(ago(DAY)),
      expiredAt: iso(ago(DAY)),
      endReason: 'superseded',
      supersededBy: 'next',
    }),
  );
  await store.upsert(
    TG,
    makeMemory({ id: 'expiring', embedding: vec(1, 2, 1, 2), validTo: iso(ago(HOUR)) }),
  );
  await store.upsert(TG, makeMemory({ id: 'fresh', accessLog: logAt(ago(HOUR)) }));
}

const tiers = async (store: MemoryStore): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await store.list(TG, { validOnly: false })).map((m) => [m.id, m.tier] as const),
  );

function deps(t: TempHome, over: Parameters<typeof makeDeps>[1] = {}) {
  return makeDeps(t, { now: () => NOW, ...over });
}

async function sqlite(t: TempHome) {
  return openSqliteStore({
    path: path.join(t.home, 'oort.sqlite'),
    coldDir: path.join(t.home, 'cold'),
    dimension: 4,
    log: () => {},
  });
}

describe('consolidation due (CON-48)', () => {
  it('upkeep.due-never-ran', () => {
    expect(consolidationDue(state({}), NOW)).toEqual({ due: true, reason: 'never', nextAt: null });
  });

  it('upkeep.due-daily', () => {
    const recent = state({
      lastRunAt: iso(ago(HOUR)),
      lastCompleteAt: iso(ago(HOUR)),
      lastOutcome: 'complete',
    });
    expect(consolidationDue(recent, NOW)).toEqual({
      due: false,
      reason: null,
      nextAt: iso(new Date(ago(HOUR).getTime() + CONSOLIDATE_EVERY_MS)),
    });
    const old = state({
      lastRunAt: iso(ago(DAY)),
      lastCompleteAt: iso(ago(DAY)),
      lastOutcome: 'complete',
    });
    expect(consolidationDue(old, NOW)).toMatchObject({ due: true, reason: 'daily' });
  });

  it('upkeep.due-after-saves', () => {
    const base = {
      lastRunAt: iso(ago(HOUR)),
      lastCompleteAt: iso(ago(HOUR)),
      lastOutcome: 'complete' as const,
    };
    expect(
      consolidationDue(state({ ...base, savesSince: CONSOLIDATE_EVERY_SAVES - 1 }), NOW).due,
    ).toBe(false);
    expect(
      consolidationDue(state({ ...base, savesSince: CONSOLIDATE_EVERY_SAVES }), NOW),
    ).toMatchObject({
      due: true,
      reason: 'saves',
    });
  });

  it('upkeep.due-resume-and-retry-back-off', () => {
    const partial = (at: Date) => state({ lastRunAt: iso(at), lastOutcome: 'partial' });
    expect(consolidationDue(partial(ago(1000)), NOW).due).toBe(false);
    expect(consolidationDue(partial(ago(CONSOLIDATE_RESUME_AFTER_MS)), NOW)).toMatchObject({
      due: true,
      reason: 'resume',
    });
    const failed = (at: Date) => state({ lastRunAt: iso(at), lastOutcome: 'error' });
    expect(consolidationDue(failed(ago(CONSOLIDATE_RESUME_AFTER_MS)), NOW).due).toBe(false);
    expect(consolidationDue(failed(ago(CONSOLIDATE_RETRY_AFTER_MS)), NOW)).toMatchObject({
      due: true,
      reason: 'retry',
    });
  });

  it('upkeep.damaged-state-reads-as-never', () => {
    const t = tempHome();
    fs.mkdirSync(t.home, { recursive: true });
    fs.writeFileSync(consolidationStateFile(t.home), '{not json');
    expect(readConsolidationState(t.home)).toEqual(state({}));
  });
});

describe('consolidation from the drain (CON-48)', () => {
  it('upkeep.drain-consolidates-when-due-then-not-again', async () => {
    const t = tempHome();
    const d = deps(t);
    await seedStale(d.store);
    await runHook('drain', '', d);
    // Expired and superseded memories reach cold with hooks alone.
    expect(await tiers(d.store)).toEqual({ superseded: 'cold', expiring: 'cold', fresh: 'hot' });
    const s = readConsolidationState(t.home);
    expect(s).toMatchObject({ lastOutcome: 'complete', lastCompleteAt: iso(NOW), savesSince: 0 });
    expect(s.last).toMatchObject({ evicted: 2, expired: 1, promoted: 1 });
    expect(mode(consolidationStateFile(t.home))).toBe(0o600);
    expect(fs.existsSync(path.join(t.home, 'consolidate.lock'))).toBe(false);

    // Not due again for a day.
    await d.store.upsert(TG, makeMemory({ id: 'late', validTo: iso(ago(1000)) }));
    await runHook('drain', '', d);
    expect((await d.store.get(TG, 'late'))?.tier).toBe('warm');
    expect(
      readLog(t.home)
        .filter((l) => l.event === 'consolidate')
        .map((l) => l.outcome),
    ).toEqual(['ok']);

    // A day later it is.
    const later = deps(t, { store: d.store, now: () => new Date(NOW.getTime() + DAY) });
    await runHook('drain', '', later);
    expect((await d.store.get(TG, 'late'))?.tier).toBe('cold');
  });

  it('upkeep.drain-saves-count-towards-the-next-run', async () => {
    const t = tempHome();
    writeState(t.home, {
      lastRunAt: iso(ago(HOUR)),
      lastCompleteAt: iso(ago(HOUR)),
      lastOutcome: 'complete',
      savesSince: CONSOLIDATE_EVERY_SAVES - 2,
    });
    const d = deps(t);
    // Stop queues the fixture's turns; the drain saves them and so makes consolidation due.
    const transcript = writeTranscript(path.join(t.root, 'projects', 'p'), t.cwd);
    await runHook(
      'Stop',
      JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: t.cwd }),
      d,
    );
    await runHook('drain', '', d);
    expect(readConsolidationState(t.home)).toMatchObject({
      lastCompleteAt: iso(NOW),
      savesSince: 0,
    });
  });

  it('upkeep.stop-starts-the-drain-only-when-due', async () => {
    const t = tempHome();
    const transcript = writeTranscript(path.join(t.root, 'projects', 'p'), t.cwd);
    const stop = JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: t.cwd });
    let spawned = 0;
    const d = deps(t, { spawnDrain: () => spawned++ });
    await runHook('Stop', stop, d);
    expect(spawned).toBe(1); // turns queued
    await runHook('drain', '', d);
    // Nothing new, nothing queued, consolidated a moment ago: no drain.
    await runHook('Stop', stop, d);
    expect(spawned).toBe(1);
    // Due: the Stop starts a drain for it alone.
    writeState(t.home, {
      lastRunAt: iso(ago(DAY)),
      lastCompleteAt: iso(ago(DAY)),
      lastOutcome: 'complete',
    });
    await runHook('Stop', stop, d);
    expect(spawned).toBe(2);
    expect(
      readLog(t.home)
        .filter((l) => l.event === 'Stop')
        .at(-1)?.counts['consolidationDue'],
    ).toBe(1);
  });

  it('upkeep.never-in-cloud-mode', async () => {
    const t = tempHome();
    const remote: RemoteMemory = {
      recall: async () => ({ memories: [], timings: {} }),
      sessionMemories: async () => [],
      observe: async () => {},
    };
    const transcript = writeTranscript(path.join(t.root, 'projects', 'p'), t.cwd);
    let spawned = 0;
    const d = deps(t, { remote, spawnDrain: () => spawned++ });
    await seedStale(d.store);
    const before = await tiers(d.store);
    expect(await consolidateIfDue(d)).toEqual({ outcome: 'skipped:cloud' });
    await runHook('drain', '', d);
    expect(await tiers(d.store)).toEqual(before);
    expect(fs.existsSync(consolidationStateFile(t.home))).toBe(false);
    // Stop never starts a drain for consolidation either.
    const stop = JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: t.cwd });
    await runHook('Stop', stop, d);
    await runHook('drain', '', d);
    await runHook('Stop', stop, d);
    expect(spawned).toBe(1);
  });

  it('upkeep.time-budget-cuts-the-run-and-a-later-drain-resumes (fake clock)', async () => {
    const t = tempHome();
    const base = deps(t);
    for (let i = 0; i < 250; i++) {
      await base.store.upsert(
        TG,
        makeMemory({ id: `m${i}`, embedding: vec(1, 1, 1, i % 100), validTo: iso(ago(HOUR)) }),
      );
    }
    // Every listing and write takes 400 ms of fake time (reading one record by id is free).
    let clock = 0;
    const store = new Proxy(base.store, {
      get(target, prop, receiver) {
        const v: unknown = Reflect.get(target, prop, receiver);
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          if (prop !== 'get') clock += 400;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as MemoryStore;
    const d = deps(t, { store });
    const r = await consolidateIfDue(d, { clock: () => clock });
    expect(r.outcome).toBe('partial');
    // It stopped at the first check past the budget: never more than one call over it.
    expect(clock).toBeLessThanOrEqual(CONSOLIDATE_BUDGET_MS + 400);
    expect(r.result?.expired).toHaveLength(250);
    expect(r.result?.evicted.length).toBeGreaterThan(0);
    expect(r.result?.evicted.length).toBeLessThan(250);
    expect(readConsolidationState(t.home)).toMatchObject({
      lastOutcome: 'partial',
      lastCompleteAt: null,
    });
    expect(readLog(t.home).at(-1)).toMatchObject({ event: 'consolidate', outcome: 'partial' });

    // Within a minute nothing runs; after it a drain picks up where it stopped.
    expect((await consolidateIfDue(d, { clock: () => clock })).outcome).toBe('not-due');
    let runs = 0;
    let at = NOW.getTime();
    for (;;) {
      at += CONSOLIDATE_RESUME_AFTER_MS;
      const next = await consolidateIfDue(deps(t, { store, now: () => new Date(at) }), {
        clock: () => clock,
      });
      runs++;
      if (next.outcome === 'complete') break;
      expect(next.outcome).toBe('partial');
      expect(runs).toBeLessThan(20);
    }
    expect(Object.values(await tiers(base.store)).every((x) => x === 'cold')).toBe(true);
  });

  it('upkeep.per-node-planet-and-star', async () => {
    const star = addressed(
      { level: 'agent', orgId: 'local', agentId: 'claude-code' },
      { agentId: 'claude-code' },
    );
    const seed = async (store: MemoryStore) => {
      await store.upsert(TG, makeMemory({ id: 'planet-gone', validTo: iso(ago(HOUR)) }));
      await store.upsert(TG, makeMemory({ id: 'star-gone', ...star, validTo: iso(ago(HOUR)) }));
    };
    // Claude Code keeps a Star: its drain consolidates the Star and never changes the Planet.
    const a = tempHome();
    const asStar = deps(a, { home: 'star' });
    await seed(asStar.store);
    await consolidateIfDue(asStar);
    expect(await tiers(asStar.store)).toEqual({ 'planet-gone': 'warm', 'star-gone': 'cold' });
    expect((await asStar.store.get(TG, 'planet-gone'))?.expiredAt).toBeNull();
    // On the Planet (the default), both nodes, each on its own.
    const b = tempHome();
    const asPlanet = deps(b);
    await seed(asPlanet.store);
    await consolidateIfDue(asPlanet);
    expect(await tiers(asPlanet.store)).toEqual({ 'planet-gone': 'cold', 'star-gone': 'cold' });
  });

  it('upkeep.every-project-and-global-each-ranked-alone', async () => {
    const t = tempHome();
    const d = deps(t);
    d.config.activation = { ...d.config.activation, hotTopN: 1 };
    const scope = makeMemory({ id: 'x' }).scope;
    await d.store.upsert(TG, makeMemory({ id: 'global', accessLog: logAt(ago(DAY)) }));
    for (const p of ['p1', 'p2']) {
      await d.store.upsert(
        TG,
        makeMemory({
          id: p,
          scope: { ...scope, projectId: p },
          accessLog: logAt(ago(HOUR), ago(2 * HOUR)),
        }),
      );
    }
    await consolidateIfDue(d);
    expect(await tiers(d.store)).toEqual({ global: 'hot', p1: 'hot', p2: 'hot' });
  });

  it('upkeep.lock-held-by-another-drain', async () => {
    const t = tempHome();
    const d = deps(t);
    await seedStale(d.store);
    fs.mkdirSync(t.home, { recursive: true });
    const lock = path.join(t.home, 'consolidate.lock');
    fs.writeFileSync(lock, '123\n');
    expect((await consolidateIfDue(d)).outcome).toBe('locked');
    expect((await d.store.get(TG, 'superseded'))?.tier).toBe('warm');
    expect(readLog(t.home).at(-1)).toMatchObject({ event: 'consolidate', outcome: 'locked' });
    // A lock left by a crashed drain is broken once stale.
    const old = new Date(Date.now() - CONSOLIDATE_LOCK_STALE_MS - 1000);
    fs.utimesSync(lock, old, old);
    expect((await consolidateIfDue(d)).outcome).toBe('complete');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('upkeep.lock-contention-between-two-hook-processes', async () => {
    const t = tempHome();
    const store = await sqlite(t);
    await seedStale(store);
    await store.close();
    const child = path.join(import.meta.dirname, '..', 'test', 'consolidate-child.mjs');
    const run = promisify(execFile);
    // Both start at once; the first to take the lock stalls inside it for 1.5 s.
    const outs = await Promise.all(
      [0, 1].map(() => run(process.execPath, [child, t.home, '1500'], { timeout: 30_000 })),
    );
    const outcomes = outs.map((o) => o.stdout.trim()).sort();
    expect(outcomes).toEqual(['complete', 'locked']);
    const after = await sqlite(t);
    try {
      expect(await tiers(after)).toEqual({ superseded: 'cold', expiring: 'cold', fresh: 'hot' });
    } finally {
      await after.close();
    }
    expect(
      readLog(t.home)
        .filter((l) => l.event === 'consolidate')
        .map((l) => l.outcome)
        .sort(),
    ).toEqual(['locked', 'ok']);
  }, 40_000);

  it('upkeep.crash-mid-run-leaves-the-store-consistent (sqlite)', async () => {
    const t = tempHome();
    const store = await sqlite(t);
    try {
      for (let i = 0; i < 250; i++) {
        await store.upsert(
          TG,
          makeMemory({ id: `m${i}`, embedding: vec(1, 2, 3, i % 100), validTo: iso(ago(HOUR)) }),
        );
      }
      let batches = 0;
      const crashing: MemoryStore = {
        ...store,
        async coldPutMany(grant, ms) {
          if (++batches === 2) throw new Error('killed');
          return store.coldPutMany(grant, ms);
        },
      };
      const d = deps(t, { store: crashing });
      expect((await consolidateIfDue(d)).outcome).toBe('error');
      expect(readConsolidationState(t.home)).toMatchObject({
        lastOutcome: 'error',
        lastCompleteAt: null,
      });
      expect(fs.existsSync(path.join(t.home, 'consolidate.lock'))).toBe(false);
    } finally {
      await store.close();
    }
    // Reopened, as the next process would: nothing lost, every cold record readable whole.
    const after = await sqlite(t);
    try {
      const all = await after.list(TG, { validOnly: false });
      expect(all).toHaveLength(250);
      const cold = all.filter((m) => m.tier === 'cold');
      expect(cold).toHaveLength(50); // the first batch of 50 committed, the second never did
      for (const m of cold) expect((await after.coldGet(TG, m.id))?.embedding).toBeDefined();
      for (const m of all.filter((x) => x.tier !== 'cold')) expect(m.embedding).toBeDefined();
      expect(all.every((m) => !isCurrent(m, NOW))).toBe(true);
      // An hour later the retry finishes the job.
      const retry = deps(t, { store: after, now: () => new Date(NOW.getTime() + HOUR) });
      expect((await consolidateIfDue(retry)).outcome).toBe('complete');
      expect((await after.list(TG, { validOnly: false })).every((m) => m.tier === 'cold')).toBe(
        true,
      );
    } finally {
      await after.close();
    }
  });
});
