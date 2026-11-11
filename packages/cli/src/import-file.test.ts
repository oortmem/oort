import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  nodeGrant,
  parseExport,
  planetNode,
  type Grant,
  type Memory,
  type MemoryStore,
} from '@oortmem/core';
import { openSqliteStore } from '@oortmem/store-sqlite';
import { fakeEmbedder, harness, memory, type Harness } from '../test/helpers.js';

/**
 * CON-137: `oort import <file>` reads an Oort export into this machine's store. The round trip
 * that matters: one end user's export from Oort Cloud (GET /v1/end-users/:id/export, written by
 * the real API: test/fixtures/cloud-end-user-export.jsonl is an identical copy of oortcloud's
 * apps/cloud/src/test/end-user-export.jsonl, which that repo checks against its exporter) lands
 * in a self-hosted Oort with every memory, its history and its tier, owned by this machine.
 */

const FIXTURE = path.join(import.meta.dirname, '../test/fixtures/cloud-end-user-export.jsonl');

/** Every Planet memory of this machine (local/self), any project, any state. */
const PLANET: Grant = nodeGrant({
  principal: { orgId: 'local', customerId: 'self', agentId: 'anonymous' },
  read: [{ node: planetNode({ orgId: 'local', customerId: 'self' }), projectIds: 'all' }],
});

