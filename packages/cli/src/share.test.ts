import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeCloud, fakeMemory, type FakeCloud } from '../test/fake-cloud.js';
import { fakeIo, tmpdir } from '../test/helpers.js';
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
  const run = async (args: string[], opts: { tty?: boolean; answer?: string } = {}) => {
    const io = fakeIo({
      cwd,
      env: { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: key },
      ...(opts.tty !== undefined && { tty: opts.tty }),
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
    expect(r.io.stdout).toMatch(/Shared to Constellation oort-core as [0-9a-f-]{36}/);
    // The preview first, then the confirmation with exactly the text that was shown.
    expect(e.cloud.hive.requests).toEqual([
      { memoryId: ID },
      {
        memoryId: ID,
        text: 'We deploy oortcloud with wrangler; ask maya@example.com.',
        confirm: true,
      },
    ]);
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
    const first = e.cloud.hive.requests[0] as { text: string; privateProjects?: string[] };
    expect(first.text).toBe('We deploy with wrangler.');
    expect(first.privateProjects).toHaveLength(1);
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
    expect(JSON.parse(list.io.stdout)).toEqual([
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
    expect(plain.io.stdout).toContain('Still shared to oort-core');
    expect(e.cloud.hive.shared.size).toBe(1);

    const other = '33333333-4444-4555-8666-777777777777';
    e.cloud.memories.set(other, fakeMemory({ id: other, text: 'Release notes come first.' }));
    await e.run(['share', other, '--to', 'oort-core', '--yes']);
    const all = await e.run(['forget', other, '--yes', '--everywhere']);
    expect(all.code).toBe(0);
    expect(all.io.stdout).toContain('Withdrawn from 1 Constellation');
    expect([...e.cloud.hive.shared.values()].map((x) => x.sourceId)).toEqual([ID]);
    expect((await setup('local').run(['forget', ID, '--yes', '--everywhere'])).code).toBe(2);
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
});
