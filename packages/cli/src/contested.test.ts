import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeCloud, fakeMemory, type FakeCloud } from '../test/fake-cloud.js';
import { fakeIo, tmpdir } from '../test/helpers.js';
import { writeCloudSettings } from './cloud.js';
import { createKeychain } from './keychain.js';
import { runCli } from './program.js';
import { DISPLAY_UNSAFE_SAMPLES, safeJson } from './util.js';
import { wire as realWire, type WireFn } from './wire.js';

/**
 * CON-66 from the command line: who may supersede (`policy --supersede-trust`), what a share did
 * in the Constellation, the contested pairs, and a maintainer resolving one. Every rule is the
 * API's; the fake cloud follows cloud-contract.json.
 */
const oortKey = (): string => ['oort', 'sk', `cont${Date.now()}`.padEnd(43, 'C')].join('_');
const C = 'c_aaaaaaaaaaaaaaaa';
const ESC = '\u001b';
const CSI = '\u009b';
const raw = (s: string) =>
  s.includes(ESC) ||
  s.includes(CSI) ||
  DISPLAY_UNSAFE_SAMPLES.some(
    (cp) => cp > 0x1f && cp !== 0x7f && s.includes(String.fromCodePoint(cp)),
  );

function setup(role = 'maintainer') {
  const root = tmpdir();
  const home = path.join(root, 'oort-home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const key = oortKey();
  const cloud: FakeCloud = fakeCloud(key);
  writeCloudSettings(home, { store: 'cloud' });
  cloud.hive.enabled = true;
  cloud.hive.constellations.set(C, {
    id: C,
    name: 'oort-core',
    role,
    owner: role === 'maintainer',
  });
  const wire: WireFn = (dir, o = {}) =>
    realWire(dir, { ...o, keychain: async () => undefined, fetch: cloud.fetch });
  const run = async (args: string[]) => {
    const io = fakeIo({
      cwd,
      env: { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: key },
    });
    const code = await runCli(args, io, wire, createKeychain({ platform: 'none' }), {
      fetch: cloud.fetch,
    });
    return { code, io };
  };
  return { cloud, run };
}

const CUR = '11111111-aaaa-4aaa-8aaa-111111111111';
const CHAL = '22222222-bbbb-4bbb-8bbb-222222222222';

function contest(e: ReturnType<typeof setup>, challengerText = 'the deploy target is railway') {
  e.cloud.hive.contests.set(C, [
    {
      action: 'SUPERSEDE',
      openedAt: '2026-11-05T10:00:00.000Z',
      current: fakeMemory({ id: CUR, text: 'the deploy target is fly' }),
      challenger: fakeMemory({ id: CHAL, text: challengerText }),
    },
  ]);
}

describe('oort constellation policy --supersede-trust (CON-66)', () => {
  it('policy.sets-supersede-trust-alone-or-with-the-share-policy', async () => {
    const e = setup();
    const r = await e.run([
      'constellation',
      'policy',
      'oort-core',
      '--supersede-trust',
      'maintainer',
    ]);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain('now uses the confirm policy');
    expect(r.io.stdout).toContain('needs maintainer trust to supersede');
    expect(e.cloud.hive.supersedeTrust.get(C)).toBe('maintainer');
    const both = await e.run([
      'constellation',
      'policy',
      'oort-core',
      '--open',
      '--supersede-trust',
      'member',
    ]);
    expect(both.io.stdout).toContain('now uses the open policy');
    expect(both.io.stdout).toContain('needs member trust');
  });

  it('policy.refuses-a-bad-trust-and-no-flag-and-the-api-refuses-the-rest', async () => {
    const e = setup();
    expect((await e.run(['constellation', 'policy', 'oort-core'])).code).toBe(2);
    const bad = await e.run([
      'constellation',
      'policy',
      'oort-core',
      '--supersede-trust',
      'reader',
    ]);
    expect(bad.code).toBe(2);
    expect(bad.io.stderr).toContain('member or maintainer');
    const member = setup('member');
    const refused = await member.run([
      'constellation',
      'policy',
      'oort-core',
      '--supersede-trust',
      'maintainer',
    ]);
    expect(refused.code).toBe(2);
    expect(refused.io.stderr).toContain('Only a maintainer');
  });
});

describe('oort share says what the Constellation did with it (CON-66)', () => {
  it('share.prints-the-outcome-note-for-a-contested-or-superseding-share', async () => {
    const ID = '33333333-cccc-4ccc-8ccc-333333333333';
    for (const [outcome, note] of [
      ['contested', 'until a maintainer decides'],
      ['superseded', 'replaces an earlier memory'],
      ['history', 'kept as history'],
    ] as const) {
      const e = setup();
      e.cloud.memories.set(ID, fakeMemory({ id: ID, text: 'the deploy target is railway' }));
      e.cloud.hive.shareOutcome = outcome;
      const r = await e.run(['share', ID, '--to', 'oort-core', '--yes']);
      expect(r.code, r.io.stderr).toBe(0);
      expect(r.io.stdout).toContain(note);
    }
    // An outcome this CLI does not know prints nothing extra.
    const e = setup();
    e.cloud.memories.set(ID, fakeMemory({ id: ID }));
    e.cloud.hive.shareOutcome = 'something-new';
    const r = await e.run(['share', ID, '--to', 'oort-core', '--yes']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).not.toContain('something-new');
    expect(r.io.stdout).not.toMatch(/maintainer decides|earlier memory|as history|confirmation/);
  });
});

describe('oort constellation contested and resolve (CON-66)', () => {
  it('contested.lists-both-memories-and-how-to-resolve', async () => {
    const e = setup();
    const none = await e.run(['constellation', 'contested', 'oort-core']);
    expect(none.code, none.io.stderr).toBe(0);
    expect(none.io.stdout).toContain('Nothing in "oort-core" is contested.');
    contest(e);
    const r = await e.run(['constellation', 'contested', 'oort-core']);
    expect(r.io.stdout).toContain(`current     ${CUR}  "the deploy target is fly"`);
    expect(r.io.stdout).toContain(`challenger  ${CHAL}  "the deploy target is railway"`);
    expect(r.io.stdout).toContain('asks to SUPERSEDE, since 2026-11-05');
    expect(r.io.stdout).toContain(
      'oort constellation resolve "oort-core" <challenger id> --keep <id>',
    );
    const j = await e.run(['constellation', 'contested', 'oort-core', '--json']);
    expect(JSON.parse(j.io.stdout)).toMatchObject([{ action: 'SUPERSEDE', current: { id: CUR } }]);
  });

  it('resolve.keeps-one-memory-and-says-what-happened-to-the-other', async () => {
    const e = setup();
    contest(e);
    const r = await e.run(['constellation', 'resolve', 'oort-core', CHAL, '--keep', CHAL]);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain(`Kept ${CHAL} in "oort-core"; ${CUR} is superseded`);
    contest(e);
    const back = await e.run(['constellation', 'resolve', 'oort-core', CHAL, '--keep', CUR]);
    expect(back.io.stdout).toContain(`${CHAL} is retracted`);
    const gone = await e.run(['constellation', 'resolve', 'oort-core', CHAL, '--keep', CUR]);
    expect(gone.code).toBe(2);
    expect(gone.io.stderr).toContain('No open contest');
  });

  it('resolve.needs-keep-and-a-maintainer', async () => {
    const e = setup();
    contest(e);
    const missing = await e.run(['constellation', 'resolve', 'oort-core', CHAL]);
    expect(missing.code).not.toBe(0);
    const member = setup('member');
    contest(member);
    const refused = await member.run([
      'constellation',
      'resolve',
      'oort-core',
      CHAL,
      '--keep',
      CHAL,
    ]);
    expect(refused.code).toBe(2);
    expect(refused.io.stderr).toContain('Only a maintainer');
  });

  it('contested.server-strings-are-printed-escaped', async () => {
    const e = setup();
    const hostile = DISPLAY_UNSAFE_SAMPLES.map((cp) => `x${String.fromCodePoint(cp)}`).join('');
    contest(e, `evil ${ESC}[2J${CSI}31m ${hostile}`);
    e.cloud.hive.contests.get(C)![0]!.action = `SUPER${ESC}]0;pwned` as never;
    const r = await e.run(['constellation', 'contested', 'oort-core']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(raw(r.io.stdout)).toBe(false);
    expect(r.io.stdout).toContain('evil \\u{1b}[2J\\u{9b}31m');
    e.cloud.hive.contests.set(C, []);
    contest(e);
    const res = await e.run(['constellation', 'resolve', 'oort-core', CHAL, '--keep', CHAL]);
    expect(raw(res.io.stdout)).toBe(false);
  });
});

describe("--json never plants other members' control or bidi characters (CON-66 review)", () => {
  const hostile = DISPLAY_UNSAFE_SAMPLES.map((cp) => `x${String.fromCodePoint(cp)}`).join('');
  /** Any DISPLAY_UNSAFE character above C0 left raw (JSON escapes C0 itself). */
  const rawUnsafe = (s: string) =>
    DISPLAY_UNSAFE_SAMPLES.some((cp) => cp > 0x1f && s.includes(String.fromCodePoint(cp)));

  it('json.safe-json-escapes-the-shown-set-and-parses-back-to-the-same-values', () => {
    const v = { text: `a${hostile}b`, list: [`\u202eevil`], n: 1 };
    const out = safeJson(v);
    expect(rawUnsafe(out)).toBe(false);
    expect(out).toContain('\\u202e');
    expect(out).toContain('\\u009b');
    expect(JSON.parse(out)).toEqual(v);
    // Pretty-printed as before: same lines, only the escapes differ.
    expect(out.split('\n')).toHaveLength(JSON.stringify(v, null, 2).split('\n').length);
  });

  it('json.contested-resolve-members-and-recall-print-escaped-json', async () => {
    const e = setup();
    contest(e, `evil ${hostile}`);
    const j = await e.run(['constellation', 'contested', 'oort-core', '--json']);
    expect(j.code, j.io.stderr).toBe(0);
    expect(rawUnsafe(j.io.stdout)).toBe(false);
    const parsed = JSON.parse(j.io.stdout) as { challenger: { text: string } }[];
    expect(parsed[0]!.challenger.text).toBe(`evil ${hostile}`);
    e.cloud.hive.constellations.get(C)!.name = `oort${CSI}\u202e-core`;
    const list = await e.run(['constellation', 'list', '--json']);
    expect(rawUnsafe(list.io.stdout)).toBe(false);
    const res = await e.run(['constellation', 'resolve', C, CHAL, '--keep', CHAL, '--json']);
    expect(res.code, res.io.stderr).toBe(0);
    expect(rawUnsafe(res.io.stdout)).toBe(false);
  });

  it('json.an-unknown-action-or-outcome-named-like-a-prototype-key-prints-nothing-odd', async () => {
    const e = setup();
    contest(e);
    e.cloud.hive.contests.get(C)![0]!.action = 'constructor' as never;
    const r = await e.run(['constellation', 'resolve', 'oort-core', CHAL, '--keep', CHAL]);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain('is constructor.');
    const ID = '44444444-dddd-4ddd-8ddd-444444444444';
    const s = setup();
    s.cloud.memories.set(ID, fakeMemory({ id: ID }));
    s.cloud.hive.shareOutcome = '__proto__';
    const sh = await s.run(['share', ID, '--to', 'oort-core', '--yes']);
    expect(sh.code, sh.io.stderr).toBe(0);
    expect(sh.io.stdout).not.toContain('[object');
  });
});
