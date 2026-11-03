import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { localScope, type Embedder, type Memory } from '@oortmem/core';
import { AWS_KEY, fakeIo, harness, memory, tmpdir, writeTranscript } from '../test/helpers.js';
import { runCli } from './program.js';
import { wire } from './wire.js';

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
    for (const v of ['VOYAGE_API_KEY', 'TYPESAFE_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect(r.io.stderr).toContain(`export ${v}=`);
    }
    expect(r.io.stdout).toBe('');
    expect(
      await h.store.list(
        { orgId: 'local', customerId: 'self', agentId: 'claude-code', projectIds: [null] },
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
    await h.store.upsertMany([
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
    // Each link's validity window.
    expect(chain).toMatch(
      new RegExp(
        `${a.id.slice(0, 8)}\\s+2026-09-01T00:00:00.000Z\\s+2026-09-10T00:00:00.000Z\\s+superseded`,
      ),
    );
    expect(chain).toMatch(new RegExp(`${c.id.slice(0, 8)}\\s+2026-09-20T00:00:00.000Z\\s+open`));

    const json = await h.run(['inspect', b.id, '--json']);
    const parsed = JSON.parse(json.io.stdout) as {
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
    expect(list.io.stdout.split('\n')[0]).toMatch(/^id\s+type\s+tier\s+activation\s+age\s+text$/);

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
    await h.store.upsertMany([
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
    const parsed = JSON.parse(json.io.stdout) as { chain: { id: string }[]; hiddenLinks: number };
    expect(parsed.chain.map((l) => l.id)).toEqual([g.id]);
    expect(parsed.hiddenLinks).toBe(1);
    // The shown record's own supersededBy still names the id; nothing of its content leaks.
    expect(json.io.stdout).not.toContain('project-only');
  });

  it('cli.pin-forget-refuse-out-of-scope-id', async () => {
    const h = harness();
    const p = memory({ text: 'another project fact', scope: elsewhere });
    await h.store.upsert(p);
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
    expect(await h.store.get(p.id)).toEqual(p);
  });
});

describe('oort stats', () => {
  it('cli.stats-reports-tiers', async () => {
    const h = harness();
    const cold = memory({ text: 'cold fact' });
    await h.store.upsertMany([
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
    await h.store.coldPut(cold);
    fs.mkdirSync(path.join(h.home, 'queue', 'dead'), { recursive: true });
    fs.writeFileSync(path.join(h.home, 'queue', 's1.jsonl'), '{"a":1}\n{"a":2}\n');
    fs.writeFileSync(path.join(h.home, 'queue', 'dead', 's1.jsonl'), '{"a":3}\n');
    fs.mkdirSync(path.join(h.home, 'cold', 'ab'), { recursive: true });
    fs.writeFileSync(path.join(h.home, 'cold', 'ab', 'blob'), Buffer.alloc(1000));

    const r = await h.run(['stats', '--json']);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.io.stdout) as Record<string, unknown>;
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

/** The v1 export format as documented in docs/export-format.md. */
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
    await h.store.upsertMany([warm, cold, noEmbedding, elsewhere]);
    await h.store.coldPut(cold);
    expect((await h.store.get(cold.id))?.embedding).toBeUndefined();

    fs.mkdirSync(h.home, { recursive: true });
    const file = path.join(h.home, 'export.jsonl');
    const r = await h.run(['export', '--out', file]);
    expect(r.code).toBe(0);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const [head, ...rest] = readLines(file);
    const manifest = ManifestSchema.parse(head);
    expect(manifest.memories).toBe(3);
    expect(manifest.scopes).toEqual([
      { orgId: 'local', customerId: 'self', agentId: 'claude-code' },
    ]);
    const lines = rest.map((l) => MemoryLineSchema.parse(l));
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
  });
});

describe('oort export --out', () => {
  it('cli.export-out-refuses-existing-and-symlinks', async () => {
    const h = harness();
    await h.store.upsert(memory());
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
    await h.store.upsert(m);

    const refused = await h.run(['forget', m.id]);
    expect(refused.code).toBe(2);
    expect(refused.io.stderr).toMatch(/--yes/);
    expect(refused.io.stderr).not.toContain(m.text);
    expect(await h.store.get(m.id)).not.toBeNull();

    const declined = await h.run(['forget', m.id], { tty: true, answer: 'n' });
    expect(declined.code).toBe(0);
    expect(declined.io.asked).toHaveLength(1);
    expect(await h.store.get(m.id)).not.toBeNull();

    const yes = await h.run(['forget', m.id.slice(0, 8), '--yes']);
    expect(yes.code).toBe(0);
    expect(await h.store.get(m.id)).toBeNull();
  });

  it('cli.pin-unpin', async () => {
    const h = harness();
    const m = memory();
    await h.store.upsert(m);
    expect((await h.run(['pin', m.id])).code).toBe(0);
    expect((await h.store.get(m.id))?.pinned).toBe(true);
    expect((await h.run(['unpin', m.id])).code).toBe(0);
    expect((await h.store.get(m.id))?.pinned).toBe(false);
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
    await h.store.upsert(memory());
    const r = await h.run(['hook', 'UserPromptSubmit'], { stdin: prompt(h.cwd) });
    expect(r.code).toBe(0);
    expect(r.io.hookExits).toBe(1);
    expect(r.io.stdout).toBe('');
    const out = JSON.parse(r.io.hookStdout ?? '') as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(out.hookSpecificOutput.additionalContext).toContain('port 5582');
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
    await b.store.upsert(memory());
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
    await h.store.upsert(memory());
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
      await h.store.list({
        orgId: 'local',
        customerId: 'self',
        agentId: 'claude-code',
        projectIds: [null],
      }),
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
        await h.store.list({
          orgId: 'local',
          customerId: 'self',
          agentId: 'claude-code',
          projectIds: [null],
        })
      ).length,
    ).toBeGreaterThan(0);

    expect((await h.run(['import', 'claude-code', '--since', 'soon'])).code).toBe(2);
  });
});

describe('wire', () => {
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
      await w.store.upsert(memory({ embedding: new Int8Array(512) }));
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
    // `pnpm --filter oort` must select the CLI only, so no other workspace package may be named oort.
    const repo = path.join(import.meta.dirname, '..', '..', '..');
    const name = (dir: string): unknown =>
      (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown })
        .name;
    expect(name(repo)).toBe('oort-workspace');
    const packages = fs
      .readdirSync(path.join(repo, 'packages'))
      .map((d) => path.join(repo, 'packages', d));
    const named = packages.filter(
      (d) => fs.existsSync(path.join(d, 'package.json')) && name(d) === 'oort',
    );
    expect(named).toEqual([path.join(repo, 'packages', 'cli')]);
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