const open: MemoryStore[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

/** A harness on a real SQLite store (and its cold directory), as `oort` runs on this machine. */
async function onSqlite(): Promise<Harness & { sqlite: MemoryStore }> {
  const h = harness();
  fs.mkdirSync(h.home, { recursive: true });
  const sqlite = await openSqliteStore({
    path: path.join(h.home, 'oort.sqlite'),
    coldDir: path.join(h.home, 'cold'),
    dimension: fakeEmbedder.dimension,
    log: () => {},
  });
  open.push(sqlite);
  const base = h.wire;
  h.wire = async (dir, o) => ({ ...(await base(dir, o)), store: sqlite });
  return Object.assign(h, { sqlite });
}

const all = async (s: MemoryStore): Promise<Memory[]> =>
  (await s.list(PLANET, { validOnly: false })).sort((a, b) => (a.id < b.id ? -1 : 1));

describe('oort import <file> (CON-137)', () => {
  it('cli.import-file-round-trips-an-oort-cloud-end-user-export', async () => {
    const h = await onSqlite();
    const exported = parseExport(fs.readFileSync(FIXTURE, 'utf8')).memories;
    expect(exported.length).toBe(6);
    const r = await h.run(['import', FIXTURE, '--yes']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain('Imported 6 memories');

    const here = await all(h.sqlite);
    expect(here.map((m) => m.id)).toEqual(exported.map((m) => m.id).sort());
    for (const m of here) {
      const was = exported.find((x) => x.id === m.id)!;
      // Owned by this machine's Planet; the end user's id and the cloud account are gone.
      expect(m.scope).toMatchObject({ orgId: 'local', customerId: 'self' });
      expect(JSON.stringify(m)).not.toContain('u:ada');
      expect(JSON.stringify(m)).not.toContain('acct:');
      // Everything else as exported: project, type, validity, history, pin, tier, dates.
      expect(m.scope.projectId).toBe(was.scope.projectId);
      for (const k of [
        'type',
        'stub',
        'entities',
        'pinned',
        'tier',
        'validFrom',
        'validTo',
        'expiredAt',
        'endReason',
        'supersedes',
        'supersededBy',
        'createdAt',
      ] as const) {
        expect(m[k], `${m.id} ${k}`).toEqual(was[k]);
      }
      // Embedded again by this store's embedder.
      if (m.tier !== 'cold') expect(m.embedding?.length).toBe(fakeEmbedder.dimension);
    }
    // The corrected fact: kept, ended, never rewritten; the correction current.
    const oslo = here.find((m) => m.text === 'Ada lives in Oslo.')!;
    expect(oslo).toMatchObject({ endReason: 'corrected', validTo: null });
    expect(oslo.expiredAt).not.toBeNull();
    const bergen = here.find((m) => m.supersedes === oslo.id)!;
    expect(bergen).toMatchObject({ text: 'Ada lives in Bergen.', expiredAt: null });
    // The cold one is cold again, its full text in its cold copy.
    const cold = here.find((m) => m.tier === 'cold')!;
    const blob = await h.sqlite.coldGet(PLANET, cold.id);
    expect(blob?.text).toBe(exported.find((m) => m.id === cold.id)!.text);
    // Recall finds an imported memory from the cwd (a global one).
    // The CLI reads an imported memory by its id (inspect), and lexical search finds it. (Recall's
    // current mode would skip it: the fixture's facts are valid from the cloud test clock's date.)
    const hz = here.find((m) => m.text.includes('hazelnuts'))!;
    expect((await h.sqlite.lexical(PLANET, 'hazelnuts', 5)).map((x) => x.id)).toEqual([hz.id]);
    const inspected = await h.run(['inspect', hz.id, '--json']);
    expect(inspected.code, inspected.io.stderr).toBe(0);
    expect(inspected.io.stdout).toContain('Ada is allergic to hazelnuts.');

    // Again: nothing new, nothing doubled.
    const again = await h.run(['import', FIXTURE, '--yes', '--json']);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.io.stdout)).toMatchObject({
      ok: true,
      data: { outcome: 'nothing', imported: 0, skipped: 6, memories: 6, outside: 0 },
    });
    expect((await all(h.sqlite)).length).toBe(6);
  });

  it('cli.import-file-reads-an-empty-export', async () => {
    // An erased or unknown end user's export: the manifest alone.
    const h = await onSqlite();
    const file = path.join(h.root, 'empty.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ oort: 'export', version: 1, exportedAt: '2026-11-15T12:00:00.000Z', memories: 0, scopes: [] })}\n`,
    );
    const r = await h.run(['import', file, '--yes']);
    expect(r.code).toBe(0);
    expect(r.io.stdout).toContain('Nothing to import.');
    expect(await all(h.sqlite)).toEqual([]);
  });

  it('cli.import-file-round-trips-a-local-export', async () => {
    const from = await onSqlite();
    const grant = nodeGrant({
      principal: { orgId: 'local', customerId: 'self', agentId: 'anonymous' },
      read: [{ node: planetNode({ orgId: 'local', customerId: 'self' }), projectIds: 'all' }],
      write: [{ node: planetNode({ orgId: 'local', customerId: 'self' }), projectIds: 'all' }],
    });
    const a = memory({ text: 'We deploy on Fridays.', pinned: true });
    const b = memory({ text: 'The staging host is blue.' });
    await from.sqlite.upsertMany(grant, [a, b]);
    const file = path.join(from.root, 'mine.jsonl');
    expect((await from.run(['export', '--out', file])).code).toBe(0);

    const to = await onSqlite();
    const r = await to.run(['import', file, '--yes']);
    expect(r.code, r.io.stderr).toBe(0);
    const here = await all(to.sqlite);
    expect(here.map((m) => m.text).sort()).toEqual([
      'The staging host is blue.',
      'We deploy on Fridays.',
    ]);
    expect(here.find((m) => m.id === a.id)?.pinned).toBe(true);
  });

  it('cli.import-file-asks-first-and-refuses-what-it-cannot-read', async () => {
    const h = await onSqlite();
    // No terminal and no --yes: it never writes.
    const asked = await h.run(['import', FIXTURE]);
    expect(asked.code).not.toBe(0);
    expect(await all(h.sqlite)).toEqual([]);
    const json = await h.run(['import', FIXTURE, '--json']);
    expect(JSON.parse(json.io.stdout)).toMatchObject({
      ok: false,
      error: { code: 'needs-confirmation' },
    });

    const bad = (name: string, body: string) => {
      const f = path.join(h.root, name);
      fs.writeFileSync(f, body);
      return f;
    };
    for (const [file, why] of [
      [bad('notes.txt', 'just some notes\n'), /not an Oort export: line 1 is not JSON/],
      [
        bad('short.jsonl', `${JSON.stringify({ oort: 'export', version: 1, memories: 3 })}\n{}\n`),
        /not an Oort export: the manifest counts 3 memories, the file has 1/,
      ],
      [
        bad('v9.jsonl', `${JSON.stringify({ oort: 'export', version: 9, memories: 0 })}\n`),
        /export version 9 is not supported/,
      ],
    ] as const) {
      const r = await h.run(['import', file, '--yes']);
      expect(r.code, file).not.toBe(0);
      expect(r.io.stderr).toMatch(why);
    }
    // A transcript option with a file, and a path with no file: refused.
    const flag = await h.run(['import', FIXTURE, '--since', '2d', '--yes']);
    expect(flag.code).toBe(2);
    expect(flag.io.stderr).toContain('--since is for transcripts');
    const none = await h.run(['import', 'no-such-export.jsonl']);
    expect(none.code).toBe(2);
    expect(none.io.stderr).toContain('Unknown source');
    expect(await all(h.sqlite)).toEqual([]);
  });

  it('cli.import-file-checks-what-a-file-claims-and-trusts-no-judgment', async () => {
    // Security review of CON-137 (M1): a crafted file is not trusted. Lines with a type, tier,
    // salience, pin or id a store never writes are left out and counted; a judgment arrives as an
    // imported one (via pack, unconfirmed), so it counts only when judging asks for imports.
    const h = await onSqlite();
    const base = JSON.parse(fs.readFileSync(FIXTURE, 'utf8').split('\n')[1]!) as Record<
      string,
      unknown
    >;
    const judgment = {
      subject: { summary: 'PR 12' },
      verdict: 'approved',
      verdicts: ['approved', 'rejected'],
      reason: 'The tests pass.',
      criteria: [],
      domain: 'review',
      by: 'marcus',
      decidedAt: '2026-11-01T00:00:00.000Z',
      via: 'cli',
      confirmed: { at: '2026-11-02T00:00:00.000Z', by: 'marcus' },
    };
    const line = (id: string, over: Record<string, unknown>) =>
      JSON.stringify({
        ...base,
        id,
        supersedes: null,
        supersededBy: null,
        expiredAt: null,
        endReason: null,
        validTo: null,
        ...over,
      });
    const lines = [
      line('ok-1', { pinned: false }),
      line('ok-pinned', { pinned: true }),
      line('ok-judgment', { type: 'judgment', judgment }),
      line('bad-type', { type: 'admin' }),
      line('bad-tier', { tier: 'frozen' }),
      line('bad-salience-high', { salience: 1e9 }),
      line('bad-salience-low', { salience: -0.1 }),
      line('bad-pinned', { pinned: 'true' }),
      line('bad-judgment', { type: 'judgment', judgment: { ...judgment, verdict: undefined } }),
      line('bad-stray-judgment', { judgment }),
      line('bad/id', {}),
    ];
    const file = path.join(h.root, 'crafted.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          oort: 'export',
          version: 1,
          exportedAt: '2026-11-15T12:00:00.000Z',
          memories: lines.length,
          scopes: [],
        }),
        ...lines,
      ].join('\n') + '\n',
    );
    // The question says what it brings in and where each memory's text goes.
    const asked = await h.run(['import', file], { tty: true, answer: 'n' });
    expect(asked.code).toBe(0);
    expect(asked.io.asked[0]).toMatch(
      /^Import 3 memories \(1 pinned; 1 judgment, counted only when judging includes imports\)\? Each memory's text is sent to Voyage AI to be embedded/,
    );
    expect(asked.io.stdout).toMatch(/not valid\s+8 \(left out\)/);
    expect(await all(h.sqlite)).toEqual([]);

    const r = await h.run(['import', file, '--yes', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(JSON.parse(r.io.stdout).data).toMatchObject({
      outcome: 'imported',
      memories: 11,
      imported: 3,
      invalid: 8,
      pinned: 1,
      judgments: 1,
    });
    const here = await all(h.sqlite);
    expect(here.map((m) => m.id)).toEqual(['ok-1', 'ok-judgment', 'ok-pinned']);
    const j = here.find((m) => m.id === 'ok-judgment')!.judgment!;
    expect(j.via).toBe('pack');
    expect(j.confirmed).toBeUndefined();
    expect(j.pack).toMatchObject({
      name: 'crafted.jsonl',
      exportedAt: '2026-11-15T12:00:00.000Z',
      exportedBy: 'oort import',
      originalId: 'ok-judgment',
    });
    expect(j.pack!.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('cli.errors-never-print-terminal-escapes', async () => {
    // L-c: a field name in a crafted file, or any error's message, reaches stderr escaped.
    const h = await onSqlite();
    const osc = '\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007\u001b[2J';
    const file = path.join(h.root, 'escapes.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          oort: 'export',
          version: 2,
          exportedAt: '2026-11-15T12:00:00.000Z',
          memories: 1,
          scopes: [],
          addresses: [],
        }),
        JSON.stringify({
          id: 'm1',
          address: { level: 'user', orgId: 'local', customerId: 'self', [osc]: 1 },
          author: { agentId: 'anonymous' },
        }),
      ].join('\n') + '\n',
    );
    const r = await h.run(['import', file, '--yes']);
    expect(r.code).not.toBe(0);
    expect(r.io.stderr).not.toMatch(/[\u0007\u001b]/);
    expect(r.io.stderr).toContain('unknown field');
    // Any unexpected error's message, not only the ones Oort words itself.
    const base = h.wire;
    h.wire = async () => {
      throw new Error(`the store said ${osc}`);
    };
    const odd = await h.run(['stats']);
    expect(odd.code).not.toBe(0);
    expect(odd.io.stderr).toContain('the store said');
    expect(odd.io.stderr).not.toMatch(/[\u0007\u001b]/);
    expect(odd.io.stderr).toContain('\\u{1b}');
    h.wire = base;
  });

  it('cli.import-file-is-refused-in-cloud-mode', async () => {
    const h = harness();
    const base = h.wire;
    h.wire = async (dir, o) => ({ ...(await base(dir, o)), mode: 'cloud' });
    const r = await h.run(['import', FIXTURE, '--yes']);
    expect(r.code).not.toBe(0);
    expect(r.io.stderr).toContain('oort cloud use --local');
  });
});
