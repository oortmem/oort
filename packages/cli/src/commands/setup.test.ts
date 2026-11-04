import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKeychain, type Keychain } from '../keychain.js';
import { fakeSite } from '../../test/fake-site.js';
import {
  fakeIo,
  harness,
  memoryKeychain,
  writeTranscript,
  type Harness,
} from '../../test/helpers.js';
import type { LoginDeps } from './login.js';
import type { WireFn } from '../wire.js';
import { setupCommand, type Choice, type Prompter } from './setup.js';

const CMD = '/opt/oort/node_modules/oort/dist/main.js';

/** The harness, with every id the store ever received recorded (to prove the demo cleans up). */
function recording(h: Harness): { wire: WireFn; ids: Set<string> } {
  const ids = new Set<string>();
  const wire: WireFn = async (cwd, opts) => {
    const w = await h.wire(cwd, opts);
    const store = w.store;
    w.store = Object.assign(Object.create(store) as typeof store, {
      upsert: async (m: Parameters<typeof store.upsert>[0]) => {
        ids.add(m.id);
        return store.upsert(m);
      },
      upsertMany: async (ms: Parameters<typeof store.upsertMany>[0]) => {
        for (const m of ms) ids.add(m.id);
        return store.upsertMany(ms);
      },
    });
    return w;
  };
  return { wire, ids };
}

/** Answers queued per question kind; `null` cancels. */
function scripted(answers: unknown[]): Prompter & { asked: string[]; said: string } {
  const queue = [...answers];
  const p = {
    interactive: true,
    asked: [] as string[],
    said: '',
    intro(t: string) {
      p.said += `intro ${t}\n`;
    },
    step(_n: number, t: string) {
      p.said += `step ${t}\n`;
    },
    info(t: string) {
      p.said += `${t}\n`;
    },
    outro(t: string) {
      p.said += `outro ${t}\n`;
    },
    async multiselect<T extends string>(m: string, _o: Choice<T>[], _i: T[]) {
      p.asked.push(m);
      return queue.shift() as T[] | null;
    },
    async select<T extends string>(m: string, _o: Choice<T>[], _i: T) {
      p.asked.push(m);
      return queue.shift() as T | null;
    },
    async confirm(m: string, _i: boolean) {
      p.asked.push(m);
      return queue.shift() as boolean | null;
    },
  };
  return p;
}

function setupHarness(opts: { adapters?: boolean } = {}) {
  const h = harness(opts);
  const rec = recording(h);
  const run = async (
    flags: Parameters<typeof setupCommand>[0],
    io: { tty?: boolean; stdoutTTY?: boolean } = {},
    prompter?: Prompter,
    keychain: Keychain = createKeychain({ platform: 'none' }),
    login?: { siteUrl: string; deps?: LoginDeps },
  ) => {
    const fio = fakeIo({
      cwd: h.cwd,
      env: {
        HOME: h.root,
        OORT_HOME: h.home,
        ...(login !== undefined && { OORT_SITE_URL: login.siteUrl }),
      },
      ...io,
    });
    const code = await setupCommand(
      flags,
      {
        io: fio,
        wire: rec.wire,
        keychain,
        login: { sleep: async () => {}, openBrowser: async () => false, ...login?.deps },
      },
      { bin: () => CMD, ...(prompter !== undefined && { prompter }) },
    );
    return { code, io: fio };
  };
  return { h, ids: rec.ids, run };
}

