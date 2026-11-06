import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeCloud, fakeMemory, type FakeCloud } from '../test/fake-cloud.js';
import {
  NO_TTY_STDIN,
  PIPED_YES,
  expectAsked,
  expectDeclined,
  expectRefusedWithoutPrompt,
  fakeIo,
  tmpdir,
  data,
} from '../test/helpers.js';
import { writeCloudSettings } from './cloud.js';
import { inviteToken } from './commands/constellation.js';
import { cloudBackend, cloudSpaces } from './mcp.js';
import { parseKeyScope } from './commands/keys.js';
import { createKeychain } from './keychain.js';
import { runCli } from './program.js';
import { DISPLAY_UNSAFE_SAMPLES, echo, shown } from './util.js';
import { wire as realWire, type WireFn } from './wire.js';

/**
 * CON-64 from the command line: invites, members and roles, leaving, agents attached to a
 * Constellation, narrowed keys, and the spaces whoami and doctor list. Every rule is the API's;
 * the fake cloud follows cloud-contract.json, and the CLI shows the API's own refusals.
 */
const oortKey = (): string => ['oort', 'sk', `memb${Date.now()}`.padEnd(43, 'M')].join('_');
const C = 'c_aaaaaaaaaaaaaaaa';

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
  const opened: string[] = [];
  const run = async (
    args: string[],
    opts: {
      tty?: boolean;
      stdoutTTY?: boolean;
      answer?: string;
      stdin?: string;
      env?: Record<string, string>;
    } = {},
  ) => {
    const io = fakeIo({
      cwd,
      env: {
        HOME: root,
        OORT_HOME: home,
        OORT_NO_KEYCHAIN: '1',
        OORT_API_KEY: key,
        ...opts.env,
      },
      ...(opts.tty !== undefined && { tty: opts.tty, stdoutTTY: opts.stdoutTTY ?? opts.tty }),
      ...(opts.answer !== undefined && { answer: opts.answer }),
      ...(opts.stdin !== undefined && { stdin: opts.stdin }),
    });
    const code = await runCli(args, io, wire, createKeychain({ platform: 'none' }), {
      fetch: cloud.fetch,
      login: {
        openBrowser: async (url: string) => {
          opened.push(url);
          return true;
        },
      },
    });
    return { code, io };
  };
  return { root, home, cwd, cloud, key, run, opened };
}

function team(e: ReturnType<typeof setup>, role = 'maintainer', owner = true) {
  e.cloud.hive.enabled = true;
  e.cloud.hive.constellations.set(C, { id: C, name: 'oort-core', role, owner });
  e.cloud.hive.members.set(C, [
    {
      member: 'mb_you000000001',
      role,
      owner,
      you: true,
      email: null,
      joinedAt: '2026-11-05T00:00:00.000Z',
    },
    {
      member: 'mb_maya00000002',
      role: 'member',
      owner: false,
      you: false,
      email: 'ma…@example.com',
      joinedAt: '2026-11-06T00:00:00.000Z',
    },
  ]);
}

