import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localScope, type Memory, type Observation, type RecallResult } from '@oortmem/core';
import { makeMemory } from '@oortmem/core/store-conformance';
import { SESSION, makeDeps, queueLines, readLog, tempHome } from '../test/helpers.js';
import type { RemoteMemory } from './deps.js';
import { RECALL_TIMEOUT_MS, handleSessionStart, handleUserPromptSubmit } from './hooks.js';
import { drainQueue, enqueueObservations, turnRefOf } from './queue.js';

const CLOUD_MEMORY = makeMemory({
  id: 'm-cloud',
  text: 'The billing service deploys from the release branch.',
  stub: 'billing deploys from release',
  entities: ['billing'],
});

function result(memories: Memory[]): RecallResult {
  return {
    memories: memories.map((m) => ({
      ...m,
      explanation: { fused: 1, rrf: 1, coverage: 1, activation: 0, hydrated: false },
    })),
    timings: { totalMs: 3 },
  };
}

/** A remote that answers from fixed data and records every call. */
function fakeRemote(
  over: Partial<RemoteMemory> = {},
): RemoteMemory & { seen: string[]; refs: (string | undefined)[] } {
  const seen: string[] = [];
  const refs: (string | undefined)[] = [];
  return {
    seen,
    refs,
    recall: async (q) => {
      seen.push(`recall:${q.projectId ?? 'global'}`);
      return result([CLOUD_MEMORY]);
    },
    sessionMemories: async (q) => {
      seen.push(`session:${q.projectId ?? 'global'}`);
      return [{ ...CLOUD_MEMORY, pinned: true }];
    },
    observe: async (o, projectId, turnRef) => {
      seen.push(`observe:${o.turnRef ?? '?'}:${projectId ?? 'global'}`);
      refs.push(turnRef);
    },
    ...over,
  };
}

const ask = (cwd: string, text = 'how does billing deploy?') => ({
  prompt: text,
  cwd,
  session_id: SESSION,
});

function obs(i: number): Observation {
  return {
    userText: `question ${i}`,
    assistantText: `answer ${i}`,
    toolSummaries: [],
    sessionId: SESSION,
    turnRef: `a${i}`,
    at: new Date(Date.UTC(2026, 9, 1, 12, 0, i)).toISOString(),
  };
}

