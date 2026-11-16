import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpdir } from '../../test/helpers.js';
import { fakeAdapters } from '../../test/helpers/sdk-fakes.js';
import { createOortWith } from './create.js';
import type { Oort } from './types.js';

/** `exportTraining` from code: expert role only, within the handle's grant. */

async function handles(): Promise<{ expert: Oort; agent: Oort; root: string }> {
  const root = tmpdir('oort-sdk-training-');
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
  return { expert, agent, root };
}

const rows = (file: string): Record<string, unknown>[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('oort.exportTraining', () => {
  it('sdk.training-export-refuses-an-agent-role-handle', async () => {
    const { agent, root } = await handles();
    const out = path.join(root, 'agent-out');
    await expect(agent.exportTraining({ kind: 'all', out })).rejects.toMatchObject({
      code: 'refused',
      reason: 'expert-only',
    });
    expect(fs.existsSync(out)).toBe(false);
    await agent.close();
  });

  it('sdk.training-export-writes-integration-labels-only-when-asked', async () => {
    const { expert, root } = await handles();
    await expert.judge.record({
      subject: 'Post claims a cure for diabetes',
      verdict: 'rejected',
      reason: 'A medical claim with no source.',
      domain: 'content',
      by: 'ada',
    });
    const agentScoped = expert.scoped({ judgeRole: 'agent' });
    await expect(
      agentScoped.exportTraining({ kind: 'sft', out: path.join(root, 'x') }),
    ).rejects.toMatchObject({ reason: 'expert-only' });

    // An expert-role handle records `integration`: left out by default, and counted.
    const plain = await expert.exportTraining({ kind: 'sft', out: path.join(root, 'default') });
    expect(plain.manifest.counts.sft?.rows).toBe(0);
    expect(plain.manifest.excluded.sft).toEqual({ 'origin-not-selected': 1 });

    const out = path.join(root, 'with-integration');
    const r = await expert.exportTraining({ kind: 'sft', out, include: ['integration'] });
    expect(r.dir).toBe(out);
    expect(rows(path.join(out, 'sft.jsonl'))).toMatchObject([
      {
        messages: [
          { role: 'user', content: 'Post claims a cure for diabetes' },
          {
            role: 'assistant',
            content: 'Verdict: rejected\nReason: A medical claim with no source.',
          },
        ],
        origin: 'integration',
      },
    ]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(out).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(out, 'sft.jsonl')).mode & 0o777).toBe(0o600);
    }
    await expect(
      expert.exportTraining({ kind: 'sft', out, include: ['integration'] }),
    ).rejects.toMatchObject({ code: 'refused', reason: 'export-exists' });
    await expect(
      expert.exportTraining({ kind: 'sft', out, include: ['integration'], force: true }),
    ).resolves.toMatchObject({ dir: out });
    await expect(
      expert.exportTraining({ kind: 'sft', out: path.join(root, 'y'), include: ['agent'] }),
    ).rejects.toMatchObject({ code: 'usage' });
    if (process.platform !== 'win32') {
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      await expect(
        expert.exportTraining({ kind: 'sft', out: shared, include: ['integration'] }),
      ).rejects.toMatchObject({ code: 'refused', reason: 'unsafe-directory' });
      expect(fs.statSync(shared).mode & 0o777).toBe(0o777);
    }
    const reasons = await expert.exportTraining({
      kind: 'preference',
      out: path.join(root, 'reasons'),
      preferenceReasons: true,
    });
    expect(reasons.manifest.filters.preferenceReasons).toBe(true);
    expect(reasons.manifest.notes).toHaveLength(1);
    await expert.close();
  });

  it('sdk.training-export-a-project-b-handle-exports-nothing-from-project-a', async () => {
    const { expert, root } = await handles();
    const a = expert.scoped({ project: 'proj-a' });
    const b = expert.scoped({ project: 'proj-b' });
    const saved = await a.remember(['The team orders lunch on Fridays.']);
    await a.feedback({
      memoryId: saved.results[0]!.id!,
      signal: 'irrelevant',
      query: 'auth service port',
    });
    const opts = { kind: 'retrieval' as const, include: ['integration' as const] };
    const fromB = await b.exportTraining({ ...opts, out: path.join(root, 'b') });
    expect(fromB.manifest.counts.retrieval?.rows).toBe(0);
    expect(fromB.manifest.excluded.retrieval).toEqual({});
    expect(fs.readFileSync(path.join(root, 'b', 'retrieval.jsonl'), 'utf8')).toBe('');
    const fromA = await a.exportTraining({ ...opts, out: path.join(root, 'a') });
    expect(rows(path.join(root, 'a', 'retrieval.jsonl'))).toMatchObject([
      { query: 'auth service port', positive: null, negative: 'The team orders lunch on Fridays.' },
    ]);
    expect(fromA.manifest.counts.retrieval?.rows).toBe(1);
    await expert.close();
  });
});
