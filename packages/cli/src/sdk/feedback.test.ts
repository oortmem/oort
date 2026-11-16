import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../../test/helpers.js';
import { fakeAdapters } from '../../test/helpers/sdk-fakes.js';
import { createOortWith } from './create.js';
import { feedbackView } from './feedback.js';
import { FeedbackError } from '@oortmem/core';
import { OortRefusedError, OortUsageError, toOortError } from './errors.js';
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
  it('sdk.feedback-a-project-b-handle-cannot-read-project-a-rows', async () => {
    const { expert } = await handles();
    const a = expert.scoped({ project: 'proj-a' });
    const b = expert.scoped({ project: 'proj-b' });
    const saved = await a.remember(['Acme renews in March.']);
    const r = await a.feedback({ memoryId: saved.results[0]!.id!, signal: 'wrong' });
    const fid = r.kept ? r.feedback.id : '';
    expect((await a.feedback.list({})).feedback.map((f) => f.id)).toEqual([fid]);
    expect((await b.feedback.list({})).feedback).toEqual([]);
    await expect(b.feedback.dismiss(fid)).rejects.toMatchObject({ code: 'not-found' });
  });

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

  it('sdk.feedback-view-shows-a-claim-and-who-started-it', () => {
    const base = {
      id: 'f1',
      scope: { orgId: 'local', customerId: 'self', agentId: 'a' },
      memoryId: 'm1',
      signal: 'wrong' as const,
      by: 'ada',
      via: 'cli' as const,
      revision: 2,
      createdAt: '2026-11-16T10:00:00.000Z',
      updatedAt: '2026-11-16T10:00:00.000Z',
    };
    const claim = {
      action: 'superseded' as const,
      by: 'ada',
      at: '2026-11-16T10:00:00.000Z',
      token: 't1',
      from: 'open' as const,
      fact: 'Port 8080',
      memoryId: 'n1',
    };
    const at = (min: number) => new Date(Date.parse(claim.at) + min * 60_000);
    const running = feedbackView({ ...base, status: 'resolving', claim }, at(2));
    expect(running.claim).toEqual({
      action: 'superseded',
      by: 'ada',
      at: claim.at,
      ageSeconds: 120,
      canTakeOver: false,
      fact: 'Port 8080',
      memoryId: 'n1',
    });
    expect(feedbackView({ ...base, status: 'resolving', claim }, at(5)).claim?.canTakeOver).toBe(
      true,
    );
    // Taken over at 6 minutes: its age, and when it can be taken over again, count from then.
    const taken = {
      ...claim,
      token: 't2',
      takenOverBy: 'grace',
      takenOverAt: at(6).toISOString(),
      undoing: true as const,
    };
    expect(feedbackView({ ...base, status: 'resolving', claim: taken }, at(8)).claim).toMatchObject(
      {
        by: 'ada',
        at: claim.at,
        takenOverBy: 'grace',
        takenOverAt: at(6).toISOString(),
        undoing: true,
        ageSeconds: 120,
        canTakeOver: false,
      },
    );
    expect(
      feedbackView({ ...base, status: 'resolving', claim: taken }, at(8)).claim,
    ).not.toHaveProperty('token');
    const done = feedbackView({
      ...base,
      status: 'superseded',
      resolved: { at: at(9).toISOString(), by: 'grace', claimedBy: 'ada', claimedAt: claim.at },
    });
    expect(done.resolved).toMatchObject({ by: 'grace', claimedBy: 'ada', claimedAt: claim.at });
  });

  it('sdk.feedback-errors-say-when-to-run-again', () => {
    const inProgress = toOortError(
      new FeedbackError('in-progress', 'Another call is resolving it.'),
    );
    expect(inProgress).toMatchObject({ code: 'refused', reason: 'in-progress', retryable: true });
    const conflict = toOortError(new FeedbackError('conflict', 'It changed.'));
    expect(conflict).toMatchObject({ reason: 'conflict', retryable: true });
    // A supersede whose new memory could not be taken back: look before running anything again.
    const changed = toOortError(
      new FeedbackError('memory-ended', 'The memory ended another way.', 'open', true),
    );
    expect(changed).toMatchObject({ reason: 'memory-changed', retryable: false });
  });
});
