import { describe, expect, it } from 'vitest';
import type { Feedback } from '@oortmem/core';
import { TG } from '@oortmem/core/store-conformance';
import { data, harness, memory, type Harness } from '../test/helpers.js';
import { localBackend } from './mcp.js';

/** `oort feedback`, its subcommands, and the MCP `feedback` tool against the local store. */

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';

async function seeded(): Promise<Harness> {
  const h = harness();
  await h.store.upsert(
    TG,
    memory({ id: ID, text: 'The auth service listens on port 5501 in staging.' }),
  );
  await h.store.upsert(
    TG,
    memory({ id: OTHER, text: 'The billing service listens on port 6601 in staging.' }),
  );
  return h;
}

async function give(h: Harness, args: string[]): Promise<Feedback & { id: string }> {
  const r = await h.run(['feedback', ...args, '--json']);
  expect(r.code, r.io.stderr).toBe(0);
  return data<{ feedback: Feedback }>(r.io.stdout).feedback;
}

async function recallText(h: Harness): Promise<string> {
  const r = await h.run(['recall', 'auth service port']);
  expect(r.code, r.io.stderr).toBe(0);
  return r.io.stdout;
}

describe('oort feedback', () => {
  it('cli.feedback-wrong-labels-recall-until-retired', async () => {
    const h = await seeded();
    const f = await give(h, [ID.slice(0, 8), 'wrong', '--note', 'It moved to 5502 in March.']);
    expect(f).toMatchObject({ signal: 'wrong', status: 'open', agentRecorded: false });

    expect(await recallText(h)).toContain('(contested: wrong, note: "It moved to 5502 in March.")');
    const json = await h.run(['recall', 'auth service port', '--json']);
    const hit = data<{ memories: { id: string; explanation: { contested?: unknown } }[] }>(
      json.io.stdout,
    ).memories.find((m) => m.id === ID);
    expect(hit?.explanation.contested).toMatchObject({ signal: 'wrong', feedbackId: f.id });
    // Feedback alone ends nothing.
    expect((await h.store.get(TG, ID))?.validTo).toBeNull();

    const r = await h.run(['feedback', 'retire', f.id.slice(0, 8), '--yes', '--json']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(data<{ endReason: string }>(r.io.stdout).endReason).toBe('corrected');
    const ended = await h.store.get(TG, ID);
    expect(ended?.endReason).toBe('corrected');
    expect(await recallText(h)).not.toContain('5501');

    // A second resolve reports where it stands and changes nothing.
    const again = await h.run(['feedback', 'dismiss', f.id.slice(0, 8), '--yes']);
    expect(again.code).toBe(2);
    expect(again.io.stderr).toMatch(/already resolved\. It is retired now\./);
  });

  it('cli.feedback-dismiss-removes-the-label', async () => {
    const h = await seeded();
    const f = await give(h, [ID, 'stale']);
    expect(await recallText(h)).toContain('(contested: stale)');
    const r = await h.run(['feedback', 'dismiss', f.id, '--yes']);
    expect(r.code, r.io.stderr).toBe(0);
    expect(await recallText(h)).not.toContain('contested');
    expect((await h.store.get(TG, ID))?.validTo).toBeNull();
  });

  it('cli.feedback-supersede-stores-the-right-fact', async () => {
    const h = await seeded();
    const f = await give(h, [ID, 'wrong']);
    const r = await h.run([
      'feedback',
      'supersede',
      f.id,
      'The auth service listens on port 5502 in staging.',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.io.stderr).toBe(0);
    const out = data<{ memoryId: string; supersedes: string }>(r.io.stdout);
    expect(out.supersedes).toBe(ID);
    expect((await h.store.get(TG, ID))?.endReason).toBe('superseded');
    const text = await recallText(h);
    expect(text).toContain('5502');
    expect(text).not.toContain('contested');
  });

  it('cli.feedback-helped-adds-accesses-once-a-day', async () => {
    const h = await seeded();
    const count = async () => (await h.store.get(TG, ID))!.accessLog.count;
    const before = await count();
    const a = await h.run(['feedback', ID, 'helped', '--json']);
    expect(data<{ applied: boolean }>(a.io.stdout).applied).toBe(true);
    const b = await h.run(['feedback', ID, 'helped', '--json']);
    expect(data<{ applied: boolean; reason: string }>(b.io.stdout)).toMatchObject({
      applied: false,
      reason: 'already-helped-today',
    });
    expect((await count()) - before).toBe(2);
  });

  it('cli.feedback-refuses-bad-input', async () => {
    const h = await seeded();
    const bad = await h.run(['feedback', ID, 'meh']);
    expect(bad.code).toBe(2);
    expect(bad.io.stderr).toMatch(/helped, wrong, stale, irrelevant/);
    const noQuery = await h.run(['feedback', ID, 'irrelevant']);
    expect(noQuery.code).toBe(2);
    expect(noQuery.io.stderr).toMatch(/query is required/);
    const ok = await give(h, [ID, 'irrelevant', '--query', 'billing port']);
    expect(ok).toMatchObject({ status: 'recorded', query: 'billing port' });
    const missing = await h.run(['feedback', 'ffffffff', 'wrong']);
    expect(missing.code).toBe(2);
  });

  it('cli.feedback-list-filters-by-status', async () => {
    const h = await seeded();
    await give(h, [ID, 'wrong']);
    await give(h, [OTHER, 'irrelevant', '--query', 'auth']);
    const open = await h.run(['feedback', 'list', '--status', 'open', '--json']);
    expect(data<{ feedback: Feedback[] }>(open.io.stdout).feedback.map((f) => f.memoryId)).toEqual([
      ID,
    ]);
    const all = await h.run(['feedback', 'list']);
    expect(all.code).toBe(0);
    expect(all.io.stdout).toContain(ID.slice(0, 8));
    expect(all.io.stdout).toContain(OTHER.slice(0, 8));
    const bad = await h.run(['feedback', 'list', '--status', 'nope']);
    expect(bad.code).toBe(2);
  });
});

describe('MCP feedback', () => {
  it('mcp.feedback-is-pending-until-a-person-confirms', async () => {
    const h = await seeded();
    const b = localBackend({ wired: await h.wire(h.cwd) });
    expect(b.feedback).toBeDefined();
    // A prefix is for people: an agent names the whole id.
    await expect(
      b.feedback!({ memory_id: ID.slice(0, 8), signal: 'wrong', note: 'moved' }),
    ).rejects.toThrow(/No memory with that id/);
    const r = await b.feedback!({ memory_id: ID, signal: 'wrong', note: 'moved' });
    expect(r).toMatchObject({ status: 'pending', memory_id: ID });
    expect(String(r['note'])).toMatch(/oort feedback confirm [0-9a-f]{8}/);

    // No label anywhere until a person confirms it.
    expect(await recallText(h)).not.toContain('contested');
    const recalled = await b.recall({ query: 'auth service port', limit: 5 } as never);
    expect(recalled.memories.find((m) => m.id === ID)?.contested).toBeUndefined();

    const id = String(r['feedback_id']);
    const c = await h.run(['feedback', 'confirm', id.slice(0, 8), '--yes', '--json']);
    expect(c.code, c.io.stderr).toBe(0);
    expect(data<{ feedback: Feedback }>(c.io.stdout).feedback.status).toBe('open');
    expect(await recallText(h)).toContain('(contested: wrong, note: "moved")');
    const after = await b.recall({ query: 'auth service port', limit: 5 } as never);
    expect(after.memories.find((m) => m.id === ID)?.contested).toMatchObject({
      signal: 'wrong',
      note: 'moved',
      feedback_id: id,
    });

    // Confirmed once: a second confirm is refused with where it stands.
    const twice = await h.run(['feedback', 'confirm', id, '--yes']);
    expect(twice.code).toBe(2);
    expect(twice.io.stderr).toMatch(/It is open now/);
  });

  it('mcp.feedback-helped-adds-nothing-until-confirmed', async () => {
    const h = await seeded();
    const b = localBackend({ wired: await h.wire(h.cwd) });
    const count = async () => (await h.store.get(TG, ID))!.accessLog.count;
    const before = await count();
    const r = await b.feedback!({ memory_id: ID, signal: 'helped' });
    expect(await count()).toBe(before);
    const c = await h.run(['feedback', 'confirm', String(r['feedback_id']), '--yes']);
    expect(c.code, c.io.stderr).toBe(0);
    expect(await count()).toBe(before + 2);
  });
});
