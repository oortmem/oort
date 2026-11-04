import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localGrant, localScope } from '@oortmem/core';
import { fakeCloud, fakeMemory, type FakeCloud } from '../test/fake-cloud.js';
import { fakeIo, memory, tmpdir, writeTranscript } from '../test/helpers.js';
import CONTRACT from '../test/cloud-contract.json' with { type: 'json' };
import {
  DEFAULT_CLOUD_URL,
  OortCloudError,
  cloudErrorKind,
  cloudUrl,
  readCloudSettings,
  writeCloudSettings,
} from './cloud.js';
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
    opts?: { stdin?: string; withKey?: boolean; tty?: boolean; answer?: string },
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
        ...(opts.tty !== undefined && { tty: opts.tty }),
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
