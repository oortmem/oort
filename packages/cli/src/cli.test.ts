import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { localScope, parseExport, type Embedder, type Memory } from '@oortmem/core';
import { StoreMigrationRequiredError } from '@oortmem/store-sqlite';
import { HOOK_RABITQ_MAX_LOAD, MIGRATION_PENDING_NOTE } from './commands/hook.js';
import { HOST_RABITQ_BUILD_BATCHES } from './wire.js';
import {
  AWS_KEY,
  fakeIo,
  fakeWriter,
  harness,
  memory,
  tmpdir,
  writeTranscript,
  data,
} from '../test/helpers.js';
import { runCli } from './program.js';
import { when } from './util.js';
import { wire as realWire, type WireFn } from './wire.js';
import { TG } from '@oortmem/core/store-conformance';
import { localGrant } from '@oortmem/core';

// The real wire, but never the real Keychain (tests may pass their own reader).
const wire: WireFn = (cwd, opts) => realWire(cwd, { keychain: async () => undefined, ...opts });

const readLines = (file: string): Record<string, unknown>[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('oort observe', () => {
  it('cli.observe-dry-run-touches-nothing', async () => {
    const h = harness();
    const flags = await h.run([
      'observe',
      '--dry-run',
      '--user',
      `deploy with key ${AWS_KEY} please`,
      '--assistant',
      'Deployed the auth service to eu-west-1.',
    ]);
    expect(flags.code).toBe(0);
    const report = JSON.parse(flags.io.stdout) as {
      dropped: boolean;
      redactions: { kind: string; count: number }[];
    };
    expect(report.dropped).toBe(false);
    expect(report.redactions).toEqual([{ kind: expect.stringMatching(/aws/), count: 1 }]);
    expect(flags.io.stdout + flags.io.stderr).not.toContain(AWS_KEY);

    // The same from stdin JSON; a mostly-secret observation would be dropped.
    const piped = await h.run(['observe', '--dry-run'], {
      stdin: JSON.stringify({ userText: AWS_KEY, assistantText: '' }),
    });
    expect(piped.code).toBe(0);
    expect(JSON.parse(piped.io.stdout)).toMatchObject({ dropped: true });

    // Neither run opened the store or built an adapter.
    expect(h.wired).toBe(0);
    expect(fs.existsSync(h.home)).toBe(false);
  });

  it('cli.observe-refuses-without-keys', async () => {
    const h = harness({ adapters: false });
    const r = await h.run(['observe', '--user', 'which port?', '--assistant', 'port 5582']);
    expect(r.code).toBe(2);
    // The shared remedy for each missing key, and saving's need for decide and write keys.
    for (const p of ['voyage', 'typesafe', 'anthropic']) {
      expect(r.io.stderr).toContain(`oort keys set ${p}`);
    }
    expect(r.io.stderr).toContain('oort models pull');
    expect(r.io.stderr).toContain('no local model does decide');
    expect(r.io.stderr).not.toMatch(/export [A-Z_]+_API_KEY/);
    expect(r.io.stderr).not.toContain('oort: oort');
    expect(r.io.stdout).toBe('');

    // No key store (OORT_NO_KEYCHAIN=1): each missing variable is named, and `oort keys set` is
    // not offered, since it would refuse.
    const bare = harness({ adapters: false, keyStore: false });
    const nb = await bare.run(['observe', '--user', 'which port?', '--assistant', 'port 5582']);
    expect(nb.code).toBe(2);
    for (const v of ['VOYAGE_API_KEY', 'TYPESAFE_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect(nb.io.stderr).toMatch(
        new RegExp(`[Ss]et ${v} in the environment your agent starts with`),
      );
    }
    expect(nb.io.stderr).toContain('oort models pull');
    expect(nb.io.stderr).not.toContain('oort keys set');
    expect(nb.io.stderr).not.toMatch(/export [A-Z_]+_API_KEY/);
    expect(
      await h.store.list(
        localGrant({
          orgId: 'local',
          customerId: 'self',
          agentId: 'claude-code',
          projectIds: [null],
        }),
        { validOnly: false },
      ),
    ).toEqual([]);

    // With the adapters present the same observation is stored.
    const ok = await harness().run([
      'observe',
      '--user',
      'which port?',
      '--assistant',
      'port 5582',
    ]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.io.stdout)).toMatchObject({ outcome: 'added' });
  });

  it('cli.observe-rejects-bad-stdin', async () => {
    const h = harness();
    expect((await h.run(['observe'], { stdin: 'not json' })).code).toBe(2);
    const r = await h.run(['observe'], { stdin: JSON.stringify({ userText: 1 }) });
    expect(r.code).toBe(2);
    expect(r.io.stderr).toMatch(/userText/);
    expect((await h.run(['observe'], { tty: true })).code).toBe(2);
    expect((await h.run(['observe', '--user', 'only one'])).code).toBe(2);
  });
});

describe('oort inspect', () => {
  it('cli.inspect-shows-supersede-chain', async () => {
    const h = harness();
    const a = memory({
      text: 'The auth service listens on port 4000.',
      validFrom: '2026-09-01T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    const b = memory({
      text: 'The auth service listens on port 5000.',
      validFrom: '2026-09-10T00:00:00.000Z',
      createdAt: '2026-09-10T00:00:00.000Z',
    });
    const c = memory({
      text: 'The auth service listens on port 5582.',
      validFrom: '2026-09-20T00:00:00.000Z',
      createdAt: '2026-09-20T00:00:00.000Z',
    });
    const closed = (m: Memory, next: Memory): Memory => ({
      ...m,
      validTo: next.validFrom,
      expiredAt: next.validFrom,
      endReason: 'superseded',
      supersededBy: next.id,
    });
    await h.store.upsertMany(TG, [
      closed(a, b),
      {
        ...closed(b, c),
        supersedes: a.id,
        source: {
          harness: 'claude-code',
          decisions: [
            { stage: 'reconcile', question: 'action', answer: 'SUPERSEDE', probability: 0.87 },
          ],
        },
      },
      { ...c, supersedes: b.id },
    ]);

    const r = await h.run(['inspect', b.id.slice(0, 8)]);
    expect(r.code).toBe(0);
    const out = r.io.stdout;
    expect(out).toContain(b.id);
    expect(out).toMatch(/reconcile\s+action\s+SUPERSEDE\s+0\.870/);
    const chain = out.slice(out.indexOf('supersede chain'));
    const at = (id: string): number => chain.indexOf(id.slice(0, 8));
    expect(at(a.id)).toBeGreaterThan(0);
    expect(at(a.id)).toBeLessThan(at(b.id));
    expect(at(b.id)).toBeLessThan(at(c.id));
    // Each link's validity window, in local time rather than raw ISO.
    const local = (iso: string): string => when(iso, new Date(), { short: true });
    expect(chain).toMatch(
      new RegExp(
        `${a.id.slice(0, 8)}\\s+${local('2026-09-01T00:00:00.000Z')}\\s+${local('2026-09-10T00:00:00.000Z')}\\s+superseded`,
      ),
    );
    expect(chain).toMatch(
      new RegExp(`${c.id.slice(0, 8)}\\s+${local('2026-09-20T00:00:00.000Z')}\\s+open`),
    );
    expect(out).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:/);

    const json = await h.run(['inspect', b.id, '--json']);
    const parsed = data(json.io.stdout) as {
      memory: Memory;
      chain: { id: string; validTo: string | null }[];
    };
    expect(parsed.memory.source.decisions).toHaveLength(1);
    expect(parsed.chain.map((l) => l.id)).toEqual([a.id, b.id, c.id]);
    expect(parsed.chain.map((l) => l.validTo)).toEqual([b.validFrom, c.validFrom, null]);
    expect(json.io.stdout).not.toContain('"embedding"');

    // The listing shows current memories only.
    const list = await h.run(['inspect']);
    expect(list.io.stdout).toContain(c.id.slice(0, 8));
    expect(list.io.stdout).not.toContain(a.id.slice(0, 8));
    // One header line, then the table (its header row first).
    expect(list.io.stdout.split('\n')[0]).toMatch(/^oort inspect · /);
    expect(list.io.stdout.split('\n')[1]).toMatch(/^id\s+type\s+tier\s+activation\s+age\s+text$/);

    expect((await h.run(['inspect', 'ffffffff-nope'])).code).toBe(2);
  });
});