describe('oort setup', () => {
  it('setup.non-tty-without-yes-never-prompts-and-prints-flags', async () => {
    const h = harness();
    fs.mkdirSync(path.join(h.root, '.codex'));
    const r = await h.run(['setup']);
    expect(r.code).toBe(2);
    expect(r.io.asked).toEqual([]);
    for (const flag of ['--yes', '--agents codex', '--keys', '--import'])
      expect(r.io.stderr).toContain(flag);
    expect(fs.readdirSync(path.join(h.root, '.codex'))).toEqual([]);
  });

  it('setup.rejects-bad-flags-before-changing-anything', async () => {
    const h = harness();
    for (const args of [
      ['setup', '--yes', '--agents', 'chatgpt'],
      ['setup', '--yes', '--keys', 'maybe'],
      ['setup', '--yes', '--import', 'soon'],
    ]) {
      const r = await h.run(args);
      expect(r.code, args.join(' ')).toBe(2);
    }
    expect(fs.existsSync(path.join(h.root, '.claude'))).toBe(false);
  });

  it('setup.yes-with-flags-runs-every-step-without-prompting', async () => {
    const { h, ids, run } = setupHarness();
    fs.mkdirSync(path.join(h.root, '.claude'));
    fs.mkdirSync(path.join(h.root, '.codex'));
    const r = await run({ yes: true, agents: 'claude-code,codex', keys: 'byo', import: 'skip' });
    expect(r.code).toBe(0);
    expect(r.io.asked).toEqual([]);
    const out = r.io.stdout;
    expect(out.split('\n')[0]).toMatch(/^oort setup/);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(out).toContain(`${n}/6`);
    // Hooks for Claude Code, MCP for the others.
    const settings = JSON.parse(
      fs.readFileSync(path.join(h.root, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    expect(fs.existsSync(path.join(h.root, '.claude.json'))).toBe(false);
    expect(fs.readFileSync(path.join(h.root, '.codex', 'config.toml'), 'utf8')).toContain(CMD);
    // What changed and how to undo it.
    expect(out).toContain('oort uninstall claude-code');
    expect(out).toContain('oort disconnect codex');
    // The demo remembered, recalled and forgot, leaving nothing behind.
    expect(out).toMatch(/remembered/i);
    expect(out).toMatch(/recalled/i);
    expect(out).toMatch(/forgot/i);
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) expect(await h.store.get(id)).toBeNull();
    // Missing keys are reported with where to get each, never prompted for.
    expect(out).not.toContain('Keychain now');
  });

  it('setup.demo-without-keys-still-shows-recall-and-cleans-up', async () => {
    const { h, ids, run } = setupHarness({ adapters: false });
    const r = await run({ yes: true, agents: 'none', keys: 'byo', import: 'skip' });
    expect(r.code).toBe(0);
    expect(r.io.stdout).toContain('https://docs.voyageai.com/docs/api-key-and-installation');
    expect(r.io.stdout).toContain('https://platform.claude.com/settings/keys');
    expect(r.io.stdout).toContain('export TYPESAFE_API_KEY=');
    expect(r.io.stdout).toContain('macOS-only');
    expect(r.io.stdout).toMatch(/recalled/i);
    for (const id of ids) expect(await h.store.get(id)).toBeNull();
  });

  it('setup.import-runs-only-when-asked-and-reuses-the-estimate', async () => {
    const { h, run } = setupHarness();
    writeTranscript(path.join(h.root, '.claude', 'projects'), h.cwd);
    const skipped = await run({
      yes: true,
      agents: 'none',
      keys: 'skip',
      import: 'skip',
      demo: false,
    });
    expect(skipped.io.stdout).not.toMatch(/observations\s+[1-9]/);
    const ran = await run({
      yes: true,
      agents: 'none',
      keys: 'skip',
      import: '3650d',
      demo: false,
    });
    expect(ran.code).toBe(0);
    // Unresolved sessions are skipped unless asked; the estimate always prints first.
    expect(ran.io.stdout).toMatch(/sessions\s+\d/);
    expect(ran.io.stdout).toMatch(/skipped \(unresolved\)/);
  });

  it('setup.interactive-pro-runs-oort-login-for-real', async () => {
    const { h, run } = setupHarness();
    fs.mkdirSync(path.join(h.root, '.cursor'));
    const site = await fakeSite({ approveAtPoll: 2 });
    try {
      const k = memoryKeychain();
      const p = scripted([['cursor'], 'pro', true, true]);
      const r = await run({}, { tty: true, stdoutTTY: true }, p, k.kc, { siteUrl: site.url });
      expect(r.code).toBe(0);
      expect(p.asked.length).toBe(4);
      expect(site.polls.length).toBe(2);
      expect(k.items['oort.oort']).toBe(site.minted);
      expect(p.said).toContain(`/account/cli?session=${site.polls[0]}`);
      expect(p.said).toContain('Signed in to Oort Pro');
      expect(p.said).toMatch(/oort logout/);
      expect(p.said).toMatch(/oort disconnect cursor/);
      expect(p.said + r.io.stdout + r.io.stderr).not.toContain(site.minted);
      expect(fs.readFileSync(path.join(h.root, '.cursor', 'mcp.json'), 'utf8')).toContain(CMD);
    } finally {
      await site.close();
    }
  });

  it('setup.yes-keys-pro-signs-in-without-a-question', async () => {
    const { run } = setupHarness();
    const site = await fakeSite({ approveAtPoll: 1 });
    try {
      const k = memoryKeychain();
      const r = await run(
        { yes: true, agents: 'none', keys: 'pro', import: 'skip', demo: false },
        {},
        undefined,
        k.kc,
        { siteUrl: site.url },
      );
      expect(r.code).toBe(0);
      expect(r.io.asked).toEqual([]);
      expect(k.items['oort.oort']).toBe(site.minted);
      expect(r.io.stdout).toContain('?session=');
      expect(r.io.stdout).toContain('oort logout');
    } finally {
      await site.close();
    }
  });

  it('setup.pro-that-cannot-sign-in-says-why-and-carries-on', async () => {
    const { run } = setupHarness();
    const site = await fakeSite({ ttlMs: -1 });
    try {
      const expired = await run(
        { yes: true, agents: 'none', keys: 'pro', import: 'skip', demo: false },
        {},
        undefined,
        memoryKeychain().kc,
        { siteUrl: site.url },
      );
      expect(expired.code).toBe(0);
      expect(expired.io.stdout).toContain('expired');
      expect(expired.io.stdout).toContain('6/6');
      const off = await run(
        { yes: true, agents: 'none', keys: 'pro', import: 'skip', demo: false },
        {},
        undefined,
        createKeychain({ platform: 'linux' }),
        { siteUrl: site.url },
      );
      expect(off.code).toBe(0);
      expect(off.io.stdout).toContain('OORT_API_KEY');
    } finally {
      await site.close();
    }
  });

  it('setup.an-oort-key-skips-bring-your-own-keys', async () => {
    const { run } = setupHarness();
    const key = ['oort', 'sk', 'test0123456789abcdef'].join('_');
    const k = memoryKeychain({ 'oort.oort': key });
    // agents: none; no keys question; demo: no.
    const p = scripted([[], false]);
    const r = await run({ import: 'skip' }, { tty: true, stdoutTTY: true }, p, k.kc);
    expect(r.code).toBe(0);
    expect(p.asked).not.toContain('How should Oort reach its model providers?');
    expect(p.said).toContain('Oort Pro');
    expect(p.said).toContain('oort.oort');
    expect(p.said).not.toContain('get a key at');
    expect(p.said + r.io.stdout).not.toContain(key);
    const yes = await run(
      { yes: true, agents: 'none', keys: 'byo', import: 'skip', demo: false },
      {},
      undefined,
      k.kc,
    );
    expect(yes.io.stdout).not.toContain('get a key at');
  });

  it('setup.interactive-declining-the-write-changes-nothing', async () => {
    const { h, run } = setupHarness();
    fs.mkdirSync(path.join(h.root, '.cursor'));
    const p = scripted([['cursor'], 'skip', false, false]);
    const r = await run({}, { tty: true, stdoutTTY: true }, p);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(h.root, '.cursor', 'mcp.json'))).toBe(false);
    expect(p.said).toMatch(/nothing changed/i);
  });

  it('setup.cancel-stops-and-says-what-changed', async () => {
    const { h, run } = setupHarness();
    fs.mkdirSync(path.join(h.root, '.cursor'));
    const p = scripted([['cursor'], null]);
    const r = await run({}, { tty: true, stdoutTTY: true }, p);
    expect(r.code).toBe(1);
    expect(p.said).toMatch(/cancelled/i);
    expect(fs.existsSync(path.join(h.root, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('setup.byo-offers-the-keychain-for-each-missing-key-interactively', async () => {
    const { run } = setupHarness();
    const stored: string[] = [];
    const kc = createKeychain({
      platform: 'darwin',
      user: 'alice',
      execFile: async () => {
        throw Object.assign(new Error('nf'), { code: 44 });
      },
      spawnInherit: async (_f, args) => {
        stored.push(args[args.indexOf('-s') + 1] ?? '');
        return 0;
      },
    });
    // agents: none; keys: byo; then yes, no, yes for voyage, typesafe, anthropic; demo: no.
    const p = scripted([[], 'byo', true, false, true, false]);
    const r = await run({ import: 'skip' }, { tty: true, stdoutTTY: true }, p, kc);
    expect(r.code).toBe(0);
    expect(stored).toEqual(['oort.voyage', 'oort.anthropic']);
    expect(p.said).toContain('oort keys rm voyage');
  });
});
