import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Embedder, Reranker } from '@oortmem/core';
import { TG } from '@oortmem/core/store-conformance';
import { writeCloudSettings } from '../cloud.js';
import { createKeychain } from '../keychain.js';
import { runCli } from '../program.js';
import { wire as realWire, type WireFn } from '../wire.js';
import {
  data,
  failed,
  fakeEmbedder,
  fakeIo,
  harness,
  memory,
  tmpdir,
  type Harness,
} from '../../test/helpers.js';
import { fakeCloud } from '../../test/helpers/fake-cloud.js';

/**
 * `oort recall --limit`, `--speed` and `--budget-chars`: the SDK's `recall()` options
 * (`limit`, `speed`, `budgetChars`) on the command line, with the SDK's bounds.
 */

/** The harness with counting embed and rerank adapters. */
function counted(h: Harness): { embeds: number; reranks: number } {
  const n = { embeds: 0, reranks: 0 };
  const base = h.wire;
  const embed: Embedder = {
    dimension: fakeEmbedder.dimension,
    async embed(texts, ...rest) {
      n.embeds++;
      return fakeEmbedder.embed(texts, ...rest);
    },
  };
  const rerank: Reranker = {
    async rerank(_q, docs, topK) {
      n.reranks++;
      return docs.slice(0, topK).map((d, i) => ({ id: d.id, score: 0.9 - i * 0.01 }));
    },
  };
  h.wire = async (dir, o) => ({ ...(await base(dir, o)), embed, rerank });
  return n;
}

async function seeded(n: number): Promise<Harness> {
  const h = harness();
  for (let i = 0; i < n; i++) {
    await h.store.upsert(
      TG,
      memory({
        id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
        text: `The auth service listens on port 55${String(i).padStart(2, '0')} in staging.`,
      }),
    );
  }
  return h;
}

describe('oort recall: --limit, --speed, --budget-chars', () => {
  it('--limit caps the memories returned (1 to 50, as the SDK)', async () => {
    const h = await seeded(6);
    const all = data((await h.run(['recall', 'auth service port', '--json'])).io.stdout, 'recall');
    expect(all.memories.length).toBeGreaterThan(2);
    const two = await h.run(['recall', 'auth service port', '--limit', '2', '--json']);
    expect(two.code, two.io.stderr).toBe(0);
    expect(data(two.io.stdout, 'recall').memories).toHaveLength(2);
    for (const bad of ['0', '51', '2.5', 'many']) {
      const r = await h.run(['recall', 'x', '--limit', bad, '--json']);
      expect(failed(r, 'usage', 'recall').message, bad).toContain('--limit');
    }
  });

  it('--speed fast skips the reranker; lexical calls no model; anything else is refused', async () => {
    const h = await seeded(3);
    const n = counted(h);
    const full = await h.run(['recall', 'auth service port', '--json']);
    expect(full.code, full.io.stderr).toBe(0);
    expect(n.embeds).toBeGreaterThan(0);
    expect(n.reranks).toBeGreaterThan(0);
    n.embeds = 0;
    n.reranks = 0;
    const fast = await h.run(['recall', 'auth service port', '--speed', 'fast', '--json']);
    expect(fast.code, fast.io.stderr).toBe(0);
    expect(n.reranks).toBe(0);
    expect(n.embeds).toBeGreaterThan(0);
    n.embeds = 0;
    const lexical = await h.run(['recall', 'auth service port', '--speed', 'lexical', '--json']);
    expect(lexical.code, lexical.io.stderr).toBe(0);
    expect(n.embeds + n.reranks).toBe(0);
    expect(data(lexical.io.stdout, 'recall').memories.length).toBeGreaterThan(0);
    const bad = await h.run(['recall', 'x', '--speed', 'warp', '--json']);
    expect(failed(bad, 'usage', 'recall').message).toContain('--speed');
  });

  it('a speed you chose is not reported as degraded', async () => {
    const h = await seeded(2);
    counted(h);
    const r = await h.run(['recall', 'auth service port', '--speed', 'fast']);
    expect(r.code).toBe(0);
    expect(r.io.stderr).not.toMatch(/degraded|lexical-only/);
  });

  it('--budget-chars caps the printed <oort-memory> block', async () => {
    const h = await seeded(6);
    const wide = await h.run(['recall', 'auth service port']);
    const narrow = await h.run(['recall', 'auth service port', '--budget-chars', '200']);
    expect(narrow.code, narrow.io.stderr).toBe(0);
    const block = (s: string): string => s.slice(s.indexOf('<oort-memory'));
    expect(block(narrow.io.stdout).length).toBeLessThan(block(wide.io.stdout).length);
    expect(block(narrow.io.stdout).trimEnd().length).toBeLessThanOrEqual(200);
    for (const bad of ['0', '-5', 'lots']) {
      const r = await h.run(['recall', 'x', '--budget-chars', bad, '--json']);
      expect(failed(r, 'usage', 'recall').message, bad).toContain('--budget-chars');
    }
  });

  it("in Oort Cloud, --limit is the request's k and --speed turns off rerank and embed", async () => {
    const root = tmpdir();
    const home = path.join(root, 'oort-home');
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    const key = ['oort', 'sk', 'recallflags'.padEnd(43, 'F')].join('_');
    const cloud = fakeCloud(key);
    writeCloudSettings(home, { store: 'cloud' });
    const wire: WireFn = (dir, o = {}) =>
      realWire(dir, { ...o, keychain: async () => undefined, fetch: cloud.fetch });
    const run = async (args: string[]): Promise<number> => {
      const io = fakeIo({
        cwd,
        env: { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: key },
      });
      return runCli(args, io, wire, createKeychain({ platform: 'none' }), { fetch: cloud.fetch });
    };
    expect(await run(['recall', 'deploy', '--limit', '3', '--speed', 'lexical', '--json'])).toBe(0);
    expect(cloud.recalls.at(-1)).toMatchObject({ k: 3, rerank: false, embed: false });
    expect(await run(['recall', 'deploy', '--speed', 'fast', '--json'])).toBe(0);
    expect(cloud.recalls.at(-1)).toMatchObject({ k: 10, rerank: false });
    expect(cloud.recalls.at(-1)).not.toHaveProperty('embed');
  });
});
