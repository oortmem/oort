import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeCloud, type FakeCloud } from '../test/fake-cloud.js';
import { fakeIo, tmpdir } from '../test/helpers.js';
import { writeCloudSettings } from './cloud.js';
import { GALAXY_PAGE, galaxyLine, resolveGalaxy } from './commands/galaxy.js';
import { createKeychain } from './keychain.js';
import { runCli } from './program.js';
import { wire as realWire, type WireFn } from './wire.js';

/**
 * Galaxies from the command line (CON-97): list, members, create (on oortcloud.dev), creating a
 * Constellation in a Galaxy, and the Galaxies whoami and doctor list. Every rule is the API's; the
 * fake cloud follows cloud-contract.json.
 */
const oortKey = (): string => ['oort', 'sk', `galx${Date.now()}`.padEnd(43, 'G')].join('_');
const G = 'g_aaaaaaaaaaaaaaaa';

function setup() {
  const root = tmpdir();
  const home = path.join(root, 'oort-home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const key = oortKey();
  const cloud: FakeCloud = fakeCloud(key);
  writeCloudSettings(home, { store: 'cloud' });
  const wire: WireFn = (dir, o = {}) =>
    realWire(dir, { ...o, keychain: async () => undefined, fetch: cloud.fetch });
  const opened: string[] = [];
  const run = async (args: string[], opts: { tty?: boolean } = {}) => {
    const io = fakeIo({
      cwd,
      env: { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: key },
      ...(opts.tty !== undefined && { tty: opts.tty, stdoutTTY: opts.tty }),
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
  return { cloud, run, opened };
}

function acme(e: ReturnType<typeof setup>, role = 'admin') {
  e.cloud.hive.enabled = true;
  e.cloud.hive.galaxies.set(G, {
    id: G,
    name: 'Acme',
    slug: 'acme',
    role,
    members: 3,
    constellations: 1,
  });
  e.cloud.hive.galaxyMembers.set(G, [
    {
      member: 'gm_000000000001',
      role: 'owner',
      you: false,
      email: 'ma…@acme.dev',
      joinedAt: '2026-11-01T00:00:00.000Z',
    },
    {
      member: 'gm_000000000002',
      role,
      you: true,
      email: 'yo…@acme.dev',
      joinedAt: '2026-11-02T00:00:00.000Z',
    },
    {
      member: 'gm_000000000003',
      role: 'member',
      you: false,
      email: null,
      joinedAt: '2026-11-03T00:00:00.000Z',
    },
  ]);
}

describe('oort galaxy (CON-97)', () => {
  it('galaxy.list-shows-galaxies-and-your-role', async () => {
    const e = setup();
    acme(e);
    const r = await e.run(['galaxy', 'list']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toMatch(/Acme {2}admin {2}3 people {2}1 Constellation {2}acme/);
    const j = await e.run(['galaxy', 'list', '--json']);
    expect(JSON.parse(j.io.stdout)).toEqual([
      { id: G, name: 'Acme', slug: 'acme', role: 'admin', members: 3, constellations: 1 },
    ]);
    // `oort galaxy` alone lists too.
    expect((await e.run(['galaxy'])).io.stdout).toContain('Acme');
  });

  it('galaxy.list-is-empty-or-refused-outside-the-beta', async () => {
    const e = setup();
    e.cloud.hive.enabled = true;
    const none = await e.run(['galaxy', 'list']);
    expect(none.code).toBe(0);
    expect(none.io.stdout).toContain('oort galaxy create <name>');
    e.cloud.hive.enabled = false;
    const off = await e.run(['galaxy', 'list']);
    expect(off.code).not.toBe(0);
    expect(off.io.stderr).toContain('invite-only beta');
  });

  it('galaxy.members-lists-people-and-roles-by-slug-name-or-id', async () => {
    const e = setup();
    acme(e);
    for (const ref of ['acme', 'Acme', G]) {
      const r = await e.run(['galaxy', 'members', ref]);
      expect(r.code, r.io.stderr).toBe(0);
      expect(r.io.stdout).toContain('gm_000000000001  owner  ma…@acme.dev  joined 2026-11-01');
      expect(r.io.stdout).toContain('gm_000000000002  admin  you');
      expect(r.io.stdout).toContain('gm_000000000003  member  a member');
    }
    const j = JSON.parse((await e.run(['galaxy', 'members', 'acme', '--json'])).io.stdout) as {
      galaxy: unknown;
      members: unknown[];
    };
    expect(j.galaxy).toEqual({ id: G, name: 'Acme', slug: 'acme', role: 'admin' });
    expect(j.members).toHaveLength(3);
    const missing = await e.run(['galaxy', 'members', 'nope']);
    expect(missing.code).not.toBe(0);
    expect(missing.io.stderr).toContain('No such Galaxy');
  });

  it('galaxy.server-strings-are-shown-safely', async () => {
    const e = setup();
    acme(e);
    const esc = String.fromCodePoint(0x1b);
    const rlo = String.fromCodePoint(0x202e);
    e.cloud.hive.galaxies.get(G)!.name = `Ac${esc}[2Jme${rlo}`;
    e.cloud.hive.galaxyMembers.get(G)![0]!['email'] = `x${esc}]0;pwned${String.fromCodePoint(7)}`;
    const list = await e.run(['galaxy', 'list']);
    const members = await e.run(['galaxy', 'members', G]);
    const json = await e.run(['galaxy', 'list', '--json']);
    for (const out of [list.io.stdout, members.io.stdout, json.io.stdout]) {
      expect(out).not.toContain(esc);
      expect(out).not.toContain(rlo);
    }
    expect(list.io.stdout).toContain('\\u{1b}[2J');
    expect(galaxyLine({ id: G, name: `a${rlo}`, slug: null, role: 'owner' })).toBe(
      `Galaxy a\\u{202e} (${G}, owner)`,
    );
  });

  it('galaxy.create-opens-the-dashboard-page-or-prints-it', async () => {
    const e = setup();
    const tty = await e.run(['galaxy', 'create', 'Acme Labs'], { tty: true });
    expect(tty.code, tty.io.stderr).toBe(0);
    expect(e.opened).toEqual([`${GALAXY_PAGE}?name=Acme%20Labs`]);
    expect(tty.io.stdout).toContain('Opened oortcloud.dev');
    const piped = await e.run(['galaxy', 'create', 'Acme Labs']);
    expect(piped.io.stdout).toContain(`${GALAXY_PAGE}?name=Acme%20Labs`);
    expect(e.opened).toHaveLength(1);
    const nob = await e.run(['galaxy', 'create', 'Acme', '--no-browser'], { tty: true });
    expect(nob.io.stdout).toContain(`${GALAXY_PAGE}?name=Acme`);
    expect(e.opened).toHaveLength(1);
    // Creating needs no API call: the signed-in site makes the Organization.
    expect(e.cloud.seen.filter((s) => s.includes('galax'))).toEqual([]);
  });

  it('constellation.create-in-a-galaxy-resolves-it-and-sends-its-id', async () => {
    const e = setup();
    acme(e, 'member');
    const refused = await e.run(['constellation', 'create', 'acme-core', '--galaxy', 'acme']);
    expect(refused.code).not.toBe(0);
    expect(refused.io.stderr).toContain('Only an admin of Acme');
    e.cloud.hive.galaxies.get(G)!.role = 'admin';
    const made = await e.run(['constellation', 'create', 'acme-core', '--galaxy', 'Acme']);
    expect(made.code, made.io.stderr).toBe(0);
    expect(made.io.stdout).toContain('in Galaxy Acme (acme, admin)');
    // The slug or name is resolved here; the API gets the id.
    expect(e.cloud.hive.creates.at(-1)).toEqual({ name: 'acme-core', galaxy: G });
    const missing = await e.run(['constellation', 'create', 'x', '--galaxy', 'nope']);
    expect(missing.code).not.toBe(0);
    expect(missing.io.stderr).toContain('No such Galaxy');
    // Without --galaxy nothing changes: the request carries no galaxy.
    e.cloud.hive.constellations.clear();
    await e.run(['constellation', 'create', 'solo']);
    expect(e.cloud.hive.creates.at(-1)).toEqual({ name: 'solo' });
  });

  it('constellation.create-refuses-a-galaxy-reference-that-matches-two', async () => {
    const e = setup();
    acme(e);
    // Another Galaxy is called "acme", which is the first one's slug.
    const B = 'g_bbbbbbbbbbbbbbbb';
    e.cloud.hive.galaxies.set(B, {
      id: B,
      name: 'acme',
      slug: 'beta',
      role: 'admin',
      members: 1,
      constellations: 0,
    });
    const before = e.cloud.hive.creates.length;
    const r = await e.run(['constellation', 'create', 'core', '--galaxy', 'acme']);
    expect(r.code).not.toBe(0);
    expect(r.io.stderr).toContain(G);
    expect(r.io.stderr).toContain(B);
    expect(e.cloud.hive.creates.length).toBe(before);
    const byId = await e.run(['constellation', 'create', 'core', '--galaxy', B]);
    expect(byId.code, byId.io.stderr).toBe(0);
    expect(e.cloud.hive.creates.at(-1)).toEqual({ name: 'core', galaxy: B });
  });

  it('whoami-and-doctor-list-your-galaxies', async () => {
    const e = setup();
    acme(e);
    const w = await e.run(['whoami']);
    expect(w.code, w.io.stderr).toBe(0);
    expect(w.io.stdout).toContain('Galaxy Acme (acme, admin)');
    const wj = JSON.parse((await e.run(['whoami', '--json'])).io.stdout) as { galaxies: unknown };
    expect(wj.galaxies).toEqual([{ id: G, name: 'Acme', slug: 'acme', role: 'admin' }]);
    const d = await e.run(['doctor', '--json']);
    const { checks } = JSON.parse(d.io.stdout) as {
      checks: { group: string; name: string; detail: string }[];
    };
    expect(checks.find((c) => c.group === 'cloud' && c.name === 'galaxies')?.detail).toBe(
      'Galaxy Acme (acme, admin)',
    );
    // No Galaxy: no galaxies check, and whoami lists none.
    e.cloud.hive.galaxies.clear();
    const d2 = JSON.parse((await e.run(['doctor', '--json'])).io.stdout) as {
      checks: { name: string }[];
    };
    expect(d2.checks.some((c) => c.name === 'galaxies')).toBe(false);
  });

  it('galaxy.members-marks-pending-people', async () => {
    const e = setup();
    acme(e);
    e.cloud.hive.galaxyMembers.get(G)![2]!['pending'] = true;
    const r = await e.run(['galaxy', 'members', 'acme']);
    expect(r.io.stdout).toContain(
      'gm_000000000003  member  a member  joined 2026-11-03  (pending: not joined yet)',
    );
    expect(r.io.stdout).not.toMatch(/gm_000000000001.*pending/);
  });

  it('galaxy.counts-and-names-from-the-server-are-never-trusted', async () => {
    const e = setup();
    acme(e);
    const g = e.cloud.hive.galaxies.get(G)! as unknown as Record<string, unknown>;
    g['members'] = '3\u001b[2J';
    g['constellations'] = { evil: true };
    const r = await e.run(['galaxy', 'list']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).not.toContain(String.fromCodePoint(0x1b));
    expect(r.io.stdout).toContain('NaN people  NaN Constellations');
    // A Galaxy without a string name can't be matched, and never throws.
    const odd = [
      {
        id: 'g_cccccccccccccccc',
        name: 42,
        slug: null,
        role: 'admin',
        members: 1,
        constellations: 0,
      },
    ];
    expect(() => resolveGalaxy(odd as never, 'acme')).toThrow('No such Galaxy');
    expect(resolveGalaxy(odd as never, 'g_cccccccccccccccc').id).toBe('g_cccccccccccccccc');
  });
});
