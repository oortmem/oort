import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addressed, localGrant, localScope, readAgents, setAgentStar } from '@oortmem/core';
import { nodesGrant } from '@oortmem/core/store-conformance';
import { cloudBackend } from './mcp.js';
import { fakeCloud, fakeMemory, type FakeCloud } from '../test/fake-cloud.js';
import {
  PIPED,
  expectDeclined,
  expectRefusedWithoutPrompt,
  fakeIo,
  memory,
  tmpdir,
  writeTranscript,
} from '../test/helpers.js';
import CONTRACT from '../test/cloud-contract.json' with { type: 'json' };
import {
  DEFAULT_CLOUD_URL,
  OortCloudError,
  cloudErrorKind,
  cloudUrl,
  createCloudClient,
  readCloudSettings,
  writeCloudSettings,
} from './cloud.js';
import { uploadChunk } from './commands/cloud.js';
import { createKeychain } from './keychain.js';
import { runCli } from './program.js';
import { wire as realWire, type WireFn } from './wire.js';

/** Assembled at runtime so no key literal sits in a source file. */
const oortKey = (): string => ['oort', 'sk', `cloud${Date.now()}`.padEnd(43, 'C')].join('_');

interface Env {
  root: string;
  home: string;
  cwd: string;
  cloud: FakeCloud;
  key: string;
  run(
    args: string[],
    opts?: {
      stdin?: string;
      withKey?: boolean;
      tty?: boolean;
      stdoutTTY?: boolean;
      answer?: string;
    },
  ): Promise<{ code: number; io: ReturnType<typeof fakeIo> }>;
}