describe('scope boundaries', () => {
  const elsewhere = localScope('other-1234abcd');

  it('cli.inspect-hides-out-of-scope-chain', async () => {
    const h = harness(); // the cwd's scope is global
    const g = memory({ text: 'global port 4000', validFrom: '2026-09-01T00:00:00.000Z' });
    const p = memory({
      text: 'project-only port 5000',
      scope: elsewhere,
      validFrom: '2026-09-10T00:00:00.000Z',
    });
    // A chain that crosses scopes (written before observe kept chains in one scope).
    await h.store.upsertMany(TG, [
      {
        ...g,
        validTo: p.validFrom,
        expiredAt: p.validFrom,
        endReason: 'superseded',
        supersededBy: p.id,
      },
      { ...p, supersedes: g.id },
    ]);
    const text = await h.run(['inspect', g.id]);
    expect(text.code).toBe(0);
    expect(text.io.stdout).not.toContain(p.id.slice(0, 8));
    expect(text.io.stdout).not.toContain('project-only');
    expect(text.io.stdout).toContain('1 linked memory in another scope (not shown)');

    const json = await h.run(['inspect', g.id, '--json']);
    const parsed = data(json.io.stdout) as { chain: { id: string }[]; hiddenLinks: number };
    expect(parsed.chain.map((l) => l.id)).toEqual([g.id]);
    expect(parsed.hiddenLinks).toBe(1);
    expect(json.io.stdout).not.toContain('project-only');
    // Omitted links show no id either: the pointer is nulled and flagged.
    expect(json.io.stdout).not.toContain(p.id);
    const shown = data(json.io.stdout) as { memory: Record<string, unknown> };
    expect(shown.memory).toMatchObject({ supersededBy: null, supersededByHidden: true });
    expect(shown.memory['supersedesHidden']).toBeUndefined();
    // The listing and recall --json shape their records the same way.
    for (const args of [
      ['inspect', '--json'],
      ['recall', 'global port', '--json'],
    ]) {
      const r = await h.run(args);
      expect(r.io.stdout, args.join(' ')).not.toContain(p.id);
    }
    // Storage is untouched.
    expect((await h.store.get(TG, g.id))?.supersededBy).toBe(p.id);
  });

  it('cli.pin-forget-refuse-out-of-scope-id', async () => {
    const h = harness();
    const p = memory({ text: 'another project fact', scope: elsewhere });
    await h.store.upsert(TG, p);
    for (const args of [
      ['inspect', p.id],
      ['pin', p.id],
      ['unpin', p.id],
      ['forget', p.id, '--yes'],
    ]) {
      const r = await h.run(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.io.stderr).toMatch(/no such memory in this project/i);
      expect(r.io.stdout).not.toContain('another project fact');
    }
    expect(await h.store.get(TG, p.id)).toEqual(p);
  });
});

describe('oort stats', () => {
  it('cli.stats-reports-tiers', async () => {
    const h = harness();
    const cold = memory({ text: 'cold fact' });
    await h.store.upsertMany(TG, [
      memory({ tier: 'hot' }),
      memory({ tier: 'warm' }),
      memory({
        tier: 'warm',
        validTo: '2026-10-02T00:00:00.000Z',
        expiredAt: '2026-10-02T00:00:00.000Z',
        endReason: 'superseded',
      }),
      memory({
        tier: 'warm',
        validTo: '2026-10-02T00:00:00.000Z',
        expiredAt: '2026-10-02T00:00:00.000Z',
        endReason: 'expired',
      }),
      cold,
    ]);
    await h.store.coldPut(TG, cold);
    fs.mkdirSync(path.join(h.home, 'queue', 'dead'), { recursive: true });
    fs.writeFileSync(path.join(h.home, 'queue', 's1.jsonl'), '{"a":1}\n{"a":2}\n');
    fs.writeFileSync(path.join(h.home, 'queue', 'dead', 's1.jsonl'), '{"a":3}\n');
    fs.mkdirSync(path.join(h.home, 'cold', 'ab'), { recursive: true });
    fs.writeFileSync(path.join(h.home, 'cold', 'ab', 'blob'), Buffer.alloc(1000));

    const r = await h.run(['stats', '--json']);
    expect(r.code).toBe(0);
    const s = data(r.io.stdout) as Record<string, unknown>;
    expect(s).toMatchObject({
      tiers: { hot: 1, warm: 3, cold: 1 },
      validity: { current: 3, superseded: 1, expired: 1, notYetValid: 0 },
      coldBytes: 1000,
      queue: { pending: 2, deadLetters: 1 },
    });
    expect(s['rssBytes']).toBeGreaterThan(0);

    const text = await h.run(['stats']);
    expect(text.io.stdout).toMatch(/hot 1, warm 3, cold 1/);
    expect(text.io.stdout).toMatch(/2 pending, 1 dead-lettered/);
  });
});

/** The export format (versions 1 and 2) as documented in docs/export-format.md. */
const ScopeSchema = z.strictObject({
  orgId: z.string(),
  customerId: z.string(),
  agentId: z.string(),
  projectId: z.string().optional(),
});
const iso = z.iso.datetime();
const ManifestSchema = z.strictObject({
  oort: z.literal('export'),
  version: z.literal(1),
  exportedAt: iso,
  memories: z.number().int().min(0),
  scopes: z.array(ScopeSchema),
});
const AddressSchema = z.strictObject({
  level: z.literal('user'),
  orgId: z.string(),
  customerId: z.string(),
  projectId: z.string().optional(),
});
const ManifestV2Schema = ManifestSchema.extend({
  version: z.literal(2),
  addresses: z.array(AddressSchema),
});
const MemoryLineSchema = z.strictObject({
  id: z.string(),
  scope: ScopeSchema,
  type: z.enum(['semantic', 'episodic', 'procedural', 'preference']),
  text: z.string(),
  stub: z.string(),
  entities: z.array(z.string()),
  salience: z.number(),
  pinned: z.boolean(),
  tier: z.enum(['hot', 'warm', 'cold']),
  accessLog: z.strictObject({
    count: z.number(),
    recent: z.array(iso),
    compactedSum: z.number(),
    compactedAt: iso.nullable(),
    compactedMeanAgeHours: z.number().optional(),
  }),
  validFrom: iso,
  validTo: iso.nullable(),
  expiredAt: iso.nullable(),
  endReason: z.enum(['superseded', 'corrected', 'expired']).nullable(),
  lastConfirmedAt: iso.nullable(),
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable(),
  supersedesHidden: z.literal(true).optional(),
  supersededByHidden: z.literal(true).optional(),
  source: z.strictObject({
    harness: z.string(),
    sessionId: z.string().optional(),
    turnRef: z.string().optional(),
    decisions: z.array(
      z.strictObject({
        stage: z.string(),
        question: z.string(),
        answer: z.string(),
        probability: z.number(),
      }),
    ),
  }),
  embedding: z.base64().optional(),
  createdAt: iso,
  updatedAt: iso,
});
/** Version 2 lines: version 1's fields plus the address, the author and provenance. */
const MemoryLineV2Schema = MemoryLineSchema.extend({
  address: AddressSchema,
  author: z.strictObject({ agentId: z.string(), accountRef: z.string().optional() }),
  provenance: z.null(),
});

