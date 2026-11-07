import * as fs from 'node:fs';
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
import { writeCloudSettings } from './cloud.js';
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
    opts: { tty?: boolean; stdoutTTY?: boolean; answer?: string } = {},
  ) => {
    const io = fakeIo({
      cwd,
      env: { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: key },
      ...(opts.tty !== undefined && { tty: opts.tty, stdoutTTY: opts.stdoutTTY ?? opts.tty }),
      ...(opts.answer !== undefined && { answer: opts.answer }),
    });
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
