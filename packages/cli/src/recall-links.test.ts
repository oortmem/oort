import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MemoryStore, Reranker } from '@oortmem/core';
import { TG } from '@oortmem/core/store-conformance';
import { writeCloudSettings } from './cloud.js';
import { createKeychain } from './keychain.js';
import { localBackend } from './mcp.js';
import { runCli } from './program.js';
import { createOortWith } from './sdk/create.js';
import { formatForPrompt } from './sdk/index.js';
import { wire as realWire, type WireFn } from './wire.js';
import { data, fakeIo, harness, memory, tmpdir, type Harness } from '../test/helpers.js';
import { fakeCloud } from '../test/helpers/fake-cloud.js';
import { fakeAdapters } from '../test/helpers/sdk-fakes.js';

/**
 * One hop along links at recall, on every surface that shows it (CON-149): `oort recall`,
 * `oort explain`, MCP `recall` and the SDK's `why`, and the cloud-mode answers.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const QUERY = 'which port does auth-service use';

/**
 * Scores the answer high, the linked memory above the gate and the runner-up under it. The
 * runner-up is there so fusion is not confident and the reranker is called.
 */
const rerank: Reranker = {
  async rerank(_q, docs, topK) {
    const score = (t: string) =>
      t.includes('moved to') ? 0.9 : t.includes('Postgres') ? 0.6 : 0.1;
    return docs
      .map((d) => ({ id: d.id, score: score(d.text) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, topK);
  },
};

/** Two memories, the second with no query word, linked as `by`; the harness reranks. */
async function linked(by: 'user' | 'agent'): Promise<Harness & { hops: () => number }> {
  const h = harness();
  await h.store.upsert(
    TG,
    memory({ id: A, text: 'auth-service moved to port 8080', stub: 'port', entities: [] }),
  );
  await h.store.upsert(
    TG,
    memory({ id: B, text: 'It runs on Postgres 16.', stub: 'storage engine', entities: [] }),
  );
  await h.store.upsert(
    TG,
    memory({ text: 'which port auth-service did use before', stub: 'port', entities: [] }),
  );
  await h.store.link!(TG, A, B, { assertedBy: by });
  let hops = 0;
  const store: MemoryStore = {
    ...h.store,
    neighbours: (g, ids, o) => {
      hops++;
      return h.store.neighbours!(g, ids, o);
    },
  };
  const plain = h.wire;
  // No embedder: the fake one would find the linked memory by itself, as a dense match.
  h.wire = async (dir, o) => {
    const { embed: _e, ...w } = await plain(dir, o);
    return { ...w, store, rerank };
  };
  return Object.assign(h, { hops: () => hops });
}

describe('oort recall and explain follow links (CON-149)', () => {
  it("links.cli-recall-labels-a-person's-linked-memory", async () => {
    const h = await linked('user');
    const r = await h.run(['recall', QUERY]);
    expect(r.code).toBe(0);
    expect(r.io.stdout).toMatch(/- \[semantic, [^\]]*\] auth-service moved to port 8080/);
    expect(r.io.stdout).toMatch(/- \[semantic, [^\]]*, linked\] It runs on Postgres 16\./);
    const json = data(await h.run(['recall', QUERY, '--json']).then((x) => x.io.stdout));
    expect(json.memories.map((m: { id: string }) => m.id)).toEqual([A, B]);
    expect(json.memories[1].explanation.via).toMatchObject({ kind: 'explicit', from: A });
    // `--no-links` follows nothing, and `--speed lexical` reads no link either.
    const none = data((await h.run(['recall', QUERY, '--json', '--no-links'])).io.stdout);
    expect(none.memories.map((m: { id: string }) => m.id)).toEqual([A]);
    const before = h.hops();
    const lexical = data(
      (await h.run(['recall', QUERY, '--json', '--speed', 'lexical'])).io.stdout,
    );
    expect(lexical.memories.map((m: { id: string }) => m.id)).not.toContain(B);
    expect(h.hops()).toBe(before);
  });

  it('links.cli-recall-under-a-budget-never-prints-a-linked-line-without-its-seed', async () => {
    const h = await linked('user');
    // The linked memory outranks the hit it came from.
    const plain = h.wire;
    h.wire = async (dir, o) => ({
      ...(await plain(dir, o)),
      rerank: {
        rerank: async (_q, docs, topK) =>
          docs
            .map((d) => ({
              id: d.id,
              score: d.text.includes('Postgres') ? 0.9 : d.text.includes('moved to') ? 0.6 : 0.1,
            }))
            .sort((x, y) => y.score - x.score)
            .slice(0, topK),
      },
    });
    const lines = async (...flags: string[]) =>
      (await h.run(['recall', QUERY, ...flags])).io.stdout
        .split('\n')
        .filter((l) => l.startsWith('- ['));
    const whole = await lines();
    expect(whole.map((l) => l.includes('linked'))).toEqual([true, false]);
    const [linkedLine, hitLine] = whole as [string, string];
    // Room for one line: the hit is printed, not the linked memory that ranks above it.
    expect(await lines('--budget-chars', String(29 + hitLine.length))).toEqual([hitLine]);
    // Never the linked line by itself, at any budget too small for both.
    for (let room = 30; room < 29 + hitLine.length + 1 + linkedLine.length; room += 7) {
      const got = await lines('--budget-chars', String(room));
      expect(got.some((l) => l.includes('linked'))).toBe(false);
    }
  });

  it('links.cli-an-agent-link-needs-the-flag-or-the-config', async () => {
    const h = await linked('agent');
    const ids = async (...flags: string[]) =>
      data((await h.run(['recall', QUERY, '--json', ...flags])).io.stdout).memories.map(
        (m: { id: string }) => m.id,
      );
    expect(await ids()).toEqual([A]);
    expect(await ids('--links')).toEqual([A, B]);
    // A repository's config cannot turn it on; the home config can.
    fs.writeFileSync(path.join(h.cwd, 'oort.config.json'), '{"recall":{"links":{"enabled":true}}}');
    expect(await ids()).toEqual([A]);
    fs.mkdirSync(h.home, { recursive: true });
    fs.writeFileSync(path.join(h.home, 'config.json'), '{"recall":{"links":{"enabled":true}}}');
    expect(await ids()).toEqual([A, B]);
    expect(await ids('--no-links')).toEqual([A]);
  });

  it('links.cli-explain-shows-a-via-column-only-when-something-is-linked', async () => {
    const h = await linked('user');
    const table = (await h.run(['explain', QUERY])).io.stdout;
    expect(table).toMatch(/\bvia\b/);
    expect(table).toContain('explicit <- #1');
    const json = data((await h.run(['explain', QUERY, '--json'])).io.stdout);
    expect(json.memories[1].explanation.via).toMatchObject({ kind: 'explicit', from: A });
    const plain = (await h.run(['explain', QUERY, '--no-links'])).io.stdout;
    expect(plain).not.toMatch(/\bvia\b/);
    expect(plain).not.toContain('<-');
  });
});