describe('oort export', () => {
  it('cli.export-roundtrip-format', async () => {
    const h = harness();
    const warm = memory({ text: 'warm fact', createdAt: '2026-10-01T00:00:00.000Z' });
    const cold = memory({
      text: 'cold fact with its full text',
      embedding: Int8Array.from([127, -128, 0, 5]),
      createdAt: '2026-10-02T00:00:00.000Z',
      source: {
        harness: 'claude-code',
        sessionId: 's',
        decisions: [{ stage: 'gate', question: 'store?', answer: 'yes', probability: 0.9 }],
      },
    });
    const noEmbedding = memory({
      text: 'no vector',
      embedding: undefined,
      createdAt: '2026-10-03T00:00:00.000Z',
    });
    const elsewhere = memory({ text: 'another project', scope: localScope('other-1234abcd') });
    await h.store.upsertMany(TG, [warm, cold, noEmbedding, elsewhere]);
    await h.store.coldPut(TG, cold);
    expect((await h.store.get(TG, cold.id))?.embedding).toBeUndefined();

    fs.mkdirSync(h.home, { recursive: true });
    const file = path.join(h.home, 'export.jsonl');
    const r = await h.run(['export', '--out', file]);
    expect(r.code).toBe(0);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const [head, ...rest] = readLines(file);
    const manifest = ManifestV2Schema.parse(head);
    expect(manifest.memories).toBe(3);
    expect(manifest.scopes).toEqual([
      { orgId: 'local', customerId: 'self', agentId: 'claude-code' },
    ]);
    expect(manifest.addresses).toEqual([{ level: 'user', orgId: 'local', customerId: 'self' }]);
    const lines = rest.map((l) => MemoryLineV2Schema.parse(l));
    expect(lines.map((l) => l.author)).toEqual(Array(3).fill({ agentId: 'claude-code' }));
    // Phase 1: the cwd's project plus global only (docs/export-format.md, Limitations).
    expect(lines.map((l) => l.id)).toEqual([warm.id, cold.id, noEmbedding.id]);
    const c = lines[1];
    expect(c?.tier).toBe('cold');
    expect(c?.text).toBe('cold fact with its full text');
    // The cold copy's embedding, decoded from base64 int8 bytes.
    expect(Int8Array.from(Buffer.from(c?.embedding ?? '', 'base64'))).toEqual(
      Int8Array.from([127, -128, 0, 5]),
    );
    expect(lines[2]?.embedding).toBeUndefined();

    // stdout carries the same lines.
    const out = await h.run(['export']);
    const stdoutLines = out.io.stdout.trimEnd().split('\n');
    expect(stdoutLines).toHaveLength(4);
    expect(stdoutLines.slice(1)).toEqual(
      fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(1),
    );

    // Reading it back gives the store's records (cold ones decoded).
    const parsed = parseExport(fs.readFileSync(file, 'utf8'));
    expect(parsed.memories.map((m) => m.id)).toEqual([warm.id, cold.id, noEmbedding.id]);
    expect(parsed.memories[0]).toEqual(await h.store.get(TG, warm.id));
  });

  it('cli.export-format-1', async () => {
    const h = harness();
    const m = memory({ text: 'a planet fact', embedding: Int8Array.from([1, 2, 3, 4]) });
    await h.store.upsert(TG, m);
    const r = await h.run(['export', '--format', '1']);
    expect(r.code).toBe(0);
    const [head, line] = r.io.stdout
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as unknown);
    expect(ManifestSchema.parse(head).version).toBe(1);
    expect(MemoryLineSchema.parse(line).id).toBe(m.id);
    // Version 1 still reads, as the Planet.
    expect(parseExport(r.io.stdout).memories).toEqual([await h.store.get(TG, m.id)]);
    const bad = await h.run(['export', '--format', '3']);
    expect(bad.code).toBe(2);
    expect(bad.io.stderr).toMatch(/--format "3" must be 1 or 2/);
  });
});

describe('oort export, scope', () => {
  it('cli.export-redacts-out-of-scope-links', async () => {
    const h = harness(); // global scope
    const other = localScope('other-1234abcd');
    const a = memory({ text: 'global a', createdAt: '2026-09-01T00:00:00.000Z' });
    const p = memory({ text: 'project p', scope: other, createdAt: '2026-09-02T00:00:00.000Z' });
    const b = memory({ text: 'global b', createdAt: '2026-09-03T00:00:00.000Z' });
    await h.store.upsertMany(TG, [
      { ...a, supersededBy: p.id, validTo: p.validFrom, endReason: 'superseded' },
      { ...p, supersedes: a.id, supersededBy: b.id },
      { ...b, supersedes: p.id },
    ]);
    const r = await h.run(['export']);
    expect(r.code).toBe(0);
    expect(r.io.stdout).not.toContain(p.id);
    expect(r.io.stdout).not.toContain('project p');
    const lines = r.io.stdout
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((l) => MemoryLineV2Schema.parse(JSON.parse(l)));
    expect(
      lines.map((l) => [
        l.id,
        l.supersedes,
        l.supersededBy,
        l.supersedesHidden,
        l.supersededByHidden,
      ]),
    ).toEqual([
      [a.id, null, null, undefined, true],
      [b.id, null, null, true, undefined],
    ]);
    // In-scope links keep their ids.
    const c = memory({ text: 'global c', supersedes: b.id, createdAt: '2026-09-04T00:00:00.000Z' });
    await h.store.upsert(TG, c);
    const again = (await h.run(['export'])).io.stdout;
    expect(again).toContain(`"supersedes":"${b.id}"`);
  });
});

