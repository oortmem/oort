import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Memory } from '@oortmem/core';
import { createRng } from './prng.js';
import {
  entityName,
  linkedBatches,
  linkedQuery,
  reservoir,
  zipf,
  type LinkedStats,
} from './generate-linked.js';
import { DEFAULT_WARM_UP, openLinkedStore, storeDirName } from './linked-store.js';
import { renderLinksLatency, runLinksLatency } from './links-latency.js';

const all = (n: number, seed: number, batch = 1000): { ms: Memory[]; stats: LinkedStats } => {
  let stats: LinkedStats | undefined;
  const ms = [...linkedBatches(n, seed, batch, { onStats: (s) => (stats = s) })].flat();
  return { ms, stats: stats as LinkedStats };
};

describe('link-shaped generator (CON-146)', () => {
  const { ms, stats } = all(20_000, 3);

  it('linked.deterministic-and-batch-independent', () => {
    const again = all(2_000, 3, 7).ms;
    const once = all(2_000, 3, 1000).ms;
    expect(again.map((m) => m.id)).toEqual(once.map((m) => m.id));
    expect(again.map((m) => m.text)).toEqual(once.map((m) => m.text));
    expect(all(2_000, 4).ms.map((m) => m.text)).not.toEqual(once.map((m) => m.text));
    expect(ms).toHaveLength(20_000);
    expect(new Set(ms.map((m) => m.id)).size).toBe(20_000);
  });

  it('linked.sessions-in-turn-order-with-split-turns', () => {
    const bySession = new Map<string, Memory[]>();
    for (const m of ms) {
      const s = m.source.sessionId as string;
      bySession.set(s, [...(bySession.get(s) ?? []), m]);
    }
    expect(bySession.size).toBe(stats.sessions);
    for (const list of bySession.values()) {
      // Written in order: turn numbers never go down, times always go up.
      const turns = list.map((m) => Number((m.source.turnRef as string).slice(1)));
      expect([...turns].sort((a, b) => a - b)).toEqual(turns);
      const times = list.map((m) => Date.parse(m.createdAt));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
    // Some turns split into several facts sharing a turnRef (CON-56).
    expect(stats.turns).toBeLessThan(ms.length);
    expect(stats.turns).toBeGreaterThan(ms.length * 0.7);
    // Zipf session lengths: mostly short, a few long.
    const lengths = [...bySession.values()].map((l) => l.length).sort((a, b) => a - b);
    expect(lengths[Math.floor(lengths.length / 2)]).toBeLessThan(15);
    expect(stats.longestSession).toBeGreaterThan(100);
  });

  it('linked.zipf-entities-few-hubs-long-tail', () => {
    expect(stats.entities).toBeGreaterThan(500);
    // A handful of hubs past F_max = 50, and most entities named by very few memories.
    expect(stats.hubs).toBeGreaterThan(5);
    expect(stats.hubs).toBeLessThan(stats.entities * 0.1);
    expect(stats.medianFan).toBeLessThanOrEqual(5);
    expect(stats.topEntities[0]?.[1]).toBeGreaterThan(1000);
    for (const m of ms) {
      expect(m.entities.length).toBeGreaterThanOrEqual(1);
      expect(m.entities.length).toBeLessThanOrEqual(3);
      expect(m.text.length).toBeLessThanOrEqual(500);
      for (const e of m.entities) expect(m.text).toContain(e);
    }
  });

  it('linked.zipf-sampler', () => {
    const draw = zipf(1000, 1);
    const rng = createRng(1);
    const counts: number[] = Array.from({ length: 1000 }, () => 0);
    for (let i = 0; i < 50_000; i++) counts[draw(rng)]!++;
    // Rank 1 about twice rank 2 and ten times rank 10.
    expect(counts[0]! / counts[1]!).toBeGreaterThan(1.7);
    expect(counts[0]! / counts[1]!).toBeLessThan(2.3);
    expect(counts[0]! / counts[9]!).toBeGreaterThan(8);
    expect(entityName(0)).toBe('oort');
    expect(entityName(5000)).toMatch(/^[a-z]+-[0-9a-z]+$/);
  });

  it('linked.queries-name-entities', () => {
    const rng = createRng(2);
    for (const m of ms.slice(0, 50)) {
      const q = linkedQuery(m, rng);
      expect(q.startsWith(m.entities[0] as string)).toBe(true);
    }
    const r = reservoir(10, 1);
    r.offer(ms.slice(0, 5));
    expect(r.sample()).toHaveLength(5);
    r.offer(ms.slice(5, 500));
    expect(r.sample()).toHaveLength(10);
  });
});

describe('cached link-shaped store (CON-146)', () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oort-linked-'));
  afterAll(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

  it('linked-store.built-once-then-reused, warm-up live, measurement frozen', async () => {
    const first = await openLinkedStore({ count: 1_500, seed: 5, cacheDir, warmUp: 40 });
    expect(first.built).toBe(true);
    expect(first.dir).toBe(path.join(cacheDir, storeDirName(1_500, 5)));
    const w = first.manifest.warmUp;
    // The warm-up recorded accesses on the live store: the frozen() stub does not apply to it.
    expect(w.queries).toBe(40);
    expect(w.accessCalls).toBeGreaterThan(30);
    expect(w.pairs).toBe(0); // the link table exists since schema version 8; nothing learns pairs yet
    expect(w.links).toBe(false);
    expect(first.manifest.stats.memories).toBe(1_500);
    await first.close();
    const mtime = fs.statSync(path.join(first.dir, 'manifest.json')).mtimeMs;

    const second = await openLinkedStore({ count: 1_500, seed: 5, cacheDir });
    expect(second.built).toBe(false);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.queries.length).toBeGreaterThan(100);
    await second.close();
    expect(fs.statSync(path.join(first.dir, 'manifest.json')).mtimeMs).toBe(mtime);

    // A build that never finished (no manifest) is rebuilt.
    fs.rmSync(path.join(first.dir, 'manifest.json'));
    const third = await openLinkedStore({ count: 1_500, seed: 5, cacheDir, warmUp: 10 });
    expect(third.built).toBe(true);
    await third.close();
    expect(DEFAULT_WARM_UP).toBe(500);
  });

  it('links-latency.measures-on-a-frozen-store-and-reports-links-off', async () => {
    const digest = (): string => {
      const db = path.join(cacheDir, storeDirName(1_500, 5), 'oort.sqlite');
      return `${fs.readFileSync(db).length}:${fs.existsSync(`${db}-wal`) ? fs.readFileSync(`${db}-wal`).length : 0}`;
    };
    const r = await runLinksLatency({
      counts: [1_500],
      seed: 5,
      cacheDir,
      queries: 5,
      repeats: 1,
      warmup: 1,
    });
    const before = digest();
    const again = await runLinksLatency({
      counts: [1_500],
      seed: 5,
      cacheDir,
      queries: 5,
      repeats: 1,
      warmup: 1,
      paths: ['lexical'],
    });
    // Measured recalls wrote nothing (recordAccess is stubbed; nothing is cold to hydrate).
    expect(digest()).toBe(before);
    expect(r.linksAvailable).toBe(false);
    expect(r.stores[0]?.paths.map((p) => p.path)).toEqual(['lexical', 'fast', 'full']);
    for (const p of r.stores[0]?.paths ?? []) {
      expect(p.off.samples).toBe(5);
      expect(p.on).toBeUndefined();
      expect(p.gather).toBeUndefined();
    }
    expect(again.stores[0]?.built).toBe(false);
    const md = renderLinksLatency(r);
    expect(md).toContain('Links: off only');
    expect(md).toMatch(/\| lexical \| [\d.]+ \/ [\d.]+ \/ [\d.]+ \| - \| - \| - \| - \|/);
    await expect(
      runLinksLatency({ counts: [1_500], seed: 5, cacheDir, queries: 1, repeats: 1, links: 'on' }),
    ).rejects.toThrow(/CON-149/);
  });
});