describe('MCP recall and the SDK carry via (CON-149)', () => {
  it('links.mcp-recall-says-which-memory-a-link-came-from', async () => {
    const h = await linked('user');
    const w = await h.wire(h.cwd);
    const out = await localBackend({ wired: w }).recall({ query: QUERY, limit: 5 });
    expect(out.memories.map((m) => m.id)).toEqual([A, B]);
    expect(out.memories[0]!.via).toBeUndefined();
    expect(out.memories[1]).toMatchObject({
      via: { kind: 'explicit', from: A },
      why: 'rerank 0.60, linked (explicit)',
    });
  });

  it('links.sdk-why-via-and-the-prompt-label', async () => {
    const root = tmpdir('oort-sdk-links-');
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    // denseK 2: the dense search keeps its two best, so the third memory comes only by its link.
    fs.writeFileSync(
      path.join(home, 'config.json'),
      '{"recall":{"links":{"enabled":true},"denseK":2}}',
    );
    const oort = await createOortWith(
      { mode: 'local', home, env: { HOME: root, OORT_NO_KEYCHAIN: '1' }, project: null },
      { adapters: { ...fakeAdapters(), rerank } },
    );
    const a = (await oort.remember('auth-service moved to port 8080')).results[0]!.id!;
    const b = (await oort.remember('The storage engine is Postgres 16.')).results[0]!.id!;
    await oort.remember('Which port auth-service did use before is unknown.');
    // The SDK links as an agent, so this needs `recall.links.enabled` (set in the home config).
    expect(await oort.link(a, b)).toMatchObject({ linked: true, assertedBy: 'agent' });
    const r = await oort.recall(QUERY);
    expect(r.memories.map((m) => m.id)).toEqual([a, b]);
    expect(r.memories[1]!.why.via).toMatchObject({ kind: 'explicit', from: a });
    expect(r.memories[0]!.why.via).toBeUndefined();
    expect(formatForPrompt(r)).toMatch(/- \[semantic, today, linked\] The storage engine/);
    // `fast` has no rerank: with the flag on it goes through the coverage gate, which keeps a
    // memory with no query word out; `lexical` follows nothing.
    for (const speed of ['fast', 'lexical'] as const) {
      const ids = (await oort.recall(QUERY, { speed })).memories.map((m) => m.id);
      expect(ids).toContain(a);
      expect(ids).not.toContain(b);
    }
    await oort.close();
  });
});