describe('oort export --out', () => {
  it('cli.export-out-refuses-existing-and-symlinks', async () => {
    const h = harness();
    await h.store.upsert(TG, memory());
    fs.mkdirSync(h.home, { recursive: true });
    const file = path.join(h.root, 'out.jsonl');
    fs.writeFileSync(file, 'keep me');
    const refused = await h.run(['export', '--out', file]);
    expect(refused.code).toBe(2);
    expect(refused.io.stderr).toMatch(/--force/);
    expect(fs.readFileSync(file, 'utf8')).toBe('keep me');
    const forced = await h.run(['export', '--json', '--out', file, '--force']);
    expect(forced.code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^\{"oort":"export"/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    // A symlink is never followed, even with --force.
    const target = path.join(h.root, 'target.txt');
    fs.writeFileSync(target, 'untouched');
    const link = path.join(h.root, 'link.jsonl');
    fs.symlinkSync(target, link);
    for (const args of [
      ['--out', link],
      ['--out', link, '--force'],
    ]) {
      const r = await h.run(['export', ...args]);
      expect(r.code).toBe(2);
      expect(r.io.stderr).toMatch(/symlink/);
    }
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
  });
});

describe('refusal messages', () => {
  it('cli.refusals-clip-echoed-arguments', async () => {
    const h = harness();
    const long = `sk-${'x'.repeat(60)}`;
    const cases = [
      ['inspect', long],
      ['inspect', '--limit', long],
      ['import', 'claude-code', '--since', long],
      ['import', long],
      ['install', long],
      ['recall', 'q', '--as-of', long],
      [long],
    ];
    for (const args of cases) {
      const r = await h.run(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.io.stderr).not.toContain('x'.repeat(24));
    }
    const asOf = await h.run(['recall', 'q', '--as-of', 'not-a-date']);
    expect(asOf.io.stderr).not.toContain('not-a-date');
    // A short secret fits the clip, so echoes are scrubbed too.
    const key = await h.run(['inspect', AWS_KEY]);
    expect(key.code).toBe(2);
    expect(key.io.stderr).not.toContain(AWS_KEY);
    expect(key.io.stderr).toContain('[REDACTED:');
  });
});

describe('commander errors', () => {
  it('cli.unknown-command-and-option-scrub-args', async () => {
    const h = harness();
    for (const args of [[AWS_KEY], ['stats', `--${AWS_KEY}`], ['recall', 'q', `--${AWS_KEY}`]]) {
      const r = await h.run(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.io.stderr).toMatch(/unknown (command|option)/);
      expect(r.io.stderr).not.toContain(AWS_KEY);
      expect(r.io.stderr).not.toContain(AWS_KEY.slice(4));
    }
  });
});

describe('docs/export-format.md', () => {
  it('cli.export-doc-states-limitations', () => {
    const doc = fs.readFileSync(
      path.join(import.meta.dirname, '..', '..', '..', 'docs', 'export-format.md'),
      'utf8',
    );
    const limits = doc.slice(doc.indexOf('\n## Limitations\n'));
    expect(limits.startsWith('\n## Limitations\n')).toBe(true);
    expect(limits).toMatch(/current project/);
    expect(limits).toMatch(/plus global/);
    expect(limits).toMatch(/CON-36/);
  });
});

describe('oort forget, pin', () => {
  it('cli.forget-refuses-non-tty-without-yes', async () => {
    const h = harness();
    const m = memory({ text: 'secret-ish memory text' });
    await h.store.upsert(TG, m);

    const refused = await h.run(['forget', m.id]);
    expect(refused.code).toBe(2);
    expect(refused.io.stderr).toMatch(/--yes/);
    expect(refused.io.stderr).not.toContain(m.text);
    expect(await h.store.get(TG, m.id)).not.toBeNull();

    const declined = await h.run(['forget', m.id], { tty: true, stdoutTTY: true, answer: 'n' });
    expect(declined.code).toBe(0);
    expect(declined.io.asked).toHaveLength(1);
    expect(await h.store.get(TG, m.id)).not.toBeNull();

    const yes = await h.run(['forget', m.id.slice(0, 8), '--yes']);
    expect(yes.code).toBe(0);
    expect(await h.store.get(TG, m.id)).toBeNull();
  });

  /** A (port 3000), superseded by B, which restates it: "changed from 3000 to 8080". */
  async function restated(h: ReturnType<typeof harness>): Promise<{ a: Memory; b: Memory }> {
    const a = memory({
      text: 'The dev server runs on port 3000.',
      stub: 'dev server port 3000',
      createdAt: '2026-10-01T00:00:00.000Z',
      expiredAt: '2026-10-02T00:00:00.000Z',
      validTo: '2026-10-02T00:00:00.000Z',
      endReason: 'superseded',
    });
    const b = memory({
      text: 'The dev server port changed from 3000 to 8080.',
      stub: 'dev server port 3000 to 8080',
      entities: ['dev server', '3000', '8080'],
      createdAt: '2026-10-02T00:00:00.000Z',
      supersedes: a.id,
      embedding: Int8Array.from([1, 2, 3, 4]),
    });
    await h.store.upsertMany(TG, [{ ...a, supersededBy: b.id }, b]);
    return { a, b };
  }

  it('cli.forget-rewrites-the-memory-that-restated-it (CON-144)', async () => {
    const h = harness();
    const { a, b } = await restated(h);
    const base = h.wire;
    h.wire = async (dir, o) => {
      const w = await base(dir, o);
      return {
        ...w,
        write: {
          ...fakeWriter,
          rewriteCurrent: async (m) => ({
            text: 'The dev server port is 8080.',
            stub: 'dev server port 8080',
            entities: m.entities.filter((e) => e !== '3000'),
            type: m.type,
          }),
        },
      };
    };
    const r = await h.run(['forget', a.id, '--yes']);
    expect(r.code).toBe(0);
    expect(r.io.stdout).toBe(
      `Forgot ${a.id}.\nRewrote ${b.id.slice(0, 8)} to its current fact: "The dev server port is 8080."\n`,
    );
    expect(await h.store.get(TG, a.id)).toBeNull();
    expect((await h.store.get(TG, b.id))?.supersedes).toBeNull();
    // Nothing a person can read back still says it: recall, list, export.
    const exported = await h.run(['export']);
    expect(exported.io.stdout).not.toContain('3000');
    expect(await h.store.lexical(TG, '3000', 10)).toEqual([]);

    const again = await restated(h);
    const json = await h.run(['forget', again.a.id, '--yes', '--json']);
    expect(data(json.io.stdout, 'forget')).toMatchObject({
      id: again.a.id,
      rewritten: [again.b.id],
      notRewritten: [],
    });
  });

  it('cli.forget-names-a-successor-it-could-not-rewrite-and-exits-3 (CON-144)', async () => {
    const h = harness();
    const { a, b } = await restated(h);
    // The harness writer has no rewriteCurrent, as an older writer would not.
    const r = await h.run(['forget', a.id, '--yes']);
    expect(r.code).toBe(3);
    expect(r.io.stdout).toContain(`Forgot ${a.id}.\n`);
    expect(r.io.stdout).toContain(
      `${b.id.slice(0, 8)} may still restate it, because no memory writer is set up (oort doctor says why). Check it with \`oort inspect ${b.id}\`, or forget it too: \`oort forget ${b.id}\`.`,
    );
    expect(await h.store.get(TG, a.id)).toBeNull();
    expect((await h.store.get(TG, b.id))?.text).toBe(b.text);

    const again = await restated(h);
    const json = await h.run(['forget', again.a.id, '--yes', '--json']);
    expect(json.code).toBe(3);
    const env = JSON.parse(json.io.stdout) as { data: unknown; warnings: { code: string }[] };
    expect(env.data).toMatchObject({ rewritten: [], notRewritten: [again.b.id] });
    expect(env.warnings.map((w) => w.code)).toContain('not-rewritten');
  });

  it('cli.forget-leaves-a-later-memory-that-restates-nothing-alone (CON-144)', async () => {
    const h = harness();
    const { a, b } = await restated(h);
    await h.store.upsert(TG, {
      ...b,
      text: 'The dev server port is 8080.',
      stub: 'dev server port 8080',
      entities: ['dev server', '8080'],
    });
    // No writer, and nothing to rewrite: a plain success, the chain re-linked.
    const r = await h.run(['forget', a.id, '--yes']);
    expect(r.code).toBe(0);
    expect(r.io.stdout).toBe(`Forgot ${a.id}.\n`);
    expect((await h.store.get(TG, b.id))?.supersedes).toBeNull();
  });

  it('cli.pin-unpin', async () => {
    const h = harness();
    const m = memory();
    await h.store.upsert(TG, m);
    expect((await h.run(['pin', m.id])).code).toBe(0);
    expect((await h.store.get(TG, m.id))?.pinned).toBe(true);
    expect((await h.run(['unpin', m.id])).code).toBe(0);
    expect((await h.store.get(TG, m.id))?.pinned).toBe(false);
  });

  it('cli.link-asserts-user-only-on-a-terminal-after-a-confirmation (CON-148)', async () => {
    const h = harness();
    const a = memory({ text: 'The cache is redis.' });
    const b = memory({ text: 'The queue is sqs.' });
    await h.store.upsertMany(TG, [a, b]);
    const by = async () => (await h.store.linksOf!(TG, a.id))?.links.map((l) => l.assertedBy);
    const term = { tty: true, stdoutTTY: true };
    // Declined on the terminal: nothing is written.
    const no = await h.run(['link', a.id, b.id], { ...term, terminal: 'n' });
    expect([no.code, no.io.asked.length]).toEqual([0, 1]);
    expect(await by()).toEqual([]);
    // Not a terminal: no question, asserted by agent.
    const piped = await h.run(['link', a.id, b.id]);
    expect([piped.code, piped.io.asked.length]).toEqual([0, 0]);
    expect(await by()).toEqual(['agent']);
    // A "y" on stdin is never the confirmation, and stdout must be a terminal too: a wrapper
    // that pipes an answer in, or captures the output, records agent.
    for (const o of [
      { tty: true, stdoutTTY: true, answer: 'y' },
      { tty: true, stdoutTTY: false, answer: 'y', terminal: 'y' },
      { tty: false, stdoutTTY: true, answer: 'y', terminal: 'y' },
    ]) {
      const r = await h.run(['link', a.id, b.id], o);
      expect([r.code, r.io.asked.length]).toEqual([0, 0]);
      expect(await by()).toEqual(['agent']);
    }
    // --json and --yes never ask, and never assert as a person.
    const j = await h.run(['link', a.id.slice(0, 8), b.id, '--json', '--yes'], {
      ...term,
      terminal: 'y',
    });
    expect(JSON.parse(j.io.stdout)).toMatchObject({
      ok: true,
      data: { from: a.id, to: b.id, linked: false, assertedBy: 'agent' },
    });
    expect(await by()).toEqual(['agent']);
    // Confirmed on the controlling terminal: recorded as user.
    const yes = await h.run(['link', a.id, b.id], { ...term, terminal: 'y' });
    expect([yes.code, yes.io.asked.length]).toEqual([0, 1]);
    expect(yes.io.stdout).toContain('Linked');
    expect(await by()).toEqual(['user']);
    // An agent (no terminal) cannot remove a link confirmed at a terminal.
    const kept = await h.run(['unlink', a.id, b.id, '--yes', '--json']);
    expect(kept.code).toBe(2);
    expect(JSON.parse(kept.io.stdout)).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(kept.io.stdout).toContain('confirmed at a terminal');
    expect(await by()).toEqual(['user']);
    // inspect lists the link and who asserted it.
    const shown = await h.run(['inspect', b.id, '--json']);
    expect(JSON.parse(shown.io.stdout).data).toMatchObject({
      links: [{ kind: 'explicit', id: a.id, assertedBy: 'user' }],
      hiddenLinks: 0,
    });
    expect((await h.run(['inspect', b.id])).io.stdout).toMatch(/links[\s\S]*explicit[\s\S]*user/);
    // unlink removes it; a second unlink blocks the pair.
    const un = await h.run(['unlink', a.id, b.id], { ...term, terminal: 'y' });
    expect(un.io.stdout).toContain('Unlinked');
    expect(await by()).toEqual([]);
    const again = await h.run(['unlink', a.id, b.id, '--yes', '--json']);
    expect(JSON.parse(again.io.stdout).data).toEqual({
      from: a.id,
      to: b.id,
      removed: false,
      blocked: true,
    });
    expect((await h.store.linksOf!(TG, a.id))?.blocked).toEqual([b.id]);
  });

  it('cli.link-refuses-a-pair-it-cannot-link-as-a-missing-id (CON-148)', async () => {
    const h = harness();
    const a = memory({ text: 'The cache is redis.' });
    await h.store.upsert(TG, a);
    const missing = await h.run(['link', a.id, 'ffffffff-0000-4000-8000-000000000000', '--yes']);
    const self = await h.run(['link', a.id, a.id, '--yes']);
    expect([missing.code, self.code]).toEqual([2, 2]);
    // A pair that cannot be linked is refused without naming either id.
    expect(self.io.stderr).toContain('No such pair of memories');
    expect(self.io.stderr).not.toContain(a.id.slice(0, 8));
    expect(missing.io.stderr).toContain('No such memory');
    expect((await h.store.linksOf!(TG, a.id))?.links).toEqual([]);
  });

  it('cli.consolidate-prints-skipped', async () => {
    const h = harness();
    await h.store.upsert(TG, memory({ validTo: '2026-10-02T00:00:00.000Z' }));
    const r = await h.run(['consolidate']);
    expect(r.code).toBe(0);
    // Updated deliberately for the ui module: one header line, then aligned rows.
    expect(r.io.stdout).toBe(
      'oort consolidate · global\npromoted  0\ndemoted   1\nevicted   1\nexpired   1\nskipped   0\n',
    );
  });

  it('cli.consolidate-covers-every-project-and-is-recorded (CON-48)', async () => {
    const h = harness();
    // A memory of another project: consolidated too, ranked within its own project.
    const other = memory({
      scope: { ...localScope('elsewhere'), agentId: 'claude-code' },
      validTo: '2026-10-02T00:00:00.000Z',
    });
    await h.store.upsert(TG, other);
    expect((await h.run(['consolidate'])).code).toBe(0);
    expect((await h.store.get(TG, other.id))?.tier).toBe('cold');
    const s = data((await h.run(['stats', '--json'])).io.stdout) as {
      consolidation: Record<string, unknown>;
    };
    expect(s.consolidation).toMatchObject({ lastOutcome: 'complete', due: false });
    expect(s.consolidation['nextAt']).toEqual(expect.any(String));
    // Recorded where the drain looks: the drain does not run it again today.
    await h.run(['hook', 'drain']);
    const log = readLines(path.join(h.home, 'logs', 'hooks.log'));
    expect(log.map((l) => l['event'])).not.toContain('consolidate');
  });

  it('cli.hook-drain-consolidates-when-due (CON-48)', async () => {
    const h = harness();
    const gone = memory({ validTo: '2026-10-02T00:00:00.000Z' });
    await h.store.upsert(TG, gone);
    const before = data((await h.run(['stats', '--json'])).io.stdout) as {
      consolidation: Record<string, unknown>;
    };
    expect(before.consolidation).toMatchObject({ lastRunAt: null, due: true });
    const r = await h.run(['hook', 'drain']);
    expect(r.code).toBe(0);
    expect((await h.store.get(TG, gone.id))?.tier).toBe('cold');
    const log = readLines(path.join(h.home, 'logs', 'hooks.log'));
    expect(log.find((l) => l['event'] === 'consolidate')).toMatchObject({
      outcome: 'ok',
      counts: { expired: 1, evicted: 1 },
    });
    const text = (await h.run(['stats'])).io.stdout;
    expect(text).toMatch(/consolidated +\d{4}-\d\d-\d\d \d\d:\d\d \(\d+\w+ ago\)/);
  });
});

describe('oort hook (in process)', () => {
  const prompt = (cwd: string): string =>
    JSON.stringify({
      session_id: 's-1',
      cwd,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'which port does the auth service use?',
    });

  it('cli.hook-injects-recall', async () => {
    const h = harness();
    await h.store.upsert(TG, memory());
    const r = await h.run(['hook', 'UserPromptSubmit'], { stdin: prompt(h.cwd) });
    expect(r.code).toBe(0);
    expect(r.io.hookExits).toBe(1);
    expect(r.io.stdout).toBe('');
    const out = JSON.parse(r.io.hookStdout ?? '') as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(out.hookSpecificOutput.additionalContext).toContain('port 5582');
  });

  it('cli.hook-log-records-wiring-time', async () => {
    const h = harness();
    await h.store.upsert(TG, memory());
    await h.run(['hook', 'UserPromptSubmit'], { stdin: prompt(h.cwd) });
    const [line] = readLines(path.join(h.home, 'logs', 'hooks.log'));
    // Wiring reads the config and the keys (the keychain), so a slow keychain shows here.
    expect(typeof (line?.['timings'] as Record<string, unknown>)['wireMs']).toBe('number');
  });

  it('cli.hook-exit-zero-when-wire-throws', async () => {
    const h = harness();
    h.wire = async () => {
      throw new Error('store will not open');
    };
    const r = await h.run(['hook', 'UserPromptSubmit'], { stdin: prompt(h.cwd) });
    expect(r.code).toBe(0);
    expect(r.io.hookExits).toBe(1);
    expect(r.io.hookStdout).toBe('');
    expect(r.io.stdout + r.io.stderr).toBe('');
    const log = readLines(path.join(h.home, 'logs', 'hooks.log'));
    expect(log.map((l) => l['outcome'])).toEqual(['cli-error']);
  });

  it('cli.hooks-never-migrate-and-fail-open', async () => {
    const h = harness();
    const seen: (boolean | undefined)[] = [];
    const inner = h.wire;
    h.wire = async (cwd, o) => {
      seen.push(o?.migrate);
      return inner(cwd, o);
    };
    await h.run(['hook', 'UserPromptSubmit'], { stdin: prompt(h.cwd) });
    await h.run(['hook', 'SessionStart'], {
      stdin: JSON.stringify({ session_id: 's', cwd: h.cwd }),
    });
    await h.run(['hook', 'Stop'], { stdin: '{}' });
    await h.run(['hook', 'drain']);
    await h.run(['recall', 'port']);
    expect(seen).toEqual([false, false, false, false, undefined]);

    // A store that still needs its migration: no recall, exit 0, one short note.
    h.wire = async () => {
      throw new StoreMigrationRequiredError('/x/oort.sqlite', 1);
    };
    const r = await h.run(['hook', 'UserPromptSubmit'], { stdin: prompt(h.cwd) });
    expect(r.code).toBe(0);
    expect(r.io.hookExits).toBe(1);
    expect(r.io.hookStdout).toBe('');
    expect(r.io.stderr).toBe(MIGRATION_PENDING_NOTE);
    const log = readLines(path.join(h.home, 'logs', 'hooks.log'));
    expect(log.at(-1)?.['outcome']).toBe('degraded:migration-pending');
  });

  it('cli.hook-stop-spawns-drain', async () => {
    const h = harness();
    const transcript = writeTranscript(path.join(h.root, 'projects'), h.cwd);
    const r = await h.run(['hook', 'Stop'], {
      stdin: JSON.stringify({
        session_id: 's-2',
        cwd: h.cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    });
    expect(r.code).toBe(0);
    expect(r.io.hookStdout).toBe('');
    expect(r.io.spawned).toBe(1);
    // The drain runs in OORT_HOME, so only the home config shapes the write path.
    expect(r.io.spawnCwds).toEqual([h.home]);
  });

  it('cli.hook-store-busy-timeout', async () => {
    const h = harness();
    const seen: (number | undefined)[] = [];
    const inner = h.wire;
    h.wire = async (cwd, o) => {
      seen.push(o?.busyTimeoutMs);
      return inner(cwd, o);
    };
    await h.run(['hook', 'UserPromptSubmit'], { stdin: prompt(h.cwd) });
    await h.run(['hook', 'SessionStart'], {
      stdin: JSON.stringify({ session_id: 's', cwd: h.cwd }),
    });
    await h.run(['hook', 'Stop'], { stdin: '{}' });
    await h.run(['hook', 'drain']);
    await h.run(['recall', 'port']);
    // Hooks wait at most 250 ms for the lock; the detached drain and commands keep the default.
    expect(seen).toEqual([250, 250, 250, undefined, undefined]);
  });

  it('cli.in-process-hooks-load-no-large-rabitq-engine (CON-25)', async () => {
    const h = harness();
    const seen: (number | undefined)[] = [];
    const inner = h.wire;
    h.wire = async (cwd, o) => {
      seen.push(o?.rabitqMaxLoad);
      return inner(cwd, o);
    };
    await h.run(['hook', 'UserPromptSubmit'], { stdin: prompt(h.cwd) });
    await h.run(['hook', 'drain']);
    await h.run(['recall', 'port']);
    // Every in-process hook (the drain too) caps the engine it loads; commands do not.
    expect(seen).toEqual([HOOK_RABITQ_MAX_LOAD, HOOK_RABITQ_MAX_LOAD, undefined]);
  });

  it('cli.mcp-finishes-at-most-two-rabitq-build-batches-before-serving (CON-25)', async () => {
    const h = harness();
    const seen: (number | undefined)[] = [];
    const inner = h.wire;
    h.wire = async (cwd, o) => {
      seen.push(o?.rabitqBuildBatches);
      if (seen.length === 1) throw new Error('stop before serving');
      return inner(cwd, o);
    };
    await h.run(['mcp']);
    await h.run(['recall', 'port']);
    // The MCP server leaves the rest of a stopped build to the CLI; commands finish it.
    expect(HOST_RABITQ_BUILD_BATCHES).toBe(2);
    expect(seen).toEqual([HOST_RABITQ_BUILD_BATCHES, undefined]);
  });

  it('cli.hook-busy-store-logs-degraded', async () => {
    const busy = (): Error =>
      Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const logOf = (home: string) => readLines(path.join(home, 'logs', 'hooks.log'));

    // The open itself hit the lock.
    const a = harness();
    a.wire = async () => {
      throw busy();
    };
    const opened = await a.run(['hook', 'UserPromptSubmit'], { stdin: prompt(a.cwd) });
    expect(opened.code).toBe(0);
    expect(opened.io.hookStdout).toBe('');
    expect(logOf(a.home)).toEqual([
      expect.objectContaining({
        event: 'UserPromptSubmit',
        outcome: 'degraded:busy',
        degraded: ['busy'],
      }),
    ]);

    // A write inside the handler hit the lock: no context is injected.
    const b = harness();
    await b.store.upsert(TG, memory());
    const inner = b.wire;
    b.wire = async (cwd, o) => {
      const w = await inner(cwd, o);
      return {
        ...w,
        store: {
          ...w.store,
          recordAccess: async () => {
            throw busy();
          },
        },
      };
    };
    const during = await b.run(['hook', 'UserPromptSubmit'], { stdin: prompt(b.cwd) });
    expect(during.code).toBe(0);
    expect(during.io.hookStdout).toBe('');
    expect(logOf(b.home).map((l) => l['outcome'])).toContain('degraded:busy');
  });

  it('cli.hook-slow-adapters-in-process', async () => {
    const h = harness();
    await h.store.upsert(TG, memory());
    const never: Embedder = { dimension: 4, embed: () => new Promise(() => {}) };
    const inner = h.wire;
    h.wire = async (cwd, o) => ({ ...(await inner(cwd, o)), embed: never });
    const t0 = performance.now();
    const r = await h.run(['hook', 'UserPromptSubmit'], { stdin: prompt(h.cwd) });
    expect(performance.now() - t0).toBeLessThan(3500);
    expect(r.io.hookExits).toBe(1);
    // The lexical fallback still answers.
    expect(r.io.hookStdout).toContain('port 5582');
  });
});

describe('oort import (in process)', () => {
  it('cli.import-runs-with-yes', async () => {
    const h = harness();
    const projects = path.join(h.root, 'projects');
    writeTranscript(projects, h.cwd);
    const est = await h.run([
      'import',
      'claude-code',
      '--projects-dir',
      projects,
      '--include-unresolved',
      '--estimate-only',
    ]);
    expect(est.code).toBe(0);
    expect(est.io.stdout).toMatch(/observations\s+[1-9]/);
    expect(
      await h.store.list(
        localGrant({
          orgId: 'local',
          customerId: 'self',
          agentId: 'claude-code',
          projectIds: [null],
        }),
      ),
    ).toEqual([]);

    const run = await h.run([
      'import',
      'claude-code',
      '--projects-dir',
      projects,
      '--include-unresolved',
      '--yes',
    ]);
    expect(run.code).toBe(0);
    expect(run.io.stdout).toMatch(/added [1-9]/);
    expect(
      (
        await h.store.list(
          localGrant({
            orgId: 'local',
            customerId: 'self',
            agentId: 'claude-code',
            projectIds: [null],
          }),
        )
      ).length,
    ).toBeGreaterThan(0);

    expect((await h.run(['import', 'claude-code', '--since', 'soon'])).code).toBe(2);
  });
});

describe('wire', () => {
  it('cli.drain-ignores-project-config', async () => {
    // The drain wires with projectConfig: false; every other run keeps discovery.
    const h = harness();
    const seen: (boolean | undefined)[] = [];
    const inner = h.wire;
    h.wire = async (cwd, o) => {
      seen.push(o?.projectConfig);
      return inner(cwd, o);
    };
    await h.run(['hook', 'drain']);
    await h.run(['hook', 'SessionStart'], {
      stdin: JSON.stringify({ session_id: 's', cwd: h.cwd }),
    });
    await h.run(['stats']);
    expect(seen).toEqual([false, undefined, undefined]);

    // The real wire then never reads an oort.config.json at or above OORT_HOME.
    const root = tmpdir();
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(
      path.join(root, 'oort.config.json'),
      JSON.stringify({ writer: { provider: 'anthropic', model: 'project-model' } }),
    );
    const home = path.join(root, '.oort');
    const env = { HOME: root, OORT_HOME: home };
    const discovered = await wire(path.join(root), { env });
    await discovered.close();
    expect(discovered.config.writer.model).toBe('project-model');
    const drain = await wire(home, { env, projectConfig: false });
    await drain.close();
    expect(drain.config.writer.model).toBe('claude-haiku-5-5');
    expect(drain.config.sources['writer']).toBe('default');
  });

  it('cli.project-link-unlink', async () => {
    const root = tmpdir();
    const home = path.join(root, 'oort-home');
    const env = { HOME: root, OORT_HOME: home };
    const main = path.join(root, 'main');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const worktree = path.join(root, 'wt');
    fs.mkdirSync(worktree);
    fs.writeFileSync(
      path.join(worktree, '.git'),
      `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`,
    );
    fs.writeFileSync(
      path.join(main, '.git', 'worktrees', 'wt', 'gitdir'),
      `${path.join(worktree, '.git')}\n`,
    );
    fs.writeFileSync(
      path.join(main, 'oort.config.json'),
      JSON.stringify({ project: { id: 'one' } }),
    );
    const run = async (cwd: string, args: string[]) => {
      const io = fakeIo({ cwd, env });
      return { code: await runCli(args, io, wire), io };
    };
    const scopeOf = async (cwd: string): Promise<string | undefined> => {
      const w = await wire(cwd, { env });
      await w.close();
      return w.scope.projectId;
    };

    // Unlinked: the worktree shares the main checkout's derived id, the file's id is ignored.
    const derived = await scopeOf(main);
    expect(derived).toMatch(/^main-[0-9a-f]{8}$/);
    expect(await scopeOf(worktree)).toBe(derived);
    const stats = await run(main, ['stats']);
    expect(stats.code).toBe(0);
    expect(stats.io.stderr.match(/oort project link/g)).toHaveLength(1);
    // Hooks stay silent on stderr and log the code.
    const hookIo = fakeIo({
      cwd: main,
      env,
      stdin: JSON.stringify({ session_id: 's', cwd: main }),
    });
    expect(await runCli(['hook', 'SessionStart'], hookIo, wire)).toBe(0);
    expect(hookIo.stderr).toBe('');
    const log = readLines(path.join(home, 'logs', 'hooks.log'));
    expect(log.map((l) => l['outcome'])).toContain('config:project-id-untrusted');

    // link binds the configured id; it holds in every worktree.
    const linked = await run(main, ['project', 'link']);
    expect(linked.code).toBe(0);
    expect(linked.io.stdout).toBe(`Linked ${main} to project "cfg:one"\n`);
    expect(await scopeOf(main)).toBe('cfg:one');
    expect(await scopeOf(worktree)).toBe('cfg:one');
    expect((await run(main, ['stats'])).io.stderr).not.toContain('oort project link');
    const file = path.join(home, 'project-links.json');
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    // --id overrides, from a worktree too (the binding is on the main root).
    expect((await run(worktree, ['project', 'link', '--id', 'two'])).code).toBe(0);
    expect(await scopeOf(main)).toBe('cfg:two');

    const unlinked = await run(worktree, ['project', 'unlink']);
    expect(unlinked.io.stdout).toBe(`Unlinked ${main}\n`);
    expect(await scopeOf(main)).toBe(derived);
    expect((await run(main, ['project', 'unlink'])).io.stdout).toBe(`No link for ${main}\n`);

    // Refusals: outside a repository, and with nothing to bind.
    const loose = path.join(root, 'loose');
    fs.mkdirSync(loose);
    expect((await run(loose, ['project', 'link', '--id', 'x'])).code).toBe(2);
    fs.writeFileSync(path.join(main, 'oort.config.json'), JSON.stringify({ project: {} }));
    const none = await run(main, ['project', 'link']);
    expect(none.code).toBe(2);
    expect(none.io.stderr).toContain('pass --id');
  });

  it('cli.project-link-guards-repo-supplied-id', async () => {
    const root = tmpdir();
    const env = { HOME: root, OORT_HOME: path.join(root, 'oort-home') };
    const run = async (cwd: string, args: string[]) => {
      const io = fakeIo({ cwd, env });
      return { code: await runCli(args, io, wire), io };
    };
    const repoWith = (name: string): string => {
      const dir = path.join(root, name);
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'oort.config.json'),
        JSON.stringify({ project: { id: 'private-payments' } }),
      );
      return dir;
    };
    const mine = repoWith('mine');
    expect((await run(mine, ['project', 'link'])).code).toBe(0);
    // Relinking the same repository is fine.
    expect((await run(mine, ['project', 'link'])).code).toBe(0);

    // A cloned repository naming the same id cannot join that scope silently.
    const cloned = repoWith('cloned');
    const refused = await run(cloned, ['project', 'link']);
    expect(refused.code).toBe(2);
    expect(refused.io.stderr).toContain(mine);
    expect(refused.io.stderr).toContain('--id');
    const links = JSON.parse(
      fs.readFileSync(path.join(env.OORT_HOME, 'project-links.json'), 'utf8'),
    ) as { links: Record<string, string> };
    expect(Object.keys(links.links)).toEqual([mine]);

    // The user's explicit --id is always accepted.
    const explicit = await run(cloned, ['project', 'link', '--id', 'private-payments']);
    expect(explicit.code).toBe(0);
    expect(explicit.io.stdout).toBe(`Linked ${cloned} to project "cfg:private-payments"\n`);
  });

  it('cli.wire-ignores-project-embed-dimension', async () => {
    const root = tmpdir();
    const home = path.join(root, 'oort-home');
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    fs.writeFileSync(
      path.join(cwd, 'oort.config.json'),
      JSON.stringify({
        embed: { provider: 'voyage', model: 'voyage-3.5-lite', dimension: 256, dtype: 'int8' },
      }),
    );
    const env = { HOME: root, OORT_HOME: home };
    const w = await wire(cwd, { env });
    try {
      expect(w.config.embed.dimension).toBe(512);
      expect(w.warnings.map((x) => x.code)).toEqual(['embed-dimension-ignored']);
      await w.store.upsert(TG, memory({ embedding: new Int8Array(512) }));
    } finally {
      await w.close();
    }

    // Commands warn once on stderr; hooks log one line instead.
    const cmd = fakeIo({ cwd, env });
    expect(await runCli(['stats'], cmd, wire)).toBe(0);
    expect(cmd.stderr.match(/embed\.dimension 256 ignored/g)).toHaveLength(1);
    const hook = fakeIo({ cwd, env, stdin: JSON.stringify({ session_id: 's', cwd }) });
    expect(await runCli(['hook', 'SessionStart'], hook, wire)).toBe(0);
    expect(hook.stderr).toBe('');
    const log = readLines(path.join(home, 'logs', 'hooks.log'));
    expect(log.map((l) => l['outcome'])).toContain('config:embed-dimension-ignored');
  });
});

describe('oort usage', () => {
  it('cli.workspace-name-unique', () => {
    // Published as `oortmem` (`oort` is taken on npm). `pnpm --filter oortmem` must select the
    // CLI only, so no other workspace package may be named oortmem.
    const repo = path.join(import.meta.dirname, '..', '..', '..');
    const name = (dir: string): unknown =>
      (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown })
        .name;
    expect(name(repo)).toBe('oort-workspace');
    const packages = fs
      .readdirSync(path.join(repo, 'packages'))
      .map((d) => path.join(repo, 'packages', d));
    const named = packages.filter(
      (d) => fs.existsSync(path.join(d, 'package.json')) && name(d) === 'oortmem',
    );
    expect(named).toEqual([path.join(repo, 'packages', 'cli')]);
  });

  it('cli.bins-oort-and-oortmem-run-the-same-file', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { bin?: Record<string, string> };
    expect(pkg.bin).toEqual({ oort: 'dist/main.js', oortmem: 'dist/main.js' });
  });

  it('cli.engines-require-zstd-node', () => {
    // node:zlib zstd (cold blobs) arrived in 22.15.0; older 22.x throws on the first eviction.
    const repo = path.join(import.meta.dirname, '..', '..', '..');
    const dirs = [
      repo,
      ...fs
        .readdirSync(path.join(repo, 'packages'))
        .map((d) => path.join(repo, 'packages', d))
        .filter((d) => fs.existsSync(path.join(d, 'package.json'))),
    ];
    expect(dirs.length).toBeGreaterThan(5);
    for (const dir of dirs) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        engines?: { node?: string };
      };
      expect(`${path.basename(dir)} ${pkg.engines?.node}`).toBe(`${path.basename(dir)} >=22.15.0`);
    }
  });

  it('cli.usage-errors-exit-2', async () => {
    const h = harness();
    expect((await h.run(['no-such-command'])).code).toBe(2);
    expect((await h.run(['recall'])).code).toBe(2);
    expect((await h.run(['recall', 'x', '--as-of', 'yesterday'])).code).toBe(2);
    expect((await h.run(['--help'])).code).toBe(0);
  });

  it('cli.unexpected-error-exit-1-stack-only-with-debug', async () => {
    const h = harness();
    h.wire = async () => {
      throw new Error('disk on fire');
    };
    const plain = await h.run(['stats']);
    expect(plain.code).toBe(1);
    expect(plain.io.stderr).toBe('oort: disk on fire\n');
    const debug = await h.run(['--debug', 'stats']);
    expect(debug.code).toBe(1);
    expect(debug.io.stderr).toMatch(/disk on fire\n.*at /s);
  });
});