describe('hooks in cloud mode (CON-76)', () => {
  it('remote.prompt-recalls-from-the-cloud-not-the-local-store', async () => {
    const t = tempHome();
    const remote = fakeRemote();
    // No local adapters at all: cloud mode needs none.
    const deps = makeDeps(t, { remote, embed: undefined, rerank: undefined });
    const out = await handleUserPromptSubmit(ask(t.cwd), deps);
    expect(remote.seen).toEqual(['recall:global']);
    expect(out.stdout).toContain('billing service deploys from the release branch');
    expect(readLog(t.home).at(-1)).toMatchObject({ outcome: 'injected', counts: { memories: 1 } });
  });

  it('remote.prompt-logs-a-gate-miss-rerank (CON-131)', async () => {
    const t = tempHome();
    const remote = fakeRemote({
      recall: async () => ({
        ...result([CLOUD_MEMORY]),
        gateMiss: { reranked: true, topDense: 0.52, kept: 1 },
      }),
    });
    await handleUserPromptSubmit(ask(t.cwd), makeDeps(t, { remote }));
    const quiet = fakeRemote({
      recall: async () => ({
        memories: [],
        abstained: true,
        gateMiss: { reranked: false, topDense: 0.3, kept: 0 },
        timings: { totalMs: 3 },
      }),
    });
    await handleUserPromptSubmit(ask(t.cwd), makeDeps(t, { remote: quiet }));
    const [fired, below] = readLog(t.home).slice(-2);
    expect(fired?.counts).toMatchObject({ memories: 1, gateMissReranked: 1 });
    expect(below?.counts).toMatchObject({ abstained: 1, gateMiss: 1 });
    expect(below?.counts['gateMissReranked']).toBeUndefined();
  });

  it('remote.prompt-timeout-injects-nothing', async () => {
    const t = tempHome();
    const remote = fakeRemote({ recall: () => new Promise(() => {}) });
    const deps = makeDeps(t, { remote });
    const started = Date.now();
    const out = await handleUserPromptSubmit(ask(t.cwd), deps);
    expect(Date.now() - started).toBeGreaterThanOrEqual(RECALL_TIMEOUT_MS - 50);
    expect(out.stdout).toBe('');
    expect(readLog(t.home).at(-1)).toMatchObject({
      outcome: 'empty',
      degraded: ['cloud-timeout'],
    });
  }, 10_000);

  it('remote.prompt-error-injects-nothing-and-never-falls-back-to-local', async () => {
    const t = tempHome();
    const remote = fakeRemote({
      recall: async () => {
        throw Object.assign(new Error('refused'), { status: 402 });
      },
    });
    const deps = makeDeps(t, { remote });
    // A local memory that matches: cloud mode must not inject it.
    await deps.store.upsert(
      (await import('@oortmem/core/store-conformance')).TG,
      makeMemory({ id: 'm-local', text: 'billing deploys locally', stub: 'billing deploys' }),
    );
    const out = await handleUserPromptSubmit(ask(t.cwd), deps);
    expect(out.stdout).toBe('');
    expect(readLog(t.home).at(-1)).toMatchObject({ outcome: 'empty', degraded: ['cloud-error'] });
  });

  it('remote.prompt-gate-still-skips-acknowledgements-without-a-cloud-call', async () => {
    const t = tempHome();
    const remote = fakeRemote();
    await handleUserPromptSubmit(ask(t.cwd, 'ok'), makeDeps(t, { remote }));
    expect(remote.seen).toEqual([]);
  });

  it('remote.session-start-injects-cloud-pinned-memories', async () => {
    const t = tempHome();
    const remote = fakeRemote();
    const out = await handleSessionStart(
      { cwd: t.cwd, session_id: SESSION },
      makeDeps(t, { remote }),
    );
    expect(remote.seen).toEqual(['session:global']);
    expect(out.stdout).toContain('billing service deploys');
  });

  it('remote.session-start-error-injects-nothing', async () => {
    const t = tempHome();
    const remote = fakeRemote({
      sessionMemories: async () => {
        throw new Error('down');
      },
    });
    const out = await handleSessionStart(
      { cwd: t.cwd, session_id: SESSION },
      makeDeps(t, { remote }),
    );
    expect(out.stdout).toBe('');
    expect(readLog(t.home).at(-1)).toMatchObject({ degraded: ['cloud-error'] });
  });

  it('remote.drain-posts-queued-turns-to-the-cloud-without-local-adapters', async () => {
    const t = tempHome();
    enqueueObservations(t.config.home, SESSION, localScope(), [obs(1), obs(2)]);
    const remote = fakeRemote();
    const deps = makeDeps(t, { remote, embed: undefined, decide: undefined, write: undefined });
    const r = await drainQueue(deps);
    expect(r).toEqual({ processed: 2, failed: 0, remaining: 0 });
    expect(remote.seen).toEqual(['observe:a1:global', 'observe:a2:global']);
  });

  it('remote.drain-sends-a-stable-turn-ref-per-turn', async () => {
    const t = tempHome();
    const { sessionId: _drop, ...noSession } = obs(2);
    enqueueObservations(t.config.home, SESSION, localScope(), [obs(1), noSession]);
    const remote = fakeRemote();
    const deps = makeDeps(t, { remote, embed: undefined, decide: undefined, write: undefined });
    await drainQueue(deps);
    const [first, second] = remote.refs;
    expect(first).toBe(turnRefOf({ id: 'x', obs: obs(1) }));
    expect(first).toMatch(/:a1$/);
    // Without a session id the queue line's own id is the ref (it survives retries).
    expect(second).toBeTruthy();
    expect(second).not.toMatch(/:a2$/);
  });

  it('remote.drain-holds-the-queue-on-account-refusals', async () => {
    const t = tempHome();
    enqueueObservations(t.config.home, SESSION, localScope(), [obs(1), obs(2), obs(3)]);
    let calls = 0;
    const remote = fakeRemote({
      observe: async () => {
        calls++;
        throw Object.assign(new Error('no plan'), { status: 402, holdQueue: true });
      },
    });
    const r = await drainQueue(makeDeps(t, { remote }));
    // One attempt, then the run stops; every line is kept untouched (no attempt counted).
    expect(calls).toBe(1);
    expect(r).toEqual({ processed: 0, failed: 0, remaining: 3 });
    expect(queueLines(t.home).map((l) => l['attempts'])).toEqual([0, 0, 0]);
    expect(fs.existsSync(path.join(t.home, 'queue', 'dead'))).toBe(false);
    expect(readLog(t.home).at(-1)).toMatchObject({ event: 'drain', outcome: 'held' });
  });

  it('remote.drain-counts-other-failures-as-attempts', async () => {
    const t = tempHome();
    enqueueObservations(t.config.home, SESSION, localScope(), [obs(1)]);
    const remote = fakeRemote({
      observe: async () => {
        throw Object.assign(new Error('bad request'), { status: 400 });
      },
    });
    const r = await drainQueue(makeDeps(t, { remote }));
    expect(r.failed).toBe(1);
    expect(queueLines(t.home).map((l) => l['attempts'])).toEqual([1]);
  });

  it('remote.log-lines-never-hold-memory-or-prompt-text', async () => {
    const t = tempHome();
    const remote = fakeRemote();
    await handleUserPromptSubmit(
      ask(t.cwd, 'how does the secret billing deploy work?'),
      makeDeps(t, { remote }),
    );
    const log = fs.readFileSync(path.join(t.home, 'logs', 'hooks.log'), 'utf8');
    expect(log).not.toContain('billing');
    expect(log).not.toContain('release branch');
  });
});