function setup(mode: 'local' | 'cloud'): Env {
  const root = tmpdir();
  const home = path.join(root, 'oort-home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const key = oortKey();
  const cloud = fakeCloud(key);
  if (mode === 'cloud') writeCloudSettings(home, { store: 'cloud' });
  const wire: WireFn = (dir, o = {}) =>
    realWire(dir, { ...o, keychain: async () => undefined, fetch: cloud.fetch });
  return {
    root,
    home,
    cwd,
    cloud,
    key,
    async run(args, opts = {}) {
      const withKey = opts.withKey ?? mode === 'cloud';
      const io = fakeIo({
        cwd,
        env: {
          HOME: root,
          OORT_HOME: home,
          OORT_NO_KEYCHAIN: '1',
          ...(withKey && { OORT_API_KEY: key }),
        },
        ...(opts.stdin !== undefined && { stdin: opts.stdin }),
        ...(opts.tty !== undefined && { tty: opts.tty, stdoutTTY: opts.stdoutTTY ?? opts.tty }),
        ...(opts.answer !== undefined && { answer: opts.answer }),
      });
      const code = await runCli(args, io, wire, createKeychain({ platform: 'none' }), {
        fetch: cloud.fetch,
      });
      return { code, io };
    },
  };
}

const MEMORY_ID = '11111111-2222-4333-8444-555555555555';

/** The same memory in the local store (local mode) or the fake cloud (cloud mode). */
async function seed(e: Env, mode: 'local' | 'cloud'): Promise<void> {
  if (mode === 'cloud') {
    e.cloud.memories.set(MEMORY_ID, fakeMemory({ id: MEMORY_ID }));
    return;
  }
  const w = await realWire(e.cwd, {
    env: { HOME: e.root, OORT_HOME: e.home, OORT_NO_KEYCHAIN: '1' },
    keychain: async () => undefined,
  });
  await w.store.upsert(
    localGrant({ ...localScope(undefined), projectIds: [null] }),
    memory({ id: MEMORY_ID, embedding: undefined }),
  );
  await w.close();
}

describe('cloud url and errors', () => {
  it('cloud.url-default-and-override', () => {
    expect(cloudUrl({})).toEqual({ url: DEFAULT_CLOUD_URL });
    expect(cloudUrl({ OORT_CLOUD_URL: 'http://localhost:8787/' })).toEqual({
      url: 'http://localhost:8787',
    });
    expect(cloudUrl({ OORT_CLOUD_URL: 'http://evil.example' })).toHaveProperty('error');
    expect(cloudUrl({ OORT_CLOUD_URL: 'https://u:p@api.oortcloud.dev' })).toHaveProperty('error');
    expect(DEFAULT_CLOUD_URL).toBe(CONTRACT.baseUrl);
  });

  it('cloud.errors-follow-the-contract', () => {
    for (const [k, kind] of Object.entries(CONTRACT.errors)) {
      const [status, code] = k.split(':');
      expect(cloudErrorKind(Number(status), code)).toBe(kind);
    }
    expect(new OortCloudError('payment-required', 402).holdQueue).toBe(true);
    expect(new OortCloudError('bad-request', 400).holdQueue).toBe(false);
  });

  it('cloud.settings-live-in-the-home-directory-only', () => {
    const e = setup('local');
    expect(readCloudSettings(e.home)).toEqual({ store: 'local' });
    // A repository cannot switch the store: an oort.config.json is never read for it.
    fs.writeFileSync(path.join(e.cwd, 'oort.config.json'), JSON.stringify({ store: 'cloud' }));
    expect(readCloudSettings(e.home).store).toBe('local');
    writeCloudSettings(e.home, { store: 'cloud' });
    expect(readCloudSettings(e.home).store).toBe('cloud');
    expect(fs.statSync(path.join(e.home, 'cloud.json')).mode & 0o777).toBe(0o600);
  });
});

/** Each case runs once per mode on the same seeded memory; both must agree. */
const TABLE: { name: string; args: string[]; stdout: (out: string) => void }[] = [
  {
    name: 'recall',
    args: ['recall', 'auth service port 5582'],
    stdout: (o) => expect(o).toContain('port 5582'),
  },
  {
    name: 'explain',
    args: ['explain', 'auth service port 5582'],
    stdout: (o) => expect(o).toContain(MEMORY_ID.slice(0, 8)),
  },
  {
    name: 'inspect list',
    args: ['inspect'],
    stdout: (o) => expect(o).toContain(MEMORY_ID.slice(0, 8)),
  },
  {
    name: 'inspect one by prefix',
    args: ['inspect', MEMORY_ID.slice(0, 8)],
    stdout: (o) => expect(o).toContain('The auth service listens on port 5582.'),
  },
  {
    name: 'pin',
    args: ['pin', MEMORY_ID],
    stdout: (o) => expect(o).toContain(`Pinned ${MEMORY_ID}`),
  },
  {
    name: 'stats',
    args: ['stats', '--json'],
    stdout: (o) => expect((JSON.parse(o) as { tiers: { warm: number } }).tiers.warm).toBe(1),
  },
  {
    name: 'export',
    args: ['export'],
    stdout: (o) => {
      expect(o.split('\n')[0]).toContain('"oort":"export"');
      expect(o).toContain(MEMORY_ID);
    },
  },
  {
    name: 'forget',
    args: ['forget', MEMORY_ID, '--yes'],
    stdout: (o) => expect(o).toContain(`Forgot ${MEMORY_ID}`),
  },
];

describe('cloud mode behaves like local mode (CON-76 shared table)', () => {
  for (const c of TABLE) {
    it(`table.${c.name.replace(/ /g, '-')}`, async () => {
      const results = [];
      for (const mode of ['local', 'cloud'] as const) {
        const e = setup(mode);
        await seed(e, mode);
        const r = await e.run(c.args);
        results.push({ mode, code: r.code, out: r.io.stdout, err: r.io.stderr });
        expect(r.code, `${mode}: ${r.io.stderr}`).toBe(0);
        c.stdout(r.io.stdout);
        if (mode === 'cloud') {
          // Cloud mode never reads a vendor key or calls a vendor: only contract routes.
          expect(e.cloud.seen.length).toBeGreaterThan(0);
          expect(e.cloud.seen.every((s) => / \/v1\//.test(s))).toBe(true);
        }
      }
      expect(results[0]?.code).toBe(results[1]?.code);
    });
  }

  it('table.prompt-hook-injects-the-same-memory', async () => {
    for (const mode of ['local', 'cloud'] as const) {
      const e = setup(mode);
      await seed(e, mode);
      const stdin = JSON.stringify({
        session_id: 's1',
        cwd: e.cwd,
        prompt: 'which port does the auth service 5582 use?',
      });
      const r = await e.run(['hook', 'UserPromptSubmit'], { stdin });
      expect(r.code).toBe(0);
      expect(r.io.hookStdout ?? '', mode).toContain('port 5582');
    }
  });
});

describe('cloud mode hooks (CON-76)', () => {
  it('hook.prompt-cloud-timeout-injects-nothing-and-exits-0', async () => {
    const e = setup('cloud');
    await seed(e, 'cloud');
    e.cloud.hangRecall = true;
    const stdin = JSON.stringify({
      session_id: 's1',
      cwd: e.cwd,
      prompt: 'auth service port 5582?',
    });
    const r = await e.run(['hook', 'UserPromptSubmit'], { stdin });
    expect(r.code).toBe(0);
    expect(r.io.hookStdout).toBe('');
  }, 15_000);

  it('hook.prompt-without-a-key-injects-nothing', async () => {
    const e = setup('cloud');
    await seed(e, 'cloud');
    const stdin = JSON.stringify({
      session_id: 's1',
      cwd: e.cwd,
      prompt: 'auth service port 5582?',
    });
    const r = await e.run(['hook', 'UserPromptSubmit'], { stdin, withKey: false });
    expect(r.code).toBe(0);
    expect(r.io.hookStdout).toBe('');
    expect(e.cloud.seen).toEqual([]);
  });

  it('hook.stop-then-drain-saves-to-the-cloud-and-logs-no-text', async () => {
    const e = setup('cloud');
    const transcript = writeTranscript(path.join(e.root, 'claude-projects'), e.cwd);
    const stop = await e.run(['hook', 'Stop'], {
      stdin: JSON.stringify({
        session_id: 'sess-1',
        cwd: e.cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    });
    expect(stop.code).toBe(0);
    expect(stop.io.spawned).toBe(1);
    // Stop never calls the cloud: it only queues.
    expect(e.cloud.seen).toEqual([]);
    const drain = await e.run(['hook', 'drain']);
    expect(drain.code).toBe(0);
    expect(e.cloud.observed.length).toBeGreaterThan(0);
    const log = fs.readFileSync(path.join(e.home, 'logs', 'hooks.log'), 'utf8');
    for (const b of e.cloud.observed) {
      const o = b['observation'] as { user: string; assistant: string };
      for (const text of [o.user, o.assistant]) {
        for (const word of text.split(/\s+/).filter((w) => w.length > 12)) {
          expect(log).not.toContain(word);
        }
      }
    }
  });

  it('hook.drain-keeps-the-queue-when-the-plan-lapses', async () => {
    const e = setup('cloud');
    const transcript = writeTranscript(path.join(e.root, 'claude-projects'), e.cwd);
    await e.run(['hook', 'Stop'], {
      stdin: JSON.stringify({ session_id: 'sess-1', cwd: e.cwd, transcript_path: transcript }),
    });
    e.cloud.refuse = { status: 402, code: 'payment_required', message: 'No active plan.' };
    await e.run(['hook', 'drain']);
    const queued = fs.readdirSync(path.join(e.home, 'queue')).filter((f) => f.endsWith('.jsonl'));
    expect(queued.length).toBe(1);
    expect(fs.existsSync(path.join(e.home, 'queue', 'dead'))).toBe(false);
  });
});

describe('oort cloud commands (CON-76)', () => {
  it('cloud.use-checks-the-account-and-switches-the-store', async () => {
    const e = setup('local');
    const r = await e.run(['cloud', 'use'], { withKey: true });
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain('Oort Cloud');
    expect(readCloudSettings(e.home).store).toBe('cloud');
    const back = await e.run(['cloud', 'use', '--local'], { withKey: true });
    expect(back.code).toBe(0);
    expect(readCloudSettings(e.home).store).toBe('local');
  });

  it('cloud.use-refuses-when-the-cloud-is-not-enabled', async () => {
    const e = setup('local');
    e.cloud.refuse = { status: 403, code: 'cloud_not_enabled', message: 'not yet' };
    const r = await e.run(['cloud', 'use'], { withKey: true });
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('not enabled');
    expect(readCloudSettings(e.home).store).toBe('local');
  });

  it('cloud.use-needs-a-login', async () => {
    const e = setup('local');
    const r = await e.run(['cloud', 'use'], { withKey: false });
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('oort login');
  });

  it('cloud.errors-are-plain-refusals-without-the-key', async () => {
    for (const [status, code, want] of [
      [401, 'unauthorized', 'oort login'],
      [402, 'payment_required', 'not active'],
      [429, 'monthly_cap', 'limit reached'],
      [413, 'too_large', 'too large'],
      [503, 'unavailable', 'busy'],
    ] as const) {
      const e = setup('cloud');
      e.cloud.refuse = { status, code, message: 'refused' };
      const r = await e.run(['recall', 'anything here']);
      expect(r.code, String(status)).toBe(2);
      expect(r.io.stderr).toContain(want);
      expect(r.io.stderr).not.toContain(e.key);
    }
  });

  it('cloud.status-reports-store-account-and-counts', async () => {
    const e = setup('cloud');
    await seed(e, 'cloud');
    const r = await e.run(['cloud', 'status', '--json']);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.io.stdout) as {
      store: string;
      account: { plan: string };
      cloud: { memories: number };
    };
    expect(s.store).toBe('cloud');
    expect(s.account.plan).toBe('pro');
    expect(s.cloud.memories).toBe(1);
  });

  it('cloud.export-downloads-the-account', async () => {
    const e = setup('local');
    await seed(e, 'cloud');
    const out = path.join(e.root, 'backup.jsonl');
    const r = await e.run(['cloud', 'export', '--out', out], { withKey: true });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toContain(MEMORY_ID);
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  });

  it('cloud.import-10k-is-resumable-and-creates-no-duplicates', async () => {
    const e = setup('local');
    const w = await realWire(e.cwd, {
      env: { HOME: e.root, OORT_HOME: e.home, OORT_NO_KEYCHAIN: '1' },
      keychain: async () => undefined,
    });
    const grant = localGrant({ ...localScope(undefined), projectIds: [null] });
    const all = Array.from({ length: 10_000 }, (_, i) =>
      memory({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        text: `Memory number ${i}.`,
        embedding: undefined,
        createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      }),
    );
    await w.store.upsertMany(grant, all);
    await w.close();

    const dry = await e.run(['cloud', 'import', '--dry-run'], { withKey: true });
    expect(dry.code).toBe(0);
    expect(dry.io.stdout).toContain('10000');
    expect(e.cloud.imports).toBe(0);

    // The network drops after 7 requests (3,500 memories).
    e.cloud.failImportsAfter = 7;
    const first = await e.run(['cloud', 'import', '--yes'], { withKey: true });
    expect(first.code).toBe(2);
    expect(first.io.stderr).toContain('unreachable');
    expect(e.cloud.memories.size).toBe(3500);
    expect(readCloudSettings(e.home).import).toMatchObject({ done: 3500, total: 10_000 });

    e.cloud.failImportsAfter = undefined;
    e.cloud.imports = 0;
    const second = await e.run(['cloud', 'import', '--yes'], { withKey: true });
    expect(second.code, second.io.stderr).toBe(0);
    expect(second.io.stdout).toContain('resuming after 3500');
    // Resumed: only the remaining 6,500 were sent (13 requests), nothing skipped, no duplicates.
    expect(e.cloud.imports).toBe(13);
    expect(second.io.stdout).toContain('6500 imported, 0 already in the cloud');
    expect(e.cloud.memories.size).toBe(10_000);

    // A third run sends nothing; a forced restart (lost progress) only skips.
    const third = await e.run(['cloud', 'import', '--yes'], { withKey: true });
    expect(third.io.stdout).toContain('Already uploaded');
    writeCloudSettings(e.home, { store: 'local' });
    const again = await e.run(['cloud', 'import', '--yes'], { withKey: true });
    expect(again.io.stdout).toContain('0 imported, 10000 already in the cloud');
    expect(e.cloud.memories.size).toBe(10_000);
  }, 120_000);

  it('cloud.import-refuses-without-a-terminal-or-yes', async () => {
    const e = setup('local');
    await seed(e, 'local');
    const r = await e.run(['cloud', 'import'], { withKey: true });
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('--yes');
    expect(e.cloud.imports).toBe(0);
    // CON-107: stdout piped refuses without asking; a declined upload exits 0 and asks on stderr.
    expectRefusedWithoutPrompt(
      await e.run(['cloud', 'import'], { withKey: true, tty: true, stdoutTTY: false }),
      PIPED,
    );
    const no = await e.run(['cloud', 'import'], { withKey: true, tty: true, answer: 'n' });
    expectDeclined(no);
    expect(no.io.stdout).toContain('Nothing uploaded.');
    expect(e.cloud.imports).toBe(0);
    const yes = await e.run(['cloud', 'import', '--yes'], { withKey: true });
    expect(yes.code, yes.io.stderr).toBe(0);
    expect(e.cloud.imports).toBeGreaterThan(0);
  });

  it('cloud.local-only-commands-refuse-in-cloud-mode', async () => {
    const e = setup('cloud');
    const c = await e.run(['consolidate']);
    expect(c.code).toBe(2);
    expect(c.io.stderr).toContain('consolidates');
    const i = await e.run(['import', 'claude-code', '--yes']);
    expect(i.code).toBe(2);
    expect(i.io.stderr).toContain('cloud use --local');
  });

  it('cloud.doctor-checks-the-cloud-in-cloud-mode', async () => {
    const e = setup('cloud');
    const ok = await e.run(['doctor', '--json']);
    const checks = (
      JSON.parse(ok.io.stdout) as { checks: { group: string; status: string; detail: string }[] }
    ).checks;
    expect(checks.find((c) => c.group === 'cloud')).toMatchObject({ status: 'ok' });
    const noKey = await e.run(['doctor', '--json'], { withKey: false });
    const c2 = (JSON.parse(noKey.io.stdout) as { checks: { group: string; status: string }[] })
      .checks;
    expect(c2.find((c) => c.group === 'cloud')).toMatchObject({ status: 'fail' });
    const local = setup('local');
    const l = await local.run(['doctor', '--json']);
    const c3 = (JSON.parse(l.io.stdout) as { checks: { group: string; status: string }[] }).checks;
    expect(c3.find((c) => c.group === 'cloud')).toMatchObject({ status: 'info' });
  });
});

describe('cloud API follow-ups (CON-76, oortcloud PR #3)', () => {
  const stopThenQueue = async (e: Env): Promise<void> => {
    const transcript = writeTranscript(path.join(e.root, 'claude-projects'), e.cwd);
    await e.run(['hook', 'Stop'], {
      stdin: JSON.stringify({ session_id: 'sess-1', cwd: e.cwd, transcript_path: transcript }),
    });
  };
  const queued = (e: Env): string[] =>
    fs.readdirSync(path.join(e.home, 'queue')).filter((f) => f.endsWith('.jsonl'));

  it('drain.crash-after-the-post-then-rerun-saves-the-turn-once', async () => {
    const e = setup('cloud');
    await stopThenQueue(e);
    // The cloud saves the turn, then the connection drops before the answer arrives.
    e.cloud.dropAfterObserve = true;
    await e.run(['hook', 'drain']);
    expect(e.cloud.memories.size).toBe(1);
    expect(queued(e).length).toBe(1); // held: the drain never heard back
    await e.run(['hook', 'drain']);
    expect(queued(e).length).toBe(0); // the duplicate answer counts as saved
    const refs = e.cloud.observed.map((b) => b['turnRef']);
    expect(refs.every((r) => typeof r === 'string' && r.length > 0 && r.length <= 128)).toBe(true);
    // One POST was repeated; every turn is stored exactly once.
    expect(e.cloud.observed.length).toBe(e.cloud.memories.size + 1);
    expect(new Set(refs).size).toBe(e.cloud.memories.size);
    expect(refs[0]).toMatch(/^[^:]+:[^:]+$/); // <sessionId>:<transcript turn>
  });

  it('import.follows-next-when-a-chunk-has-more-than-1000-lines', async () => {
    const e = setup('local');
    const client = createCloudClient({ url: DEFAULT_CLOUD_URL, key: e.key, fetch: e.cloud.fetch });
    const header = JSON.stringify({ oort: 'export', version: 1 });
    const lines = Array.from({ length: 2_500 }, (_, i) =>
      JSON.stringify(fakeMemory({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` })),
    );
    const progress: number[] = [];
    const r = await uploadChunk(client, header, lines, (n) => progress.push(n));
    expect(r).toMatchObject({ imported: 2_500, skipped: 0, calls: 3 });
    expect(e.cloud.importFroms).toEqual([0, 1001, 2001]);
    expect(progress).toEqual([1000, 2000, 2500]);
    expect(e.cloud.memories.size).toBe(2_500);
  });

  it('import.refuses-when-the-api-stops-making-progress', async () => {
    const stuck = {
      importLines: async () => ({ imported: 0, skipped: 0, reembedded: 0, next: 1 }),
    } as unknown as Parameters<typeof uploadChunk>[0];
    await expect(uploadChunk(stuck, '{}', ['a', 'b'], () => {})).rejects.toThrow('progress');
  });

  it('session-start.injects-pinned-and-hot-memories', async () => {
    const e = setup('cloud');
    const pinned = fakeMemory({
      text: 'Pinned rule: always run pnpm verify.',
      tier: 'cold',
      pinned: true,
    });
    const hot = fakeMemory({ text: 'Hot fact: the relay listens on 8787.', tier: 'hot' });
    const cold = fakeMemory({ text: 'Cold fact: nobody needs this today.', tier: 'cold' });
    for (const m of [pinned, hot, cold]) e.cloud.memories.set(m.id as string, m);
    const r = await e.run(['hook', 'SessionStart'], {
      stdin: JSON.stringify({ session_id: 's1', cwd: e.cwd }),
    });
    expect(r.code).toBe(0);
    const out = r.io.hookStdout ?? '';
    expect(out).toContain('always run pnpm verify');
    expect(out).toContain('relay listens on 8787');
    expect(out).not.toContain('nobody needs this');
  });

  it('inspect.prefix-is-looked-up-by-the-api', async () => {
    const e = setup('cloud');
    const a = '12345678-aaaa-4333-8444-555555555555';
    const b = '12345678-bbbb-4333-8444-555555555555';
    for (const id of [a, b]) e.cloud.memories.set(id, fakeMemory({ id }));
    const ambiguous = await e.run(['inspect', '12345678']);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.io.stderr).toContain('more than one memory');
    const short = await e.run(['inspect', '1234']);
    expect(short.code).toBe(2);
    expect(short.io.stderr).toContain('at least 8 characters');
    const one = await e.run(['inspect', '12345678-a']);
    expect(one.code, one.io.stderr).toBe(0);
    expect(one.io.stdout).toContain(a);
    // No listing: one GET per lookup.
    expect(e.cloud.seen.filter((s) => s === 'GET /v1/memories')).toEqual([]);
  });

  it('export.works-when-the-plan-has-lapsed', async () => {
    const e = setup('cloud');
    await seed(e, 'cloud');
    e.cloud.lapsed = true;
    const out = path.join(e.root, 'backup.jsonl');
    const c = await e.run(['cloud', 'export', '--out', out]);
    expect(c.code, c.io.stderr).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toContain(MEMORY_ID);
    const x = await e.run(['export']);
    expect(x.code, x.io.stderr).toBe(0);
    expect(x.io.stdout).toContain(MEMORY_ID);
    // Everything else is refused, and the refusal points at export.
    const r = await e.run(['recall', 'auth service port']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('not active');
    expect(r.io.stderr).toContain('oort cloud export');
  });

  it('cloud.recall-reports-only-what-the-server-reports', async () => {
    // Cloud mode loads no local embed or rerank adapter: the server embeds and reranks.
    const e = setup('cloud');
    await seed(e, 'cloud');
    for (const cmd of ['recall', 'explain']) {
      const ok = await e.run([cmd, 'auth service port 5582']);
      expect(ok.code, ok.io.stderr).toBe(0);
      expect(ok.io.stderr, cmd).toBe('');
    }
    e.cloud.recallDegraded = ['rerank-timeout'];
    for (const cmd of ['recall', 'explain']) {
      const slow = await e.run([cmd, 'auth service port 5582']);
      expect(slow.code, slow.io.stderr).toBe(0);
      expect(slow.io.stderr, cmd).toBe('oort: recall degraded (rerank-timeout).\n');
    }
  });

  it('cloud.use-says-when-the-local-store-is-already-imported', async () => {
    const e = setup('local');
    const w = await realWire(e.cwd, {
      env: { HOME: e.root, OORT_HOME: e.home, OORT_NO_KEYCHAIN: '1' },
      keychain: async () => undefined,
    });
    const grant = localGrant({ ...localScope(undefined), projectIds: [null] });
    const mem = (i: number) =>
      memory({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        text: `Memory number ${i}.`,
        embedding: undefined,
        createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      });
    await w.store.upsertMany(grant, [0, 1, 2].map(mem));
    await w.close();

    const before = await e.run(['cloud', 'use'], { withKey: true });
    expect(before.code, before.io.stderr).toBe(0);
    expect(before.io.stdout).toContain('3 memories stay in the local store');

    const imp = await e.run(['cloud', 'import', '--yes'], { withKey: true });
    expect(imp.code, imp.io.stderr).toBe(0);
    const after = await e.run(['cloud', 'use'], { withKey: true });
    expect(after.code, after.io.stderr).toBe(0);
    expect(after.io.stdout).not.toContain('stay in the local store');
    expect(after.io.stdout).not.toContain('until you run `oort cloud import`');
    expect(after.io.stdout).toContain('All 3 local memories are already in Oort Cloud.');

    // A memory saved locally after the import is the only one left to upload.
    const w2 = await realWire(e.cwd, {
      env: { HOME: e.root, OORT_HOME: e.home, OORT_NO_KEYCHAIN: '1' },
      keychain: async () => undefined,
    });
    await w2.store.upsert(grant, mem(3));
    await w2.close();
    const grown = await e.run(['cloud', 'use'], { withKey: true });
    expect(grown.io.stdout).toContain(
      '1 memory stays in the local store until you run `oort cloud import`',
    );
  });
});

describe('cloud mode, time modes (review 12)', () => {
  it('cloud.recall-warns-when-the-api-ignores-a-requested-mode', async () => {
    const e = setup('cloud');
    await seed(e, 'cloud');
    const asked = await e.run(['recall', 'auth service port 5582', '--history']);
    expect(asked.code, asked.io.stderr).toBe(0);
    expect(asked.io.stderr).toContain('did not report the time mode');
    const plain = await e.run(['recall', 'auth service port 5582']);
    expect(plain.io.stderr).not.toContain('time mode');
    const explain = await e.run(['explain', 'auth service port 5582', '--as-of', '2026-04-01']);
    expect(explain.io.stdout).toContain('mode: not reported');
    expect(explain.io.stderr).toContain('did not report the time mode');
  });
});

describe('Stars and Oort Cloud (CON-62 review)', () => {
  const stop = async (e: Env) => {
    const transcript = writeTranscript(path.join(e.root, 'claude-projects'), e.cwd);
    return e.run(['hook', 'Stop'], {
      stdin: JSON.stringify({ session_id: 'sess-1', cwd: e.cwd, transcript_path: transcript }),
    });
  };

  it('cloud.star-agents-never-write-the-cloud-planet', async () => {
    const e = setup('cloud');
    setAgentStar(e.home, 'cursor', true);
    setAgentStar(e.home, 'claude-code', true);
    // oort observe as a Star agent: refused, nothing sent.
    const obs = await e.run([
      '--agent',
      'cursor',
      'observe',
      '--user',
      'remember this',
      '--assistant',
      'ci runs on arm',
    ]);
    expect(obs.code).toBe(2);
    expect(obs.io.stderr).toContain('cursor keeps its memories in its own Star');
    // forget and pin too.
    e.cloud.memories.set(MEMORY_ID, fakeMemory({ id: MEMORY_ID }));
    for (const args of [
      ['forget', MEMORY_ID, '--yes'],
      ['pin', MEMORY_ID],
    ]) {
      const r = await e.run(['--agent', 'cursor', ...args]);
      expect(r.code, args.join(' ')).toBe(2);
    }
    expect(e.cloud.memories.get(MEMORY_ID)?.pinned).toBe(false);
    // The Claude Code hooks fail open: Stop saves nothing, says so once, exits 0; drain holds.
    const s = await stop(e);
    expect(s.code).toBe(0);
    expect(s.io.stderr).toContain('claude-code keeps its memories in its own Star');
    expect(s.io.spawned).toBe(0);
    const d = await e.run(['hook', 'drain']);
    expect(d.code).toBe(0);
    expect(e.cloud.observed).toEqual([]);
    // Reads still work.
    const r = await e.run(['--agent', 'cursor', 'recall', 'auth service port', '--json']);
    expect(r.code).toBe(0);
    // A Planet agent still writes.
    const ok = await e.run([
      '--agent',
      'codex',
      'observe',
      '--user',
      'remember this',
      '--assistant',
      'ci runs on arm',
    ]);
    expect(ok.code, ok.io.stderr).toBe(0);
    expect(e.cloud.observed).toHaveLength(1);
  });

  it('cloud.mcp-remember-as-a-star-agent-is-refused', async () => {
    const e = setup('cloud');
    setAgentStar(e.home, 'cursor', true);
    const w = await realWire(e.cwd, {
      env: { HOME: e.root, OORT_HOME: e.home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: e.key },
      keychain: async () => undefined,
      fetch: e.cloud.fetch,
      agent: 'cursor',
    });
    const backend = cloudBackend({ wired: w, client: w.cloud! });
    await expect(
      backend.remember({ facts: ['ci runs on arm'], visibility: 'private' }),
    ).rejects.toThrow(/keeps its memories in its own Star/);
    expect(e.cloud.observed).toEqual([]);
    await w.close();
  });

  it('cloud.connect-star-and-cloud-use-refuse-the-combination', async () => {
    const cloudMode = setup('cloud');
    const c = await cloudMode.run(['connect', 'cursor', '--star']);
    expect(c.code).toBe(2);
    expect(c.io.stderr).toContain('Oort Cloud, which has no Stars yet');
    expect(readAgents(cloudMode.home)).toEqual({});
    // Doctor warns when the combination exists anyway (set before switching, or by hand).
    setAgentStar(cloudMode.home, 'cursor', true);
    const doc = await cloudMode.run(['doctor', '--json']);
    const checks = (JSON.parse(doc.io.stdout) as { checks: Record<string, string>[] }).checks;
    expect(checks.find((x) => x['group'] === 'cloud' && x['name'] === 'stars')).toMatchObject({
      status: 'warn',
      fix: 'oort connect cursor --no-star, or oort cloud use --local',
    });

    const local = setup('local');
    setAgentStar(local.home, 'cursor', true);
    const use = await local.run(['cloud', 'use'], { withKey: true });
    expect(use.code).toBe(2);
    expect(use.io.stderr).toContain('cursor keeps its memories in a Star');
    expect(readCloudSettings(local.home).store).toBe('local');
    setAgentStar(local.home, 'cursor', false);
    expect((await local.run(['cloud', 'use'], { withKey: true })).code).toBe(0);
  });

  it('cloud.import-uploads-every-agents-planet-memories-and-no-star', async () => {
    const e = setup('local');
    const env = { HOME: e.root, OORT_HOME: e.home, OORT_NO_KEYCHAIN: '1' };
    const w = await realWire(e.cwd, { env, keychain: async () => undefined });
    const planet = { level: 'user', orgId: 'local', customerId: 'self' } as const;
    const ccStar = { level: 'agent', orgId: 'local', agentId: 'claude-code' } as const;
    const cursorStar = { level: 'agent', orgId: 'local', agentId: 'cursor' } as const;
    const secret = memory({
      ...addressed(ccStar, { agentId: 'claude-code' }),
      text: 'Private note.',
      embedding: undefined,
    });
    const byCodex = memory({
      ...addressed({ ...planet, projectId: 'p1' }, { agentId: 'codex' }),
      text: 'Codex learned this.',
      embedding: undefined,
    });
    const byClaude = memory({
      text: 'Claude learned this.',
      embedding: undefined,
      source: {
        harness: 'test',
        decisions: [{ stage: 'level', question: 'contradicts', answer: secret.id, probability: 1 }],
      },
    });
    const starOnly = memory({
      ...addressed(cursorStar, { agentId: 'cursor' }),
      text: 'Cursor only.',
      embedding: undefined,
    });
    await w.store.upsertMany(nodesGrant(planet, ccStar, cursorStar), [
      secret,
      byCodex,
      byClaude,
      starOnly,
    ]);
    await w.close();
    const r = await e.run(['cloud', 'import', '--yes'], { withKey: true });
    expect(r.code, r.io.stderr).toBe(0);
    expect([...e.cloud.memories.keys()].sort()).toEqual([byClaude.id, byCodex.id].sort());
    // The cloud puts each on the account's own Planet, keeping the project.
    expect(e.cloud.memories.get(byCodex.id)?.scope).toEqual({
      orgId: 'acct:a1',
      customerId: 'self',
      agentId: 'default',
      projectId: 'p1',
    });
    // A contradiction naming a Star memory never leaves the machine.
    expect(JSON.stringify(e.cloud.memories.get(byClaude.id))).not.toContain(secret.id);
  });
});
