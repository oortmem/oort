import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionController, Observation } from '@oortmem/core';
import { TG } from '@oortmem/core/store-conformance';
import { writeCloudSettings } from '../cloud.js';
import { createKeychain } from '../keychain.js';
import { runCli } from '../program.js';
import { wire as realWire, type WireFn } from '../wire.js';
import {
  AWS_KEY,
  data,
  failed,
  fakeDecide,
  fakeIo,
  harness,
  tmpdir,
  type Harness,
} from '../../test/helpers.js';
import { fakeCloud } from '../../test/helpers/fake-cloud.js';

/**
 * CON-107 step 4: `oort remember "<fact>"` saves a fact the user states, as the MCP `remember`
 * tool and the SDK's `remember()` do: one observation framed as the user's statement ("Remember
 * this: …") acknowledged by the assistant ("Noted: …"), through the write path (scrub, gate,
 * reconcile, writer).
 */

/** The harness, with every observation the gate saw recorded. */
function gated(h: Harness): Observation[] {
  const seen: Observation[] = [];
  const base = h.wire;
  h.wire = async (dir, o) => {
    const w = await base(dir, o);
    const decide: DecisionController = {
      ...fakeDecide,
      async gate(obs, ...rest) {
        seen.push(obs);
        return fakeDecide.gate(obs, ...rest);
      },
    };
    return { ...w, decide };
  };
  return seen;
}

describe('oort remember', () => {
  it('saves the fact through the write path, framed as the MCP tool frames it', async () => {
    const h = harness();
    const seen = gated(h);
    const r = await h.run(['remember', 'We deploy on Fridays.']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.userText).toBe('Remember this: We deploy on Fridays.');
    expect(seen[0]!.assistantText).toBe('Noted: We deploy on Fridays.');
    const stored = await h.store.list(TG, {});
    expect(stored).toHaveLength(1);
    expect(r.io.stdout).toMatch(/^oort remember · added [0-9a-f]{8}/);
    expect(r.io.stdout).toContain(stored[0]!.id.slice(0, 8));
  });

  it('joins unquoted words into one fact, and --type adds the hint the SDK adds', async () => {
    const h = harness();
    const seen = gated(h);
    const r = await h.run(['remember', '--type', 'preference', 'I', 'prefer', 'pnpm']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(seen[0]!.userText).toBe('Remember this (a preference fact): I prefer pnpm');
    expect(seen[0]!.assistantText).toBe('Noted: I prefer pnpm');
    const bad = await h.run(['remember', '--type', 'gossip', 'x', '--json']);
    expect(failed(bad, 'usage', 'remember').message).toContain('--type');
  });

  it('--json: the oort.v1 envelope with the SDK result shape', async () => {
    const h = harness();
    const r = await h.run(['remember', 'The staging port is 5582.', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    const d = data<{ results: { fact: number; outcome: string; id?: string }[] }>(
      r.io.stdout,
      'remember',
    );
    expect(d.results).toEqual([{ fact: 0, outcome: 'added', id: expect.any(String) }]);
    // Human lines never reach stdout in JSON mode.
    expect(r.io.stdout).not.toContain('oort remember ·');
    expect(r.io.stderr).toContain('oort remember · added');
  });

  it('scrubs secrets before anything is stored', async () => {
    const h = harness();
    const seen = gated(h);
    const r = await h.run(['remember', `The CI key is ${AWS_KEY} for the deploy bot.`, '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).not.toContain(AWS_KEY);
    for (const o of seen) expect(JSON.stringify(o)).not.toContain(AWS_KEY);
    for (const m of await h.store.list(TG, {})) expect(m.text).not.toContain(AWS_KEY);
  });

  it('--dry-run reports what the scrubber would redact and touches nothing', async () => {
    const h = harness();
    const r = await h.run(['remember', `deploy key ${AWS_KEY}`, '--dry-run', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    const d = data(r.io.stdout, 'remember');
    expect(d.dryRun).toBe(true);
    expect(d.dropped).toBe(false);
    expect(d.redactions).toEqual([{ kind: 'aws-access-key', count: 2 }]);
    expect(h.wired).toBe(0);
    const plain = await h.run(['remember', 'nothing secret', '--dry-run']);
    expect(plain.code).toBe(0);
    expect(plain.io.stdout).toContain('nothing would be redacted');
    expect(h.wired).toBe(0);
  });

  it('refuses an empty, multi-line or over-long fact before wiring anything', async () => {
    const h = harness();
    for (const fact of ['   ', 'one\ntwo', 'x'.repeat(501)]) {
      const r = await h.run(['remember', fact, '--json']);
      expect(r.code, JSON.stringify(fact)).toBe(2);
      failed(r, 'usage', 'remember');
    }
    expect(h.wired).toBe(0);
  });

  it('without keys: needs-key, with the free local fix first', async () => {
    const h = harness({ adapters: false });
    const r = await h.run(['remember', 'We deploy on Fridays.', '--json']);
    expect(failed(r, 'needs-key', 'remember').fix).toBe('oort models pull');
  });

  it('acts as --agent, as observe does', async () => {
    const h = harness();
    const r = await h.run(['--agent', 'cursor', 'remember', 'We deploy on Fridays.']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(r.io.stdout).toContain('as cursor');
    const bad = await h.run(['--agent', 'Not An Agent!', 'remember', 'x', '--json']);
    failed(bad, 'usage', 'remember');
  });

  it('in Oort Cloud: one observe with the same framing, for this project', async () => {
    const root = tmpdir();
    const home = path.join(root, 'oort-home');
    const cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    const key = ['oort', 'sk', 'remember'.padEnd(43, 'R')].join('_');
    const cloud = fakeCloud(key);
    writeCloudSettings(home, { store: 'cloud' });
    const io = fakeIo({
      cwd,
      env: { HOME: root, OORT_HOME: home, OORT_NO_KEYCHAIN: '1', OORT_API_KEY: key },
    });
    const code = await runCli(
      ['remember', '--type', 'semantic', 'We deploy with wrangler.', '--json'],
      io,
      ((dir, o = {}) =>
        realWire(dir, { ...o, keychain: async () => undefined, fetch: cloud.fetch })) as WireFn,
      createKeychain({ platform: 'none' }),
      { fetch: cloud.fetch },
    );
    expect(code, io.stderr).toBe(0);
    expect(cloud.observed).toHaveLength(1);
    expect(cloud.observed[0]!['observation']).toMatchObject({
      user: 'Remember this (a semantic fact): We deploy with wrangler.',
      assistant: 'Noted: We deploy with wrangler.',
    });
    const d = data<{ results: { fact: number; outcome: string }[] }>(io.stdout, 'remember');
    expect(d.results[0]).toMatchObject({ fact: 0, outcome: expect.any(String) });
  });
});