describe('wire keychain', () => {
  const key = (): string => ['sk', 'test', String(Date.now())].join('-');
  const setup = (): { env: Record<string, string> } => {
    const root = tmpdir();
    return { env: { OORT_HOME: path.join(root, 'home'), HOME: root } };
  };

  it('wire.env-wins-over-keychain', async () => {
    const { env } = setup();
    const reads: string[] = [];
    const w = await realWire(tmpdir(), {
      env: { ...env, VOYAGE_API_KEY: key() },
      keychain: async (p) => {
        reads.push(p);
        return key();
      },
    });
    expect(w.embed).toBeDefined();
    expect(reads).not.toContain('voyage');
    await w.close();
  });

  it('wire.keychain-used-when-env-missing-or-empty-and-read-once', async () => {
    for (const empty of [undefined, '']) {
      const { env } = setup();
      const reads: string[] = [];
      const w = await realWire(tmpdir(), {
        env: { ...env, ...(empty !== undefined && { VOYAGE_API_KEY: empty }) },
        keychain: async (p) => {
          reads.push(p);
          return p === 'voyage' ? key() : undefined;
        },
      });
      expect(w.embed).toBeDefined();
      expect(w.rerank).toBeDefined();
      expect(w.decide).toBeUndefined();
      expect(reads.filter((p) => p === 'voyage')).toHaveLength(1);
      await w.close();
    }
  });

  it('wire.missing-everywhere-names-oort-keys-set', async () => {
    const { env } = setup();
    const w = await realWire(tmpdir(), { env, keychain: async () => undefined });
    expect(w.embed).toBeUndefined();
    expect(w.unavailable.embed?.message).toContain('oort keys set voyage');
    expect(w.unavailable.write?.message).toContain('oort keys set anthropic');
    await w.close();
  });
});

