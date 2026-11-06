import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKeychain, type Keychain } from '../keychain.js';
import { fakeSite } from '../../test/fake-site.js';
import { VERSION } from '@oortmem/core';
import {
  data,
  fakeDecide,
  fakeIo,
  fakeNpm,
  harness,
  memoryKeychain,
  npmPrefixCopy,
  npmTrap,
  writeTranscript,
  type Harness,
} from '../../test/helpers.js';
import type { UpdateDeps } from './update.js';
import type { LoginDeps } from './login.js';
import type { WireFn } from '../wire.js';
import { setupCommand, type Choice, type Prompter, type SetupDeps } from './setup.js';
import { TG } from '@oortmem/core/store-conformance';

const CMD = '/opt/oort/node_modules/oort/dist/main.js';

/** The harness, with every id the store ever received recorded (to prove the demo cleans up). */
function recording(h: Harness): { wire: WireFn; ids: Set<string> } {
  const ids = new Set<string>();
  const wire: WireFn = async (cwd, opts) => {
    const w = await h.wire(cwd, opts);
    const store = w.store;
    w.store = Object.assign(Object.create(store) as typeof store, {
      upsert: async (...[grant, m]: Parameters<typeof store.upsert>) => {
        ids.add(m.id);
        return store.upsert(grant, m);
      },
      upsertMany: async (...[grant, ms]: Parameters<typeof store.upsertMany>) => {
        for (const m of ms) ids.add(m.id);
        return store.upsertMany(grant, ms);
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
    more: Partial<SetupDeps> = {},
    machine: { env?: Record<string, string>; updateDeps?: Partial<UpdateDeps> } = {},
  ) => {
    const fio = fakeIo({
      cwd: h.cwd,
      env: {
        HOME: h.root,
        OORT_HOME: h.home,
        ...(login !== undefined && { OORT_SITE_URL: login.siteUrl }),
        ...machine.env,
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
        ...(machine.updateDeps !== undefined && { updateDeps: machine.updateDeps }),
      },
      { bin: () => CMD, ...(prompter !== undefined && { prompter }), ...more },
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
    for (const id of ids) expect(await h.store.get(TG, id)).toBeNull();
    // Missing keys are reported with where to get each, never prompted for.
    expect(out).not.toContain('Keychain now');
  });

  it('setup.demo-without-keys-still-shows-recall-and-cleans-up', async () => {
    const { h, ids, run } = setupHarness({ adapters: false });
    const r = await run({ yes: true, agents: 'none', keys: 'byo', import: 'skip' });
    expect(r.code).toBe(0);
    expect(r.io.stdout).toContain('https://docs.voyageai.com/docs/api-key-and-installation');
    expect(r.io.stdout).toContain('https://platform.claude.com/settings/keys');
    // No key store here: name the variable, never `export KEY=...` (shell history).
    expect(r.io.stdout).toContain(
      'then set TYPESAFE_API_KEY in the environment your agent starts with',
    );
    expect(r.io.stdout).not.toMatch(/export [A-Z_]+_KEY/);
    expect(r.io.stdout).toContain('macOS-only');
    expect(r.io.stdout).toMatch(/recalled/i);
    for (const id of ids) expect(await h.store.get(TG, id)).toBeNull();
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

  it('setup.a-declined-import-is-not-reported-as-imported (CON-107)', async () => {
    const { h, run } = setupHarness();
    // A git repository, so the transcript's sessions resolve to this project.
    fs.mkdirSync(path.join(h.cwd, '.git'));
    writeTranscript(path.join(h.root, '.claude', 'projects'), h.cwd);
    // Every other step comes from the flags; the one question left is the import's.
    const p = scripted([false]);
    const r = await run(
      { agents: 'none', keys: 'skip', import: '3650d', demo: false },
      { tty: true, stdoutTTY: true },
      p,
    );
    expect(r.code, r.io.stderr).toBe(0);
    expect(p.asked).toHaveLength(1);
    expect(p.said).toContain('Nothing imported. Later: `oort import claude-code --since 3650d`.');
    expect(p.said + r.io.stdout).not.toContain('imported Claude Code sessions');
  });

  it('setup.a-partial-import-says-so-and-how-to-retry (CON-107)', async () => {
    const { h, run } = setupHarness();
    // A git repository, so the transcript's sessions resolve to this project.
    fs.mkdirSync(path.join(h.cwd, '.git'));
    writeTranscript(path.join(h.root, '.claude', 'projects'), h.cwd);
    const base = h.wire;
    h.wire = async (dir, o) => ({
      ...(await base(dir, o)),
      decide: {
        ...fakeDecide,
        async gate() {
          throw new Error('upstream unavailable');
        },
      },
    });
    const r = await run({ yes: true, agents: 'none', keys: 'skip', import: '3650d', demo: false });
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain('stopped at a failed observation');
    expect(r.io.stdout).toContain('Run `oort import claude-code --since 3650d` to retry them.');
    expect(r.io.stdout).toContain('imported part of the Claude Code sessions since 3650d');
    expect(r.io.stdout).not.toContain('imported Claude Code sessions since');
  });

  it('setup.a-full-import-is-reported (CON-107)', async () => {
    const { h, run } = setupHarness();
    // A git repository, so the transcript's sessions resolve to this project.
    fs.mkdirSync(path.join(h.cwd, '.git'));
    writeTranscript(path.join(h.root, '.claude', 'projects'), h.cwd);
    const r = await run({ yes: true, agents: 'none', keys: 'skip', import: '3650d', demo: false });
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain('imported Claude Code sessions since 3650d');
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
      expect(p.said).toContain(`${site.url}/account/cli`);
      expect(p.said).toContain(site.sessions[0]!.code);
      expect(p.said).not.toContain(site.polls[0]!);
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
      expect(r.io.stdout).toContain(`${site.url}/account/cli`);
      expect(r.io.stdout).toContain(site.sessions[0]!.code);
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
        createKeychain({ platform: 'none' }),
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

  /**
   * The managed copy (CON-114): `~/.oort/cli` (here `$OORT_HOME/cli`) is what agents run. Every npm
   * is a fake (`fakeNpm`) behind a stand-in on PATH (`npmTrap`): nothing is installed, nothing
   * reaches the network.
   */
  describe('the managed copy', () => {
    const NPX = '/Users/x/.npm/_npx/0a1b2c/node_modules/oortmem/dist/main.js';
    const flags = {
      yes: true,
      agents: 'claude-code,codex',
      keys: 'skip',
      import: 'skip',
      demo: false,
    };
    const managedMain = (h: Harness): string =>
      path.join(h.home, 'cli', 'lib', 'node_modules', 'oortmem', 'dist', 'main.js');
    const hooksText = (h: Harness): string =>
      fs.readFileSync(path.join(h.root, '.claude', 'settings.json'), 'utf8');
    const codexText = (h: Harness): string =>
      fs.readFileSync(path.join(h.root, '.codex', 'config.toml'), 'utf8');
    /** `.claude` and `.codex` in HOME, and PATH holding only the stand-in npm. */
    function agentsAndNpm(h: Harness, withNpm = true): { env: Record<string, string> } {
      fs.mkdirSync(path.join(h.root, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(h.root, '.codex'), { recursive: true });
      return { env: { PATH: withNpm ? npmTrap(h.root).dir : '' } };
    }

    it('setup.fresh-home-installs-the-managed-copy-and-points-agents-at-it', async () => {
      const { h, run } = setupHarness();
      const npm = fakeNpm();
      const m = agentsAndNpm(h);
      const r = await run(
        flags,
        {},
        undefined,
        undefined,
        undefined,
        {},
        {
          ...m,
          updateDeps: npm.deps,
        },
      );
      expect(r.code, r.io.stderr).toBe(0);
      expect(r.io.asked).toEqual([]);
      // npm by its absolute path on PATH, the prefix named, this version, from HOME.
      expect(npm.calls).toEqual([
        {
          file: path.join(h.root, 'npm-trap', 'npm'),
          args: [
            'i',
            '-g',
            '--prefix',
            path.join(h.home, 'cli'),
            `oortmem@${VERSION}`,
            '--prefer-online',
          ],
          cwd: h.root,
        },
      ]);
      expect(hooksText(h)).toContain(`${managedMain(h)} hook Stop`);
      expect(hooksText(h)).not.toContain(CMD);
      expect(codexText(h)).toContain(managedMain(h));
      const out = r.io.stdout;
      expect(out).toContain(
        `Installing oort ${VERSION} in ~/oort-home/cli, the copy agents run: npm i -g --prefix ~/oort-home/cli oortmem@${VERSION} --prefer-online`,
      );
      expect(out).toContain(`Installed oort ${VERSION} in ~/oort-home/cli: agents run it`);
      expect(out).toContain('npm rm -g --prefix ~/oort-home/cli oortmem');
      // OORT_HOME is created owner-only before npm writes into it.
      expect(fs.statSync(h.home).mode & 0o077).toBe(0);
    });

    it('setup.reuses-a-managed-copy-at-this-version-with-no-npm-call', async () => {
      const { h, run } = setupHarness();
      const npm = fakeNpm();
      const m = agentsAndNpm(h);
      const managed = npmPrefixCopy(path.join(h.home, 'cli'), VERSION);
      const r = await run(
        flags,
        {},
        undefined,
        undefined,
        undefined,
        {},
        {
          ...m,
          updateDeps: npm.deps,
        },
      );
      expect(r.code, r.io.stderr).toBe(0);
      expect(npm.calls).toEqual([]);
      expect(hooksText(h)).toContain(`${managed.main} hook Stop`);
      expect(r.io.stdout).toContain(
        `Agents run the managed copy in ~/oort-home/cli (oort ${VERSION})`,
      );
      expect(r.io.stdout).not.toContain('npm rm -g');
    });

    it('setup.an-older-managed-copy-is-brought-to-this-version', async () => {
      const { h, run } = setupHarness();
      const npm = fakeNpm();
      const m = agentsAndNpm(h);
      npmPrefixCopy(path.join(h.home, 'cli'), '0.0.1');
      const r = await run(
        flags,
        {},
        undefined,
        undefined,
        undefined,
        {},
        {
          ...m,
          updateDeps: npm.deps,
        },
      );
      expect(r.code, r.io.stderr).toBe(0);
      expect(npm.calls.map((c) => c.args[4])).toEqual([`oortmem@${VERSION}`]);
      expect(hooksText(h)).toContain(managedMain(h));
    });

    it('setup.without-npm-falls-back-to-this-copy-with-a-warning', async () => {
      const { h, run } = setupHarness();
      const m = agentsAndNpm(h, false);
      const r = await run(flags, {}, undefined, undefined, undefined, {}, m);
      expect(r.code, r.io.stderr).toBe(0);
      expect(hooksText(h)).toContain(`${CMD} hook Stop`);
      expect(codexText(h)).toContain(CMD);
      expect(r.io.stdout).toContain(
        `The managed copy in ~/oort-home/cli cannot be installed (npm is not on PATH), so agents run this copy: ${CMD}. For one that stays put: npm i -g --prefix ~/oort-home/cli oortmem, then oort install claude-code.`,
      );
      expect(fs.existsSync(path.join(h.home, 'cli'))).toBe(false);
    });

    it('setup.a-failing-npm-falls-back-to-this-copy-with-a-warning', async () => {
      const { h, run } = setupHarness();
      const npm = fakeNpm({ fail: 'npm ERR! code E404\n' });
      const m = agentsAndNpm(h);
      const r = await run(
        flags,
        {},
        undefined,
        undefined,
        undefined,
        {},
        {
          ...m,
          updateDeps: npm.deps,
        },
      );
      expect(r.code, r.io.stderr).toBe(0);
      expect(npm.calls).toHaveLength(1); // not ETARGET: no retry
      expect(hooksText(h)).toContain(`${CMD} hook Stop`);
      expect(r.io.stdout).toContain(
        'The managed copy in ~/oort-home/cli could not be installed (npm failed), so agents run this copy',
      );
      expect(r.io.stdout).not.toContain('npm rm -g');
    });

    it('setup.npm-that-leaves-another-version-is-not-trusted', async () => {
      const { h, run } = setupHarness();
      const npm = fakeNpm({ leaves: '0.0.1' });
      const m = agentsAndNpm(h);
      const r = await run(
        flags,
        {},
        undefined,
        undefined,
        undefined,
        {},
        {
          ...m,
          updateDeps: npm.deps,
        },
      );
      expect(r.code, r.io.stderr).toBe(0);
      expect(hooksText(h)).toContain(`${CMD} hook Stop`);
      expect(r.io.stdout).toContain(`does not hold oortmem ${VERSION}`);
    });

    it('setup.a-transient-running-copy-is-never-written', async () => {
      const unstable = { unstable: () => 'a package cache', bin: () => NPX };
      // With npm: the managed copy is installed, and agents run it.
      const a = setupHarness();
      const npm = fakeNpm();
      const ma = agentsAndNpm(a.h);
      const ok = await a.run(flags, {}, undefined, undefined, undefined, unstable, {
        ...ma,
        updateDeps: npm.deps,
      });
      expect(ok.code, ok.io.stderr).toBe(0);
      expect(hooksText(a.h)).toContain(managedMain(a.h));
      expect(hooksText(a.h)).not.toContain('_npx');
      expect(codexText(a.h)).not.toContain('_npx');
      // Without npm: nothing is connected, and setup says what to run.
      const b = setupHarness();
      const mb = agentsAndNpm(b.h, false);
      const skipped = await b.run(flags, {}, undefined, undefined, undefined, unstable, mb);
      expect(skipped.code).toBe(0);
      expect(fs.existsSync(path.join(b.h.root, '.claude', 'settings.json'))).toBe(false);
      expect(fs.existsSync(path.join(b.h.root, '.codex', 'config.toml'))).toBe(false);
      expect(skipped.io.stdout).toContain(
        'Skipped connecting: This oort is in a package cache, which agents would lose later. The managed copy cannot be installed (npm is not on PATH): run npm i -g --prefix ~/oort-home/cli oortmem, then ~/oort-home/cli/bin/oort setup.',
      );
      // npm failing: the same, never the npx path.
      const c = setupHarness();
      const mc = agentsAndNpm(c.h);
      const failed = await c.run(flags, {}, undefined, undefined, undefined, unstable, {
        ...mc,
        updateDeps: fakeNpm({ fail: 'npm ERR! network\n' }).deps,
      });
      expect(failed.code).toBe(0);
      expect(fs.existsSync(path.join(c.h.root, '.claude', 'settings.json'))).toBe(false);
      expect(failed.io.stdout).toContain('could not be installed (npm failed)');
    });

    it('setup.json-from-npx-installs-the-managed-copy-and-reports-it', async () => {
      // Through the CLI, as `npx oortmem setup --yes … --json` runs: the entry is in npx's cache.
      const h = harness();
      fs.mkdirSync(path.join(h.root, '.claude'));
      const npx = path.join(h.root, '.npm', '_npx', '6a1f2b', 'node_modules', 'oortmem', 'dist');
      fs.mkdirSync(npx, { recursive: true });
      fs.writeFileSync(path.join(npx, 'main.js'), '#!/bin/sh\n', { mode: 0o755 });
      const npm = fakeNpm();
      const r = await h.run(
        ['setup', '--yes', '--agents', 'claude-code', '--keys', 'skip', '--no-demo', '--json'],
        {
          env: { HOME: h.root, OORT_HOME: h.home, PATH: npmTrap(h.root).dir },
          entry: path.join(npx, 'main.js'),
        },
        undefined,
        { updateDeps: npm.deps },
      );
      expect(r.code, r.io.stderr).toBe(0);
      expect(r.io.asked).toEqual([]);
      const d = data(r.io.stdout, 'setup') as {
        command: string;
        managed: Record<string, unknown>;
        changed: { what: string }[];
      };
      expect(d.command).toBe(
        path.join(h.home, 'cli', 'lib', 'node_modules', 'oortmem', 'dist', 'main.js'),
      );
      expect(d.managed).toEqual({
        prefix: path.join(h.home, 'cli'),
        status: 'installed',
        version: VERSION,
        command: `npm i -g --prefix ~/oort-home/cli oortmem@${VERSION} --prefer-online`,
        reason: null,
      });
      expect(d.changed.map((c) => c.what)).toContain(
        `installed oort ${VERSION} in ~/oort-home/cli (the copy agents run)`,
      );
      // stdout is the envelope alone; the human lines (and npm's) went to stderr.
      expect(r.io.stdout).not.toContain('Installed oort');
      expect(r.io.stderr).toContain('Installed oort');
      expect(fs.readFileSync(path.join(h.root, '.claude', 'settings.json'), 'utf8')).not.toContain(
        '_npx',
      );
      // No npm: the envelope says so, and nothing points at npx's copy.
      const h2 = harness();
      fs.mkdirSync(path.join(h2.root, '.claude'));
      const r2 = await h2.run(
        ['setup', '--yes', '--agents', 'claude-code', '--keys', 'skip', '--no-demo', '--json'],
        { env: { HOME: h2.root, OORT_HOME: h2.home, PATH: '' }, entry: path.join(npx, 'main.js') },
      );
      expect(r2.code, r2.io.stderr).toBe(0);
      const d2 = data(r2.io.stdout, 'setup') as { command: null; managed: Record<string, unknown> };
      expect(d2.command).toBeNull();
      expect(d2.managed).toMatchObject({ status: 'unavailable', reason: 'no-npm' });
    });

    it('setup.json-reports-the-fallback-as-a-warning', async () => {
      const h = harness();
      fs.mkdirSync(path.join(h.root, '.claude'));
      const r = await h.run(
        ['setup', '--yes', '--agents', 'claude-code', '--keys', 'skip', '--no-demo', '--json'],
        { env: { HOME: h.root, OORT_HOME: h.home, PATH: '' } },
      );
      // Not running as the bin and no npm: nothing to connect with, and no warning to give.
      expect(r.code, r.io.stderr).toBe(0);
      const env = JSON.parse(r.io.stdout) as { warnings: { code: string }[] };
      expect(env.warnings.map((w) => w.code)).not.toContain('managed-copy-unavailable');
    });

    it('setup.interactive-asks-once-for-the-install-and-the-writes', async () => {
      const { h, run } = setupHarness();
      fs.mkdirSync(path.join(h.root, '.cursor'));
      const env = { PATH: npmTrap(h.root).dir };
      // agents; keys: skip; install and write: yes; demo: no.
      const npm = fakeNpm();
      const p = scripted([['cursor'], 'skip', true, false]);
      const yes = await run(
        { import: 'skip' },
        { tty: true, stdoutTTY: true },
        p,
        undefined,
        undefined,
        {},
        {
          env,
          updateDeps: npm.deps,
        },
      );
      expect(yes.code, yes.io.stderr).toBe(0);
      expect(p.asked).toContain(
        `Install oort ${VERSION} in ~/oort-home/cli and write these changes?`,
      );
      expect(p.asked.filter((q) => q.includes('npm'))).toEqual([]);
      // The preview named the install and the managed path before the question.
      expect(p.said).toContain(
        `+ npm i -g --prefix ~/oort-home/cli oortmem@${VERSION} --prefer-online`,
      );
      expect(p.said).toContain(
        path.join(h.home, 'cli', 'lib', 'node_modules', 'oortmem', 'dist', 'main.js'),
      );
      expect(npm.calls).toHaveLength(1);
      expect(fs.readFileSync(path.join(h.root, '.cursor', 'mcp.json'), 'utf8')).toContain(
        path.join(h.home, 'cli'),
      );
    });

    it('setup.interactive-declining-installs-nothing-and-writes-nothing', async () => {
      const { h, run } = setupHarness();
      fs.mkdirSync(path.join(h.root, '.cursor'));
      const npm = fakeNpm();
      const p = scripted([['cursor'], 'skip', false, false]);
      const r = await run(
        { import: 'skip' },
        { tty: true, stdoutTTY: true },
        p,
        undefined,
        undefined,
        {},
        {
          env: { PATH: npmTrap(h.root).dir },
          updateDeps: npm.deps,
        },
      );
      expect(r.code).toBe(0);
      expect(npm.calls).toEqual([]);
      expect(fs.existsSync(path.join(h.home, 'cli'))).toBe(false);
      expect(fs.existsSync(path.join(h.root, '.cursor', 'mcp.json'))).toBe(false);
      expect(p.said).toContain('Nothing installed, and nothing changed in any agent config.');
    });

    it('setup.with-no-agents-installs-nothing', async () => {
      const { h, run } = setupHarness();
      const npm = fakeNpm();
      const r = await run(
        { ...flags, agents: 'none' },
        {},
        undefined,
        undefined,
        undefined,
        {},
        {
          env: { PATH: npmTrap(h.root).dir },
          updateDeps: npm.deps,
        },
      );
      expect(r.code).toBe(0);
      expect(npm.calls).toEqual([]);
    });

    it('setup.install-global-is-accepted-and-changes-nothing', async () => {
      const h = harness();
      const r = await h.run([
        'setup',
        '--yes',
        '--agents',
        'none',
        '--keys',
        'skip',
        '--no-demo',
        '--install-global',
      ]);
      expect(r.code, r.io.stderr).toBe(0);
    });
  });
});
