import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../../test/helpers.js';
import { fakeAdapters } from '../../test/helpers/sdk-fakes.js';
import { createOortWith } from './create.js';
import { OortRefusedError, OortUsageError } from './errors.js';
import type { Oort } from './types.js';

/** Recall feedback from code: an expert handle is a person, an agent handle waits for one. */

async function handles(): Promise<{ expert: Oort; agent: Oort; id: string }> {
  const root = tmpdir('oort-sdk-feedback-');
  const base = {
    mode: 'local' as const,
    home: path.join(root, 'home'),
    env: { HOME: root, OORT_NO_KEYCHAIN: '1' },
  };
  const deps = { adapters: fakeAdapters() };
  const expert = await createOortWith(
    { ...base, judge: { role: 'expert', operator: 'ada' } },
    deps as never,
  );
  const agent = await createOortWith(base, deps as never);
  const saved = await expert.remember(['The staging database is postgres 16.']);
  const id = saved.results[0]!.id!;
  return { expert, agent, id };
}

const contestedOf = async (oort: Oort, id: string) =>
  (await oort.recall('staging database')).memories.find((m) => m.id === id)?.contested;

describe('oort.feedback', () => {
  it('sdk.feedback-expert-counts-at-once-and-resolves', async () => {
    const { expert, id } = await handles();
    const r = await expert.feedback({ memoryId: id, signal: 'wrong', note: 'It is 17 now.' });
    expect(r).toMatchObject({ kept: true, feedback: { status: 'open', by: 'ada' } });
    expect(await contestedOf(expert, id)).toMatchObject({ signal: 'wrong', note: 'It is 17 now.' });
    const fid = r.kept ? r.feedback.id : '';
    const done = await expert.feedback.supersede(fid, 'The staging database is postgres 17.');
    expect(done.supersedes).toBe(id);
    expect(await contestedOf(expert, id)).toBeUndefined();
    await expect(expert.feedback.dismiss(fid)).rejects.toMatchObject({
      reason: 'already-resolved',
    });
  });

  it('sdk.feedback-agent-is-pending-and-cannot-resolve', async () => {
    const { expert, agent, id } = await handles();
    const r = await agent.feedback({ memoryId: id, signal: 'stale' });
    expect(r).toMatchObject({ kept: true, feedback: { status: 'pending', agentRecorded: true } });
    expect(await contestedOf(agent, id)).toBeUndefined();
    const fid = r.kept ? r.feedback.id : '';
    for (const call of [
      () => agent.feedback.confirm(fid),
      () => agent.feedback.retire(fid),
      () => agent.feedback.dismiss(fid),
      () => agent.feedback.supersede(fid, 'x'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(OortRefusedError);
    }
    const confirmed = await expert.feedback.confirm(fid.slice(0, 8));
    expect(confirmed).toMatchObject({ status: 'open', confirmed: { by: 'ada' } });
    expect(await contestedOf(agent, id)).toMatchObject({ signal: 'stale' });
    const retired = await expert.feedback.retire(fid);
    expect(retired).toMatchObject({ memoryId: id, endReason: 'expired' });
  });

  it('sdk.feedback-validates-input', async () => {
    const { expert, id } = await handles();
    await expect(expert.feedback({ memoryId: id, signal: 'nope' as never })).rejects.toBeInstanceOf(
      OortUsageError,
    );
    await expect(expert.feedback({ memoryId: id, signal: 'irrelevant' })).rejects.toBeInstanceOf(
      OortUsageError,
    );
    await expect(
      expert.feedback({ memoryId: id, signal: 'wrong', extra: 1 } as never),
    ).rejects.toBeInstanceOf(OortUsageError);
    const listed = await expert.feedback.list({ status: 'open' });
    expect(listed.feedback).toEqual([]);
  });
});