describe('oort constellation invite and join (CON-64)', () => {
  it('invite.prints-the-single-use-link-and-the-expiry', async () => {
    const e = setup();
    team(e);
    e.cloud.hive.memberLimit = 10;
    const r = await e.run([
      'constellation',
      'invite',
      'oort-core',
      'sam@example.com',
      '--role',
      'reader',
    ]);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain('Invited sa…@example.com to oort-core as reader');
    expect(r.io.stdout).toContain('Nothing was emailed');
    expect(r.io.stdout).toMatch(/https:\/\/oortcloud\.dev\/invite#oort_iv_/);
    expect(r.io.stdout).toContain('expires 2026-11-12');
    const json = await e.run(['constellation', 'invite', 'oort-core', 'kim@example.com', '--json']);
    expect(data(json.io.stdout)).toMatchObject({ role: 'member', emailed: false });
  });

  it('invite.prints-the-clouds-note-when-no-email-was-sent-and-still-the-link', async () => {
    const e = setup();
    team(e);
    e.cloud.hive.memberLimit = 10;
    e.cloud.hive.inviteNote = 'No email was sent: you have sent 20 invite emails today.\u001b[2J';
    const r = await e.run(['constellation', 'invite', 'oort-core', 'sam@example.com']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain('No email was sent: you have sent 20 invite emails today.');
    expect(r.io.stdout).not.toContain('\u001b');
    expect(r.io.stdout).toMatch(/https:\/\/oortcloud\.dev\/invite#oort_iv_/);
  });

  it('invite.refuses-bad-input-before-calling-the-cloud', async () => {
    const e = setup();
    team(e);
    expect((await e.run(['constellation', 'invite', 'oort-core', 'not-an-email'])).code).toBe(2);
    const badRole = await e.run([
      'constellation',
      'invite',
      'oort-core',
      'a@b.io',
      '--role',
      'owner',
    ]);
    expect(badRole.code).toBe(2);
    expect(badRole.io.stderr).toContain('--role must be one of maintainer, member, reader');
    expect(e.cloud.seen.filter((s) => s.includes('/invites'))).toEqual([]);
  });

  it('invite.shows-the-apis-refusals-for-roles-and-plan-limits', async () => {
    const e = setup();
    team(e, 'member', false);
    const member = await e.run(['constellation', 'invite', 'oort-core', 'a@b.io']);
    expect(member.code).toBe(2);
    expect(member.io.stderr).toContain('Only a maintainer of this Constellation can do that.');
    const full = setup();
    team(full);
    full.cloud.hive.memberLimit = 2;
    const r = await full.run(['constellation', 'invite', 'oort-core', 'a@b.io']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('This Constellation is full on your plan.');
  });

  it('invites.lists-and-revokes-open-invites', async () => {
    const e = setup();
    team(e);
    await e.run(['constellation', 'invite', 'oort-core', 'sam@example.com']);
    const list = await e.run(['constellation', 'invites', 'oort-core']);
    expect(list.io.stdout).toContain('i_1  sa…@example.com  member');
    const revoked = await e.run(['constellation', 'revoke', 'oort-core', 'i_1']);
    expect(revoked.io.stdout).toContain('Revoked invite "i_1".');
    expect((await e.run(['constellation', 'invites', 'oort-core'])).io.stdout).toContain(
      'No open invites.',
    );
  });

  it('join.opens-the-invite-page-and-never-calls-the-api', async () => {
    const token = `oort_iv_${'x'.repeat(43)}`;
    expect(inviteToken(`https://oortcloud.dev/invite#${token}`)).toBe(token);
    expect(inviteToken(token)).toBe(token);
    expect(inviteToken('https://evil.example/invite#nope')).toBeNull();
    const e = setup();
    const r = await e.run(['constellation', 'join', `https://oortcloud.dev/invite#${token}`], {
      tty: true,
    });
    expect(r.code).toBe(0);
    expect(e.opened).toEqual([`https://oortcloud.dev/invite#${token}`]);
    const printed = await e.run(['constellation', 'join', token]);
    expect(printed.io.stdout).toContain(`https://oortcloud.dev/invite#${token}`);
    expect(e.cloud.seen).toEqual([]);
    expect((await e.run(['constellation', 'join', 'garbage'])).code).toBe(2);
  });
});

describe('oort constellation members, roles and leaving (CON-64)', () => {
  it('members.lists-roles-owner-and-agents-never-an-account', async () => {
    const e = setup();
    team(e);
    e.cloud.hive.stars.set(C, new Map([['claude-code', ['read']]]));
    const r = await e.run(['constellation', 'members', 'oort-core']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain('mb_you000000001  you  maintainer (owner)');
    expect(r.io.stdout).toContain('agents: claude-code (read)');
    expect(r.io.stdout).toContain('mb_maya00000002  ma…@example.com  member');
    expect(r.io.stdout).not.toContain('a1');
  });

  it('remove.asks-first-and-never-prompts-without-a-terminal', async () => {
    const e = setup();
    team(e);
    const noTty = await e.run(['constellation', 'remove', 'oort-core', 'mb_maya00000002']);
    expect(noTty.code).toBe(2);
    expect(noTty.io.stderr).toContain('--yes');
    expect(e.cloud.hive.members.get(C)).toHaveLength(2);
    const no = await e.run(['constellation', 'remove', 'oort-core', 'mb_maya00000002'], {
      tty: true,
      answer: 'n',
    });
    expect(no.io.stdout).toContain('Nobody was removed.');
    const yes = await e.run(['constellation', 'remove', 'oort-core', 'maya@example.com', '--yes']);
    expect(yes.code, yes.io.stderr).toBe(0);
    expect(yes.io.stdout).toContain('access ends within a minute');
    expect(e.cloud.seen).toContain(
      `DELETE /v1/constellations/oort-core/members/maya%40example.com`,
    );
    expect(e.cloud.hive.members.get(C)).toHaveLength(1);
  });

  // CON-107: each Constellation command that asks first refuses without a terminal on stdin
  // (exit 2, no prompt), exits 0 when declined, and asks on stderr even with stdout piped (the
  // question never on stdout), acting on yes. --yes is covered by the tests around this one.
  it.each([
    { cmd: ['remove', 'oort-core', 'mb_maya00000002'], role: 'maintainer', owner: true },
    { cmd: ['leave', 'oort-core'], role: 'member', owner: false },
    { cmd: ['transfer', 'oort-core', 'mb_maya00000002'], role: 'maintainer', owner: true },
    { cmd: ['delete', 'oort-core'], role: 'maintainer', owner: true },
  ])('confirm.constellation-$cmd.0-no-tty-declined-piped-yes', async ({ cmd, role, owner }) => {
    const e = setup();
    team(e, role, owner);
    const args = ['constellation', ...cmd];
    const changes = (): string[] => e.cloud.seen.filter((s) => !s.startsWith('GET '));
    expectRefusedWithoutPrompt(await e.run(args), NO_TTY_STDIN);
    const no = await e.run(args, { tty: true, answer: 'n' });
    expectDeclined(no);
    expect(changes()).toEqual([]);
    const piped = await e.run(args, PIPED_YES);
    expectAsked(piped);
    expect(changes()).toHaveLength(1);
  });

  it('remove.the-owner-is-refused-with-the-apis-message', async () => {
    const e = setup();
    team(e);
    const r = await e.run(['constellation', 'remove', 'oort-core', 'mb_you000000001', '--yes']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('The owner stays a maintainer.');
  });

  it('role.changes-a-role-and-validates-it', async () => {
    const e = setup();
    team(e);
    const r = await e.run(['constellation', 'role', 'oort-core', 'mb_maya00000002', 'reader']);
    expect(r.io.stdout).toContain('mb_maya00000002 is now a reader');
    expect(
      (await e.run(['constellation', 'role', 'oort-core', 'mb_maya00000002', 'god'])).code,
    ).toBe(2);
  });

  it('leave.the-owner-cannot-leave-a-member-can', async () => {
    const owner = setup();
    team(owner);
    const r = await owner.run(['constellation', 'leave', 'oort-core', '--yes']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('Transfer ownership or delete the Constellation.');
    const member = setup();
    team(member, 'member', false);
    const left = await member.run(['constellation', 'leave', 'oort-core', '--yes']);
    expect(left.code, left.io.stderr).toBe(0);
    expect(left.io.stdout).toContain('Left "oort-core".');
  });

  it('transfer-and-delete.are-the-owners', async () => {
    const e = setup();
    team(e);
    const t = await e.run(['constellation', 'transfer', 'oort-core', 'mb_maya00000002', '--yes']);
    expect(t.io.stdout).toContain('mb_maya00000002 now owns "oort-core".');
    // No longer the owner: delete is refused with the API's message.
    const d = await e.run(['constellation', 'delete', 'oort-core', '--yes']);
    expect(d.code).toBe(2);
    expect(d.io.stderr).toContain('Only the owner can delete it.');
    const fresh = setup();
    team(fresh);
    expect((await fresh.run(['constellation', 'delete', 'oort-core'])).code).toBe(2);
    const ok = await fresh.run(['constellation', 'delete', 'oort-core', '--yes']);
    expect(ok.io.stdout).toContain('Deleted "oort-core" (0 memories)');
  });

  it('policy.needs-exactly-one-flag', async () => {
    const e = setup();
    team(e);
    expect((await e.run(['constellation', 'policy', 'oort-core'])).code).toBe(2);
    expect(
      (await e.run(['constellation', 'policy', 'oort-core', '--open', '--confirm'])).code,
    ).toBe(2);
    const r = await e.run(['constellation', 'policy', 'oort-core', '--open']);
    expect(r.io.stdout).toContain('now uses the open policy');
    const reader = setup();
    team(reader, 'reader', false);
    const refused = await reader.run(['constellation', 'policy', 'oort-core', '--confirm']);
    expect(refused.io.stderr).toContain('Only a maintainer');
  });

  it('project.link-constellation-binds-this-project', async () => {
    const e = setup();
    team(e);
    fs.mkdirSync(path.join(e.cwd, '.git'));
    const r = await e.run(['project', 'link', '--constellation', 'oort-core']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain('Bound project');
    expect([...(e.cloud.hive.projects.get(C) ?? [])]).toHaveLength(1);
    const u = await e.run(['project', 'unlink', '--constellation', 'oort-core']);
    expect(u.io.stdout).toContain('no longer bound');
    expect([...(e.cloud.hive.projects.get(C) ?? [])]).toHaveLength(0);
  });
});

describe('oort constellation attach and agents (CON-64)', () => {
  it('attach.a-star-gets-only-what-its-owner-has', async () => {
    const e = setup();
    team(e, 'member', false);
    const r = await e.run(['constellation', 'attach', 'oort-core', '--agent', 'cursor', '--share']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain('cursor can now read and share into "oort-core".');
    // A maintainer's agent asking for share gets read and share, never maintain.
    expect(e.cloud.hive.stars.get(C)?.get('cursor')).toEqual(['read', 'share']);
    const d = await e.run(['constellation', 'detach', 'oort-core', '--agent', 'cursor']);
    expect(d.io.stdout).toContain('cursor no longer reads "oort-core".');
    const bad = await e.run(['constellation', 'attach', 'oort-core', '--agent', 'Not An Agent']);
    expect(bad.code).toBe(2);
    expect(
      (await e.run(['constellation', 'attach', 'oort-core', '--agent', 'anonymous'])).code,
    ).toBe(2);
  });

  it('attach.reader-is-refused-with-the-apis-message', async () => {
    const e = setup();
    team(e, 'reader', false);
    const r = await e.run(['constellation', 'attach', 'oort-core', '--agent', 'cursor']);
    expect(r.code).toBe(2);
    expect(r.io.stderr).toContain('Readers cannot attach agents.');
  });

  it('recall.as-an-agent-sends-it-and-reads-only-attached-constellations', async () => {
    const e = setup();
    team(e);
    e.cloud.hive.shared.set('copy-1', {
      ...fakeMemory({ id: 'copy-1', text: 'The team deploys with wrangler.' }),
      constellation: C,
      sourceId: 'src',
    });
    const before = await e.run(['--agent', 'cursor', 'recall', 'deploys wrangler', '--json']);
    expect(before.code, before.io.stderr).toBe(0);
    expect(e.cloud.recalls.at(-1)).toMatchObject({ agent: 'cursor' });
    expect(before.io.stdout).not.toContain('copy-1');
    await e.run(['constellation', 'attach', 'oort-core', '--agent', 'cursor']);
    const after = await e.run(['--agent', 'cursor', 'recall', 'deploys wrangler', '--json']);
    expect(after.io.stdout).toContain('copy-1');
    // No agent named: the person reads every Constellation, and no agent is sent.
    const anon = await e.run(['recall', 'deploys wrangler', '--json']);
    expect(e.cloud.recalls.at(-1)).not.toHaveProperty('agent');
    expect(anon.io.stdout).toContain('copy-1');
  });

  it('hooks.recall-as-claude-code', async () => {
    const e = setup();
    team(e);
    const stdin = JSON.stringify({
      session_id: 's1',
      cwd: e.cwd,
      prompt: 'how do we deploy oortcloud?',
    });
    const r = await e.run(['hook', 'UserPromptSubmit'], { stdin });
    expect(r.code).toBe(0);
    expect(e.cloud.recalls.at(-1)).toMatchObject({ agent: 'claude-code' });
  });
});

describe('oort keys create (CON-64)', () => {
  it('keys.scope-parsing', () => {
    expect(parseKeyScope('planet')).toEqual(['planet']);
    expect(parseKeyScope('planet, checkout:read ,oort-core:share')).toEqual([
      'planet',
      'checkout:read',
      'oort-core:share',
    ]);
    expect(() => parseKeyScope('checkout:read')).toThrow(/start --scope with planet/);
    expect(() => parseKeyScope('planet,checkout:write')).toThrow(/not planet or/);
    expect(() => parseKeyScope('')).toThrow();
  });

  it('keys.create-sends-the-scope-and-shows-the-key-once', async () => {
    const e = setup();
    team(e);
    const r = await e.run(['keys', 'create', '--name', 'ci', '--scope', 'planet,oort-core:read']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(e.cloud.keyRequests).toEqual([{ name: 'ci', scope: ['planet', 'oort-core:read'] }]);
    expect(r.io.stdout).toMatch(/^oort_sk_made/);
    expect(r.io.stdout).toContain(`planet, ${C}:read`);
    expect(r.io.stdout).toContain('only time the key is shown');
    const full = await e.run(['keys', 'create', '--json']);
    expect(data(full.io.stdout)).toMatchObject({ scope: null });
    expect(e.cloud.keyRequests.at(-1)).toEqual({});
    const bad = await e.run(['keys', 'create', '--scope', 'oort-core']);
    expect(bad.code).toBe(2);
    expect(e.cloud.keyRequests).toHaveLength(2);
  });
});

describe('oort whoami and doctor list spaces (CON-64)', () => {
  it('whoami.cloud-lists-spaces-and-roles-for-the-agent', async () => {
    const e = setup();
    team(e, 'member', false);
    const r = await e.run(['whoami']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain('your Planet');
    expect(r.io.stdout).toContain('Constellation oort-core (member: read, share)');
    expect(e.cloud.whoamiAgents).toEqual([null]);
    const asCursor = await e.run(['--agent', 'cursor', 'whoami', '--json']);
    expect(e.cloud.whoamiAgents.at(-1)).toBe('cursor');
    expect(data(asCursor.io.stdout).spaces).toEqual([{ level: 'planet' }]);
    e.cloud.narrowed = true;
    expect((await e.run(['whoami'])).io.stdout).toContain('narrowed to the spaces below');
  });

  it('whoami.local-lists-the-planet-and-the-agents-star', async () => {
    const e = setup('local');
    const r = await e.run(['--agent', 'cursor', 'whoami', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(data(r.io.stdout)).toMatchObject({
      mode: 'local',
      agent: 'cursor',
      spaces: [{ level: 'planet' }, { level: 'star', agent: 'cursor' }],
    });
    expect(e.cloud.seen).toEqual([]);
  });

  it('doctor.lists-cloud-spaces', async () => {
    const e = setup();
    team(e);
    const r = await e.run(['doctor', '--json']);
    const { checks } = data(r.io.stdout) as {
      checks: { group: string; name: string; detail: string }[];
    };
    const spaces = checks.find((c) => c.group === 'cloud' && c.name === 'spaces');
    expect(spaces?.detail).toContain('Constellation oort-core (maintainer: read, share, maintain)');
  });
});

describe('oort mcp in cloud mode: spaces from whoami (CON-64)', () => {
  it('mcp.cloud-spaces-follow-the-agents-attachments', async () => {
    const e = setup();
    team(e, 'member', false);
    const wired = (agent?: string) =>
      realWire(e.cwd, {
        env: { HOME: e.root, OORT_HOME: e.home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: e.key },
        keychain: async () => undefined,
        fetch: e.cloud.fetch,
        ...(agent !== undefined && { agent }),
      });
    const cursor = await wired('cursor');
    expect(await cloudSpaces(cursor, cursor.cloud!)).toEqual({
      include: ['planet'],
      visibility: [],
      share: [],
    });
    e.cloud.hive.stars.set(C, new Map([['cursor', ['read', 'share']]]));
    expect(await cloudSpaces(cursor, cursor.cloud!)).toEqual({
      include: ['planet', 'constellation'],
      visibility: ['oort-core'],
      share: [],
    });
    expect(e.cloud.whoamiAgents.at(-1)).toBe('cursor');
    // remember for a Constellation saves privately and says the share needs a person.
    const backend = cloudBackend({ wired: cursor, client: cursor.cloud! });
    const r = await backend.remember({
      facts: ['We cut releases on Tuesdays.'],
      visibility: 'oort-core',
    });
    expect(r.note).toMatch(/Saved privately to your Planet\. Sharing it with oort-core needs/);
    expect(e.cloud.hive.requests).toEqual([]);
    // The cloud being unreachable falls back to the Planet alone.
    e.cloud.refuse = { status: 503, code: 'unavailable', message: 'down' };
    expect((await cloudSpaces(cursor, cursor.cloud!)).include).toEqual(['planet']);
    await cursor.close();
  });
});

describe('server strings never reach the terminal raw (CON-64 review)', () => {
  const ESC = '\u001b';
  const CSI = '\u009b';
  const raw = (s: string) => s.includes(ESC) || s.includes(CSI);

  it('display.shown-escapes-controls-and-never-truncates', () => {
    expect(shown(`a${ESC}[2Jb${CSI}31mc\u202ed`)).toBe('a\\u{1b}[2Jb\\u{9b}31mc\\u{202e}d');
    expect(shown('x'.repeat(500))).toHaveLength(500);
    expect(shown('one\ntwo', { newlines: true })).toBe('one\ntwo');
    expect(shown('one\ntwo')).toBe('one\\u{a}two');
    expect(raw(echo(`x${CSI}y`))).toBe(false);
  });

  it('display.shown-covers-the-shared-set-including-invisible-characters', () => {
    // The same list as Oort Cloud's DISPLAY_UNSAFE_SAMPLES and the site's (CON-64 fix wave).
    expect([...DISPLAY_UNSAFE_SAMPLES]).toEqual([
      0x00, 0x1b, 0x1f, 0x7f, 0x9b, 0x9f, 0x61c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a,
      0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0xfeff,
    ]);
    for (const cp of DISPLAY_UNSAFE_SAMPLES) {
      expect(shown(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe(
        `a\\u{${cp.toString(16)}}b`,
      );
    }
    for (const fine of ['é', '中', 'ß', '\u00a0', '\u2010', '\u2070', '\u2065', 'a.b-c']) {
      expect(shown(fine)).toBe(fine);
    }
  });

  it('display.members-and-agents-with-escape-sequences-are-printed-escaped', async () => {
    const e = setup();
    team(e);
    e.cloud.hive.members.get(C)![1]!.email = `ev${ESC}[2J@example.com`;
    e.cloud.hive.stars.set(C, new Map([[`cur${CSI}2Jsor`, ['read']]]));
    const r = await e.run(['constellation', 'members', 'oort-core']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(raw(r.io.stdout)).toBe(false);
    expect(r.io.stdout).toContain('ev\\u{1b}[2J@example.com');
    expect(r.io.stdout).toContain('cur\\u{9b}2Jsor');
    // JSON output stays JSON: escaped by JSON, the value intact when parsed.
    const j = await e.run(['constellation', 'members', 'oort-core', '--json']);
    expect(j.io.stdout.includes(ESC)).toBe(false);
    expect(data<{ members: { email: string | null }[] }>(j.io.stdout).members[1]!.email).toBe(
      `ev${ESC}[2J@example.com`,
    );
  });

  it('display.invites-whoami-and-api-messages-are-printed-escaped', async () => {
    const e = setup();
    team(e);
    e.cloud.hive.memberLimit = 10;
    e.cloud.hive.constellations.get(C)!.name = `oort${ESC}]0;pwned${ESC}\\`;
    const inv = await e.run(['constellation', 'invite', C, 'sam@example.com']);
    expect(inv.code, inv.io.stderr).toBe(0);
    expect(raw(inv.io.stdout)).toBe(false);
    const list = await e.run(['constellation', 'invites', C]);
    expect(raw(list.io.stdout)).toBe(false);
    const me = await e.run(['whoami']);
    expect(raw(me.io.stdout)).toBe(false);
    expect(me.io.stdout).toContain('oort\\u{1b}]0;pwned');
    const doc = await e.run(['doctor']);
    expect(raw(doc.io.stdout)).toBe(false);
    e.cloud.refuse = { status: 403, code: 'role_required', message: `No${ESC}[2J${CSI}K way.` };
    const refused = await e.run(['constellation', 'invites', C]);
    expect(refused.code).toBe(2);
    expect(raw(refused.io.stderr)).toBe(false);
    expect(refused.io.stderr).toContain('No\\u{1b}[2J\\u{9b}K way.');
  });
});