describe('temporal recall (CON-34)', () => {
  const chain = () => {
    const v1 = memory({
      id: 'v1',
      text: 'The auth service listens on port 5582.',
      createdAt: '2026-03-01T00:00:00.000Z',
      validTo: '2026-05-01T00:00:00.000Z',
      expiredAt: '2026-05-01T00:00:00.000Z',
      endReason: 'superseded',
      supersededBy: 'v2',
    });
    const v2 = memory({
      id: 'v2',
      text: 'The auth service listens on port 6000.',
      createdAt: '2026-05-01T00:00:00.000Z',
      supersedes: 'v1',
    });
    return [v1, v2];
  };
  const ids = (stdout: string) =>
    (data(stdout) as { memories: { id: string }[] }).memories.map((m) => m.id);

  it('cli.recall-mode-flags', async () => {
    const h = harness({ adapters: false });
    await h.store.upsertMany(TG, chain());
    const q = 'auth service port';
    const now = await h.run(['recall', q, '--json']);
    expect(ids(now.io.stdout)).toEqual(['v2']);
    expect(data(now.io.stdout).temporal).toEqual({ mode: 'current', inferred: true });
    expect(ids((await h.run(['recall', q, '--json', '--history'])).io.stdout)).toEqual([
      'v1',
      'v2',
    ]);
    expect(ids((await h.run(['recall', q, '--json', '--as-of', '2026-04-01'])).io.stdout)).toEqual([
      'v1',
    ]);
    const knownAt = await h.run(['recall', q, '--json', '--known-at', '2026-04-01']);
    expect(ids(knownAt.io.stdout)).toEqual(['v1']);
    expect(data(knownAt.io.stdout).temporal).toMatchObject({ mode: 'known-at' });
    // One view at a time; a bad date is refused without echoing it.
    expect((await h.run(['recall', q, '--history', '--as-of', '2026-04-01'])).code).toBe(2);
    const bad = await h.run(['recall', q, '--known-at', 'someday']);
    expect(bad.code).toBe(2);
    expect(bad.io.stderr).not.toContain('someday');
  });

  it('cli.explain-shows-the-mode', async () => {
    const h = harness({ adapters: false });
    await h.store.upsertMany(TG, chain());
    const plain = await h.run(['explain', 'auth service port']);
    expect(plain.io.stdout).toContain('mode: current (from the query)');
    const history = await h.run(['explain', 'auth service port', '--history']);
    expect(history.io.stdout).toContain('mode: history');
    const json = await h.run(['explain', 'auth service port', '--json', '--as-of', '2026-04-01']);
    expect(data(json.io.stdout).temporal).toMatchObject({ mode: 'as-of', inferred: false });
  });

  it('cli.revalidate-lists-stale-volatile-facts', async () => {
    const h = harness({ adapters: false });
    const volatile = { stage: 'gate', question: 'volatile', answer: 'yes', probability: 0.8 };
    await h.store.upsertMany(TG, [
      memory({
        id: 'stale',
        text: 'Release 1.3 is blocked on the auth migration.',
        source: { harness: 'claude-code', decisions: [volatile] },
      }),
      memory({ id: 'stable', text: 'The repo uses pnpm workspaces.' }),
      memory({
        id: 'gone',
        text: 'Release 1.2 is blocked on CI.',
        expiredAt: '2026-10-02T00:00:00.000Z',
        endReason: 'superseded',
        source: { harness: 'claude-code', decisions: [volatile] },
      }),
    ]);
    const json = await h.run(['revalidate', '--json']);
    expect(json.code).toBe(0);
    const rows = data<{ memories: { id: string; lastConfirmed: string }[] }>(
      json.io.stdout,
      'revalidate',
    ).memories;
    expect(rows.map((r) => r.id)).toEqual(['stale']);
    expect(rows[0]?.lastConfirmed).toBe('2026-10-01T00:00:00.000Z');
    const text = await h.run(['revalidate']);
    expect(text.io.stdout).toContain('Release 1.3 is blocked');
    expect(text.io.stdout).not.toContain('pnpm workspaces');
  });
});
