import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localScope, type Observation } from '@oortmem/core';
import {
  SESSION,
  fakeWriter,
  makeDeps,
  newCalls,
  queueLines,
  readLog,
  tempHome,
  writeTranscript,
  type TempHome,
} from '../test/helpers.js';
import { handleStop } from './hooks.js';
import { drainQueue, enqueueObservations } from './queue.js';
import { localGrant } from '@oortmem/core';

function obs(i: number, session = SESSION): Observation {
  return {
    userText: `question ${i}`,
    assistantText: `answer ${i}`,
    toolSummaries: [],
    sessionId: session,
    turnRef: `a${i}`,
    at: new Date(Date.UTC(2026, 9, 1, 12, 0, i)).toISOString(),
  };
}

function enqueue(t: TempHome, n: number, session = SESSION, from = 0): void {
  enqueueObservations(
    t.config.home,
    session,
    localScope(),
    Array.from({ length: n }, (_, i) => obs(from + i, session)),
  );
}

const lockFile = (t: TempHome) => path.join(t.home, 'queue', '.lock');

describe('drainQueue', () => {
  it('drain.observes-and-removes-lines', async () => {
    const t = tempHome();
    const deps = makeDeps(t);
    const transcript = writeTranscript(path.join(t.root, 'p'), t.cwd);
    await handleStop(
      { transcript_path: transcript, session_id: SESSION, cwd: t.cwd, stop_hook_active: false },
      deps,
    );
    const r = await drainQueue(deps);
    expect(r).toEqual({ processed: 5, failed: 0, remaining: 0 });
    expect(fs.existsSync(path.join(t.home, 'queue', `${SESSION}.jsonl`))).toBe(false);
    const stored = await deps.store.list(
      localGrant({
        orgId: 'local',
        customerId: 'self',
        agentId: 'claude-code',
        projectIds: [null],
      }),
    );
    expect(stored).toHaveLength(5);
    expect(stored.every((m) => m.source.harness === 'claude-code')).toBe(true);
    expect(stored.map((m) => m.source.turnRef).sort()).toEqual([
      'a-0001c',
      'a-0002',
      'a-0003b',
      'a-0014',
      'a-0015',
    ]);
    expect(fs.existsSync(lockFile(t))).toBe(false);
    expect(readLog(t.home).at(-1)).toMatchObject({
      event: 'drain',
      outcome: 'ok',
      counts: { processed: 5, failed: 0, remaining: 0 },
    });
  });

  it('drain.writes-to-claude-codes-star-when-it-keeps-one', async () => {
    // CON-62: `oort connect claude-code --star` keeps Claude Code's new memories in its Star.
    const t = tempHome();
    const deps = { ...makeDeps(t), home: 'star' as const };
    enqueue(t, 2);
    expect(await drainQueue(deps)).toEqual({ processed: 2, failed: 0, remaining: 0 });
    const person = { orgId: 'local', customerId: 'self', projectIds: [null] };
    const stored = await deps.store.list(localGrant({ ...person, agentId: 'claude-code' }));
    expect(stored).toHaveLength(2);
    expect(stored.every((m) => m.address?.level === 'agent')).toBe(true);
    // Another agent of the same person reads the Planet, never Claude Code's Star.
    expect(await deps.store.list(localGrant({ ...person, agentId: 'codex' }))).toEqual([]);
  });

  it('drain.oldest-file-first', async () => {
    const t = tempHome();
    const calls = newCalls();
    const deps = makeDeps(t, { calls });
    enqueue(t, 1, 'session-new', 50);
    enqueue(t, 1, 'session-old', 10);
    const q = path.join(t.home, 'queue');
    fs.utimesSync(path.join(q, 'session-new.jsonl'), new Date(), new Date());
    fs.utimesSync(path.join(q, 'session-old.jsonl'), new Date(0), new Date(0));
    await drainQueue(deps);
    expect(calls.written.map((o) => o.turnRef)).toEqual(['a10', 'a50']);
  });

  it('drain.lock-prevents-concurrent', async () => {
    const t = tempHome();
    enqueue(t, 3);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = newCalls();
    const slow = makeDeps(t, { calls });
    const blocking = {
      ...slow,
      write: {
        async write(o: Observation, a: 'ADD' | 'UPDATE' | 'SUPERSEDE') {
          await gate;
          return fakeWriter(calls).write(o, a);
        },
      },
    };
    const first = drainQueue(blocking);
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(lockFile(t))).toBe(true);
    const second = await drainQueue(makeDeps(t));
    expect(second).toEqual({ processed: 0, failed: 0, remaining: 3 });
    release();
    expect(await first).toEqual({ processed: 3, failed: 0, remaining: 0 });
    expect(readLog(t.home).map((l) => l.outcome)).toEqual(['locked', 'ok']);
  });

  it('drain.breaks-stale-lock', async () => {
    const t = tempHome();
    enqueue(t, 2);
    fs.writeFileSync(lockFile(t), '12345\n');
    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(lockFile(t), old, old);
    expect(await drainQueue(makeDeps(t))).toEqual({ processed: 2, failed: 0, remaining: 0 });

    fs.writeFileSync(lockFile(t), '12345\n');
    enqueue(t, 1);
    expect(await drainQueue(makeDeps(t))).toEqual({ processed: 0, failed: 0, remaining: 1 });
  });

  it('drain.dead-letters-after-3-failures', async () => {
    const t = tempHome();
    enqueue(t, 1);
    enqueue(t, 1, 'other', 7);
    const calls = newCalls();
    const deps = makeDeps(t, { calls });
    const failing = { ...deps, write: fakeWriter(calls, () => true) };
    expect(await drainQueue(failing)).toEqual({ processed: 0, failed: 2, remaining: 2 });
    expect(queueLines(t.home)[0]).toMatchObject({ attempts: 1 });
    expect(await drainQueue(failing)).toEqual({ processed: 0, failed: 2, remaining: 2 });
    expect(await drainQueue(failing)).toEqual({ processed: 0, failed: 2, remaining: 0 });
    expect(queueLines(t.home)).toEqual([]);
    const dead = path.join(t.home, 'queue', 'dead', `${SESSION}.jsonl`);
    const deadLines = fs.readFileSync(dead, 'utf8').trim().split('\n');
    expect(deadLines).toHaveLength(1);
    expect(JSON.parse(deadLines[0] ?? '')).toMatchObject({ attempts: 3, obs: { turnRef: 'a0' } });
    if (process.platform !== 'win32') {
      expect(fs.statSync(dead).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(dead)).mode & 0o777).toBe(0o700);
    }
    const deadLog = readLog(t.home).filter((l) => l.outcome === 'dead-lettered');
    expect(deadLog).toHaveLength(1);
    expect(deadLog[0]?.counts).toEqual({ lines: 2 });
    expect(deadLog[0]?.ids).toHaveLength(2);
    const raw = fs.readFileSync(path.join(t.home, 'logs', 'hooks.log'), 'utf8');
    expect(raw).not.toContain('question');
  });

  it('drain.skips-without-adapters', async () => {
    const t = tempHome();
    enqueue(t, 2);
    const before = fs.readFileSync(path.join(t.home, 'queue', `${SESSION}.jsonl`), 'utf8');
    for (const missing of ['decide', 'write', 'embed'] as const) {
      const { [missing]: _gone, ...deps } = makeDeps(t);
      expect(await drainQueue(deps)).toEqual({ processed: 0, failed: 0, remaining: 2 });
    }
    expect(fs.readFileSync(path.join(t.home, 'queue', `${SESSION}.jsonl`), 'utf8')).toBe(before);
    expect(readLog(t.home).map((l) => l.outcome)).toEqual(
      Array(3).fill('drain-skipped:missing-adapters'),
    );
  });

  it('drain.at-most-50-per-run', async () => {
    const t = tempHome();
    enqueue(t, 35, 's1');
    enqueue(t, 25, 's2', 100);
    const calls = newCalls();
    expect(await drainQueue(makeDeps(t, { calls }))).toEqual({
      processed: 50,
      failed: 0,
      remaining: 10,
    });
    expect(await drainQueue(makeDeps(t, { calls }))).toEqual({
      processed: 10,
      failed: 0,
      remaining: 0,
    });
    expect(calls.write).toBe(60);
  });

  it('drain.keeps-lines-appended-during-drain', async () => {
    const t = tempHome();
    enqueue(t, 2);
    const calls = newCalls();
    const deps = makeDeps(t, { calls });
    let appended = false;
    const appending = {
      ...deps,
      write: {
        async write(o: Observation, a: 'ADD' | 'UPDATE' | 'SUPERSEDE') {
          if (!appended) {
            appended = true;
            enqueue(t, 1, SESSION, 99);
          }
          return fakeWriter(calls).write(o, a);
        },
      },
    };
    expect(await drainQueue(appending)).toEqual({ processed: 2, failed: 0, remaining: 1 });
    expect(queueLines(t.home).map((l) => (l['obs'] as { turnRef: string }).turnRef)).toEqual([
      'a99',
    ]);
  });

  it('drain.dead-letters-corrupt-lines', async () => {
    const t = tempHome();
    enqueue(t, 1);
    fs.appendFileSync(path.join(t.home, 'queue', `${SESSION}.jsonl`), 'garbage line\n{"v":1}\n');
    const r = await drainQueue(makeDeps(t));
    expect(r).toEqual({ processed: 1, failed: 2, remaining: 0 });
    const dead = fs.readFileSync(path.join(t.home, 'queue', 'dead', `${SESSION}.jsonl`), 'utf8');
    expect(dead.trim().split('\n')).toHaveLength(2);
  });

  it('drain.empty-queue', async () => {
    const t = tempHome();
    expect(await drainQueue(makeDeps(t))).toEqual({ processed: 0, failed: 0, remaining: 0 });
  });
});