describe('links in cloud mode are local-only (CON-153 follows)', () => {
  const cloudHome = (config?: string) => {
    const root = tmpdir();
    const home = path.join(root, 'oort-home');
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    const key = ['oort', 'sk', 'recalllinks'.padEnd(43, 'L')].join('_');
    const cloud = fakeCloud(key);
    writeCloudSettings(home, { store: 'cloud' });
    if (config !== undefined) fs.writeFileSync(path.join(home, 'config.json'), config);
    const wire: WireFn = (dir, o = {}) =>
      realWire(dir, { ...o, keychain: async () => undefined, fetch: cloud.fetch });
    const run = async (args: string[]) => {
      const io = fakeIo({
        cwd,
        env: { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: key },
      });
      const code = await runCli(args, io, wire, createKeychain({ platform: 'none' }), {
        fetch: cloud.fetch,
      });
      return { code, io };
    };
    return { cloud, run, wire, cwd, root, home, key };
  };

  it('links.cloud-refuses-the-links-flag-before-anything-is-sent', async () => {
    const { cloud, run } = cloudHome();
    const r = await run(['recall', 'deploy', '--links']);
    expect(r.code).not.toBe(0);
    expect(r.io.stderr).toMatch(/local-only for now: Oort Cloud does not hold links yet/);
    expect(cloud.recalls).toEqual([]);
    const e = await run(['explain', 'deploy', '--links', '--json']);
    expect(e.code).not.toBe(0);
    expect(cloud.recalls).toEqual([]);
    // Without the flag the recall runs as before, and `--no-links` asks for nothing new.
    expect((await run(['recall', 'deploy', '--json'])).code).toBe(0);
    expect((await run(['recall', 'deploy', '--json', '--no-links'])).code).toBe(0);
    expect(cloud.recalls).toHaveLength(2);
    expect(JSON.stringify(cloud.recalls)).not.toMatch(/links/);
  });

  it('links.cloud-says-once-that-recall-links-is-not-followed', async () => {
    const { cloud, run, wire, cwd, root, home, key } = cloudHome(
      '{"recall":{"links":{"enabled":true}}}',
    );
    const r = await run(['recall', 'deploy', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.io.stdout).warnings).toEqual([
      expect.objectContaining({ code: 'links-local-only' }),
    ]);
    expect(r.io.stderr).toMatch(/Oort Cloud does not follow links yet/);
    expect(cloud.recalls).toHaveLength(1);
    // The MCP `recall` tool says the same in its note.
    const w = await wire(cwd, {
      env: { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: key },
    });
    const out = await localBackend({ wired: w }).recall({ query: 'deploy', limit: 5 });
    expect(out.note).toMatch(/Oort Cloud does not follow links yet/);
    await w.close();
    // The default config says nothing.
    const quiet = cloudHome();
    const q = await quiet.run(['recall', 'deploy', '--json']);
    expect(JSON.parse(q.io.stdout).warnings).toEqual([]);
  });
});
