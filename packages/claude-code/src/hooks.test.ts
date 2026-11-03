import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localScope, projectIdFor, type Embedder, type MemoryStore } from '@oortmem/core';
import { makeMemory, vec } from '@oortmem/core/store-conformance';
import {
  AWS_KEY,
  SESSION,
  fixtureText,
  makeDeps,
  mode,
  queueLines,
  readLog,
  tempHome,
  writeTranscript,
  type TempHome,
} from '../test/helpers.js';
import { handleSessionStart, handleStop, handleUserPromptSubmit, runHook } from './hooks.js';
import { createHookLogger } from './log.js';

const PORT_MEMORY = makeMemory({
  id: 'm-port',
  text: 'The auth service listens on port 4471.',
  stub: 'auth port 4471',
  entities: ['auth'],
  embedding: vec(100, 1, 1, 10),
});

async function withMemories(t: TempHome, ...ms: ReturnType<typeof makeMemory>[]) {
  const deps = makeDeps(t);
  for (const m of ms) await deps.store.upsert(m);
  return deps;
}

function context(stdout: string, event: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(Object.keys(parsed)).toEqual(['hookSpecificOutput']);
  expect(parsed.hookSpecificOutput.hookEventName).toBe(event);
  return parsed.hookSpecificOutput.additionalContext;
}

/** A store whose every method call is counted. */
function counted(store: MemoryStore): { store: MemoryStore; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, calls };
}

const prompt = (t: TempHome, text: string) => ({ prompt: text, cwd: t.cwd, session_id: SESSION });
const stopInput = (t: TempHome, transcript: string, active = false) => ({
  transcript_path: transcript,
  session_id: SESSION,
  cwd: t.cwd,
  stop_hook_active: active,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UserPromptSubmit', () => {
  it('hook.prompt-emits-additional-context', async () => {
    const t = tempHome();
    const deps = await withMemories(t, PORT_MEMORY);
    const out = await handleUserPromptSubmit(
      prompt(t, 'which port does the auth service use?'),
      deps,
    );
    expect(out.exitCode).toBe(0);
    const ctx = context(out.stdout, 'UserPromptSubmit');
    expect(ctx).toContain('<oort-memory>');
    expect(ctx).toContain('The auth service listens on port 4471.');
    const [line] = readLog(t.home);
    expect(line).toMatchObject({
      event: 'UserPromptSubmit',
      session: SESSION,
      outcome: 'injected',
    });
    expect(line?.counts['memories']).toBe(1);
  });

  it('hook.prompt-skips-trivial-silently', async () => {
    const t = tempHome();
    const base = await withMemories(t, PORT_MEMORY);
    const { store, calls } = counted(base.store);
    for (const p of ['ok', '/model', 'sounds good!']) {
      const out = await handleUserPromptSubmit(prompt(t, p), { ...base, store });
      expect(out).toEqual({ stdout: '', exitCode: 0 });
    }
    expect(calls).toEqual([]);
    expect(readLog(t.home).map((l) => l.outcome)).toEqual([
      'skipped:too-short',
      'skipped:slash-command',
      'skipped:acknowledgment',
    ]);
  });

  it('hook.prompt-empty-when-nothing-recalled', async () => {
    const t = tempHome();
    const out = await handleUserPromptSubmit(
      prompt(t, 'which port does the auth service use?'),
      makeDeps(t),
    );
    expect(out).toEqual({ stdout: '', exitCode: 0 });
    expect(readLog(t.home)[0]?.outcome).toBe('empty');
  });

  it('hook.degrades-without-network', async () => {
    const t = tempHome();
    const deps = await withMemories(t, PORT_MEMORY);
    const down: Embedder = {
      dimension: 4,
      embed: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const out = await handleUserPromptSubmit(prompt(t, 'which port does the auth service use?'), {
      ...deps,
      embed: down,
      rerank: { rerank: () => Promise.reject(new Error('ECONNREFUSED')) },
    });
    expect(out.exitCode).toBe(0);
    expect(context(out.stdout, 'UserPromptSubmit')).toContain('port 4471');
    const [line] = readLog(t.home);
    expect(line?.outcome).toBe('injected');
    expect(line?.degraded).toEqual(expect.arrayContaining(['embed-failed', 'rerank-failed']));
  });

  it('hook.prompt-falls-back-to-lexical-on-timeout', async () => {
    vi.useFakeTimers();
    const t = tempHome();
    const deps = await withMemories(t, PORT_MEMORY);
    let embedCalls = 0;
    const hanging: Embedder = {
      dimension: 4,
      embed: () => {
        embedCalls++;
        return new Promise<Int8Array[]>(() => {});
      },
    };
    let reranked = 0;
    const pending = handleUserPromptSubmit(prompt(t, 'which port does the auth service use?'), {
      ...deps,
      embed: hanging,
      rerank: {
        async rerank(_q, docs) {
          reranked++;
          return docs.map((d) => ({ id: d.id, score: 1 }));
        },
      },
    });
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await pending;
    expect(out.exitCode).toBe(0);
    expect(context(out.stdout, 'UserPromptSubmit')).toContain('port 4471');
    // The lexical retry used neither the embedder nor the reranker.
    expect(embedCalls).toBe(1);
    expect(reranked).toBe(0);
    const [line] = readLog(t.home);
    expect(line?.degraded).toContain('timeout');
  });

  it('hook.prompt-lexical-retry-after-throw', async () => {
    const t = tempHome();
    const deps = await withMemories(t, PORT_MEMORY);
    let first = true;
    const store = new Proxy(deps.store, {
      get(target, prop, receiver) {
        if (prop === 'dense') {
          return () => {
            if (first) {
              first = false;
              return Promise.reject(new Error('dense index broken'));
            }
            return Promise.resolve([]);
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as () => unknown).bind(target) : v;
      },
    });
    const out = await handleUserPromptSubmit(prompt(t, 'which port does the auth service use?'), {
      ...deps,
      store,
    });
    expect(context(out.stdout, 'UserPromptSubmit')).toContain('port 4471');
    expect(readLog(t.home)[0]?.degraded).toContain('error');
  });

  it('hook.prompt-respects-project-scope', async () => {
    const t = tempHome();
    fs.mkdirSync(path.join(t.cwd, '.git'));
    const projectId = projectIdFor(t.cwd);
    expect(projectId).toBeDefined();
    const mine = {
      ...PORT_MEMORY,
      id: 'mine',
      scope: localScope(projectId),
      text: 'auth port is 4471 here',
    };
    const global = { ...PORT_MEMORY, id: 'global', text: 'auth port global default 9000' };
    const other = {
      ...PORT_MEMORY,
      id: 'other',
      scope: localScope('p-private'),
      text: 'auth port private 7777',
    };
    const deps = await withMemories(t, mine, global, other);
    const out = await handleUserPromptSubmit(prompt(t, 'which auth port do we use?'), deps);
    const ctx = context(out.stdout, 'UserPromptSubmit');
    expect(ctx).toContain('4471');
    expect(ctx).toContain('9000');
    expect(ctx).not.toContain('7777');
    expect(readLog(t.home)[0]?.project).toBe(projectId);
  });
});

describe('Stop', () => {
  it('hook.stop-noop-when-active', async () => {
    const t = tempHome();
    const transcript = writeTranscript(path.join(t.root, 'projects', 'p'), t.cwd);
    const deps = makeDeps(t);
    let spawned = 0;
    const out = await handleStop(stopInput(t, transcript, true), {
      ...deps,
      spawnDrain: () => spawned++,
    });
    expect(out).toEqual({ stdout: '', exitCode: 0 });
    expect(queueLines(t.home)).toEqual([]);
    expect(await deps.store.getCursor(`claude-code:${SESSION}`)).toBeNull();
    expect(spawned).toBe(0);
    expect(readLog(t.home)[0]?.outcome).toBe('skipped:stop-hook-active');
  });

  it('hook.stop-advances-cursor', async () => {
    const t = tempHome();
    const dir = path.join(t.root, 'projects', 'p');
    const transcript = writeTranscript(dir, t.cwd);
    const deps = makeDeps(t);
    const key = `claude-code:${SESSION}`;

    await handleStop(stopInput(t, transcript), deps);
    expect(queueLines(t.home).map((l) => (l['obs'] as { turnRef: string }).turnRef)).toEqual([
      'a-0001c',
      'a-0002',
      'a-0003b',
      'a-0014',
      'a-0015',
    ]);
    expect(await deps.store.getCursor(key)).toBe('a-0015');

    // Nothing new: nothing queued, cursor unchanged.
    await handleStop(stopInput(t, transcript), deps);
    expect(queueLines(t.home)).toHaveLength(5);

    const more = [
      {
        type: 'user',
        uuid: 'u-0004',
        parentUuid: 'a-0015',
        timestamp: '2026-10-01T09:06:00.000Z',
        sessionId: SESSION,
        cwd: t.cwd,
        isSidechain: false,
        message: { role: 'user', content: 'And where are the auth docs?' },
      },
      {
        type: 'assistant',
        uuid: 'a-0004',
        parentUuid: 'u-0004',
        timestamp: '2026-10-01T09:06:01.000Z',
        sessionId: SESSION,
        cwd: t.cwd,
        isSidechain: false,
        message: { role: 'assistant', content: [{ type: 'text', text: 'In docs/auth.md.' }] },
      },
    ];
    fs.appendFileSync(transcript, more.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await handleStop(stopInput(t, transcript), deps);
    const lines = queueLines(t.home);
    expect(lines).toHaveLength(6);
    expect(lines[5]).toMatchObject({
      obs: { turnRef: 'a-0004', assistantText: 'In docs/auth.md.' },
    });
    expect(await deps.store.getCursor(key)).toBe('a-0004');
    expect(readLog(t.home).map((l) => l.counts['queued'])).toEqual([5, 0, 1]);
  });

  it('hook.stop-reprocesses-grown-turn', async () => {
    const t = tempHome();
    const row = (type: string, uuid: string, parentUuid: string | null, content: unknown) =>
      JSON.stringify({
        type,
        uuid,
        parentUuid,
        timestamp: `2026-10-01T10:00:0${uuid.length % 10}.000Z`,
        sessionId: SESSION,
        cwd: t.cwd,
        message: { role: type, content },
      });
    const transcript = writeTranscript(
      path.join(t.root, 'p'),
      t.cwd,
      SESSION,
      [
        row('user', 'u1', null, 'Please look up the auth port'),
        row('assistant', 'a1a', 'u1', [
          { type: 'tool_use', id: 'x', name: 'Grep', input: { pattern: 'PORT' } },
        ]),
      ].join('\n') + '\n',
    );
    const deps = makeDeps(t);
    await handleStop(stopInput(t, transcript), deps);
    expect(await deps.store.getCursor(`claude-code:${SESSION}`)).toBe('a1a');
    // The transcript lagged: the rest of the turn lands after the first Stop.
    fs.appendFileSync(
      transcript,
      [
        row('user', 'r1', 'a1a', [
          { type: 'tool_result', tool_use_id: 'x', content: 'PORT = 4471' },
        ]),
        row('assistant', 'a1b', 'r1', [{ type: 'text', text: 'It is 4471.' }]),
      ].join('\n') + '\n',
    );
    await handleStop(stopInput(t, transcript), deps);
    const lines = queueLines(t.home);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ obs: { turnRef: 'a1b', assistantText: 'It is 4471.' } });
    expect(await deps.store.getCursor(`claude-code:${SESSION}`)).toBe('a1b');
  });

  it('hook.stop-never-calls-adapters', async () => {
    const t = tempHome();
    const transcript = writeTranscript(path.join(t.root, 'p'), t.cwd);
    const deps = makeDeps(t);
    const { store, calls } = counted(deps.store);
    let spawned = 0;
    const t0 = performance.now();
    const out = await handleStop(stopInput(t, transcript), {
      ...deps,
      store,
      spawnDrain: () => spawned++,
    });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(out).toEqual({ stdout: '', exitCode: 0 });
    expect(deps.calls).toMatchObject({ embed: 0, gate: 0, reconcile: 0, write: 0 });
    expect(calls.sort()).toEqual(['getCursor', 'setCursor']);
    expect(spawned).toBe(1);
  });

  it('hook.stop-scrubs-before-queue', async () => {
    const t = tempHome();
    const transcript = writeTranscript(path.join(t.root, 'p'), t.cwd);
    await handleStop(stopInput(t, transcript), makeDeps(t));
    const raw = fs.readFileSync(path.join(t.home, 'queue', `${SESSION}.jsonl`), 'utf8');
    expect(fixtureText(t.cwd)).toContain(AWS_KEY);
    expect(raw).not.toContain(AWS_KEY);
    expect(raw).toContain('[REDACTED:aws-access-key]');
  });

  it('hook.stop-queue-is-owner-only', async () => {
    const t = tempHome();
    const transcript = writeTranscript(path.join(t.root, 'p'), t.cwd);
    await handleStop(stopInput(t, transcript), makeDeps(t));
    if (process.platform === 'win32') return;
    expect(mode(path.join(t.home, 'queue'))).toBe(0o700);
    expect(mode(path.join(t.home, 'queue', `${SESSION}.jsonl`))).toBe(0o600);
  });

  function manyPairs(t: TempHome, n: number): string {
    const rows: string[] = [];
    for (let i = 0; i < n; i++) {
      const ts = new Date(Date.UTC(2026, 9, 1, 12, 0, i)).toISOString();
      rows.push(
        JSON.stringify({
          type: 'user',
          uuid: `u${i}`,
          parentUuid: i === 0 ? null : `a${i - 1}`,
          timestamp: ts,
          sessionId: SESSION,
          cwd: t.cwd,
          message: { role: 'user', content: `question number ${i}` },
        }),
      );
      rows.push(
        JSON.stringify({
          type: 'assistant',
          uuid: `a${i}`,
          parentUuid: `u${i}`,
          timestamp: ts,
          sessionId: SESSION,
          cwd: t.cwd,
          message: { role: 'assistant', content: [{ type: 'text', text: `answer number ${i}` }] },
        }),
      );
    }
    return writeTranscript(path.join(t.root, 'p'), t.cwd, SESSION, rows.join('\n') + '\n');
  }

  it('hook.stop-caps-at-20', async () => {
    const t = tempHome();
    const transcript = manyPairs(t, 30);
    const deps = makeDeps(t);
    await handleStop(stopInput(t, transcript), deps);
    const refs = queueLines(t.home).map((l) => (l['obs'] as { turnRef: string }).turnRef);
    expect(refs).toEqual(Array.from({ length: 20 }, (_, i) => `a${i + 10}`));
    expect(await deps.store.getCursor(`claude-code:${SESSION}`)).toBe('a29');
    expect(readLog(t.home)[0]?.counts).toMatchObject({ observations: 30, queued: 20, capped: 10 });
  });

  it('hook.stop-cursor-not-found-takes-newest-20', async () => {
    const t = tempHome();
    const transcript = manyPairs(t, 25);
    const deps = makeDeps(t);
    await deps.store.setCursor(`claude-code:${SESSION}`, 'rotated-away');
    await handleStop(stopInput(t, transcript), deps);
    expect(queueLines(t.home)).toHaveLength(20);
    expect(readLog(t.home)[0]?.counts).toMatchObject({ cursorMissing: 1, queued: 20, capped: 5 });
  });

  it('hook.stop-never-observes-injected-oort-memory', async () => {
    const t = tempHome();
    const CANARY = 'recalled-canary-k3';
    const deps = await withMemories(t, {
      ...PORT_MEMORY,
      text: `The auth service listens on port 4471 (${CANARY}).`,
    });
    const asked = 'which port does the auth service use?';
    const ups = await handleUserPromptSubmit(prompt(t, asked), deps);
    const ctx = context(ups.stdout, 'UserPromptSubmit');
    expect(ctx).toContain(CANARY);

    // How the injected context can come back in a transcript: as a hook attachment
    // row, inside a system reminder in the user row, bare in a later user row, and
    // echoed by Claude in its reply.
    const base = { sessionId: SESSION, cwd: t.cwd, isSidechain: false };
    const rows = [
      {
        ...base,
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        timestamp: '2026-10-03T10:00:00.000Z',
        message: {
          role: 'user',
          content: `${asked}\n\n<system-reminder>\nUserPromptSubmit hook additional context: ${ctx}\n</system-reminder>`,
        },
      },
      {
        ...base,
        type: 'attachment',
        uuid: 'att1',
        parentUuid: 'u1',
        timestamp: '2026-10-03T10:00:00.100Z',
        attachment: {
          type: 'hook_additional_context',
          content: [ctx],
          hookName: 'UserPromptSubmit',
        },
      },
      {
        ...base,
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'att1',
        timestamp: '2026-10-03T10:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `From memory:\n${ctx}\nSo it is port 4471.` }],
        },
      },
      {
        ...base,
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        timestamp: '2026-10-03T10:01:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `${ctx}\nand which host runs it?` }],
        },
      },
      {
        ...base,
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        timestamp: '2026-10-03T10:01:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The auth host is auth-1.' }],
        },
      },
    ];
    const transcript = writeTranscript(
      path.join(t.root, 'p'),
      t.cwd,
      SESSION,
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    await handleStop(stopInput(t, transcript), deps);
    const lines = queueLines(t.home);
    expect(lines.map((l) => l['obs'])).toEqual([
      expect.objectContaining({
        userText: asked,
        assistantText: 'From memory:\n\nSo it is port 4471.',
      }),
      expect.objectContaining({
        userText: 'and which host runs it?',
        assistantText: 'The auth host is auth-1.',
      }),
    ]);
    const raw = fs.readFileSync(path.join(t.home, 'queue', `${SESSION}.jsonl`), 'utf8');
    expect(raw).not.toContain(CANARY);
    expect(raw).not.toContain('oort-memory');
  });

  it('hook.stop-missing-transcript-exit-0', async () => {
    const t = tempHome();
    const out = await handleStop(stopInput(t, path.join(t.root, 'nope.jsonl')), makeDeps(t));
    expect(out).toEqual({ stdout: '', exitCode: 0 });
    expect(readLog(t.home)[0]?.outcome).toBe('no-transcript');
  });
});

describe('SessionStart', () => {
  it('hook.session-start-injects-hot', async () => {
    const t = tempHome();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const deps = await withMemories(
      t,
      makeMemory({ id: 'hot', tier: 'hot', text: 'HOT: tests run with pnpm verify' }),
      makeMemory({ id: 'pinned', tier: 'warm', pinned: true, text: 'PINNED: never push to main' }),
      makeMemory({ id: 'warm', tier: 'warm', text: 'WARM: not injected' }),
      makeMemory({
        id: 'old',
        tier: 'hot',
        text: 'EXPIRED: not injected',
        validTo: past,
        expiredAt: past,
      }),
      makeMemory({
        id: 'elsewhere',
        tier: 'hot',
        scope: localScope('p-private'),
        text: 'OTHER: not injected',
      }),
    );
    const out = await handleSessionStart(
      { cwd: t.cwd, session_id: SESSION, source: 'startup' },
      deps,
    );
    const ctx = context(out.stdout, 'SessionStart');
    expect(ctx).toContain('HOT: tests run');
    expect(ctx).toContain('PINNED: never push');
    expect(ctx).not.toMatch(/WARM|EXPIRED|OTHER/);
    expect(ctx.indexOf('PINNED')).toBeLessThan(ctx.indexOf('HOT'));
    expect(ctx.length).toBeLessThanOrEqual(t.config.recall.budgetChars / 2);
    expect(readLog(t.home)[0]).toMatchObject({
      event: 'SessionStart',
      outcome: 'injected',
      counts: { memories: 2 },
    });
  });

  it('hook.session-start-respects-half-budget', async () => {
    const t = tempHome();
    const ms = Array.from({ length: 40 }, (_, i) =>
      makeMemory({ id: `h${i}`, tier: 'hot', text: `hot memory ${i} ${'x'.repeat(200)}` }),
    );
    const deps = await withMemories(t, ...ms);
    const out = await handleSessionStart({ cwd: t.cwd, session_id: SESSION }, deps);
    expect(context(out.stdout, 'SessionStart').length).toBeLessThanOrEqual(3000);
  });

  it('hook.session-start-empty-when-none', async () => {
    const t = tempHome();
    const deps = await withMemories(t, makeMemory({ id: 'warm', tier: 'warm' }));
    const out = await handleSessionStart({ cwd: t.cwd, session_id: SESSION }, deps);
    expect(out).toEqual({ stdout: '', exitCode: 0 });
  });
});

describe('runHook', () => {
  it('hook.garbage-stdin-exit-0', async () => {
    const t = tempHome();
    const deps = makeDeps(t);
    for (const [event, stdin] of [
      ['UserPromptSubmit', 'not json at all'],
      ['UserPromptSubmit', '{"prompt": 42}'],
      ['Stop', '{"session_id":"s"}'],
      ['SessionStart', '[]'],
      ['Stop', ''],
    ] as const) {
      expect(await runHook(event, stdin, deps)).toEqual({ stdout: '', exitCode: 0 });
    }
    expect(readLog(t.home).map((l) => l.outcome)).toEqual(Array(5).fill('invalid-input'));
  });

  it('hook.never-throws-on-broken-store', async () => {
    const t = tempHome();
    const broken = new Proxy({} as MemoryStore, {
      get: () => () => Promise.reject(new Error('disk on fire')),
    });
    const deps = { ...makeDeps(t), store: broken };
    const transcript = writeTranscript(path.join(t.root, 'p'), t.cwd);
    const inputs = {
      UserPromptSubmit: {
        ...prompt(t, 'which port does the auth service use?'),
        hook_event_name: 'UserPromptSubmit',
      },
      Stop: stopInput(t, transcript),
      SessionStart: { cwd: t.cwd, session_id: SESSION, source: 'resume' },
    };
    for (const [event, input] of Object.entries(inputs)) {
      const out = await runHook(event as 'Stop', JSON.stringify(input), deps);
      expect(out).toEqual({ stdout: '', exitCode: 0 });
    }
    expect(readLog(t.home).map((l) => l.outcome)).toEqual(['error', 'error', 'error']);
  });

  it('hook.run-hook-accepts-unknown-fields', async () => {
    const t = tempHome();
    const deps = await withMemories(t, PORT_MEMORY);
    const stdin = JSON.stringify({
      ...prompt(t, 'which port does the auth service use?'),
      hook_event_name: 'UserPromptSubmit',
      transcript_path: '/x.jsonl',
      permission_mode: 'default',
      some_future_field: { nested: true },
    });
    const out = await runHook('UserPromptSubmit', stdin, deps);
    expect(context(out.stdout, 'UserPromptSubmit')).toContain('4471');
  });

  it('hook.run-hook-drain', async () => {
    const t = tempHome();
    const deps = makeDeps(t);
    const transcript = writeTranscript(path.join(t.root, 'p'), t.cwd);
    await runHook('Stop', JSON.stringify(stopInput(t, transcript)), deps);
    expect(await runHook('drain', '', deps)).toEqual({ stdout: '', exitCode: 0 });
    expect(queueLines(t.home)).toEqual([]);
    expect(deps.calls.write).toBe(5);
  });
});

describe('hook log', () => {
  it('hook.log-never-contains-text', async () => {
    const t = tempHome();
    const PLANTED = 'PLANTED-canary-zq9x7 which port does the auth service use';
    const deps = await withMemories(
      t,
      PORT_MEMORY,
      makeMemory({ id: 'h', tier: 'hot', text: 'HOT-MEMORY-TEXT-canary' }),
    );
    await runHook('UserPromptSubmit', JSON.stringify(prompt(t, PLANTED)), deps);
    await runHook('UserPromptSubmit', JSON.stringify({ prompt: { PLANTED } }), deps);
    await runHook('UserPromptSubmit', `{"prompt":"${PLANTED}"`, deps);
    await runHook('SessionStart', JSON.stringify({ cwd: t.cwd, session_id: SESSION }), deps);
    const transcript = writeTranscript(path.join(t.root, 'p'), t.cwd);
    await runHook('Stop', JSON.stringify(stopInput(t, transcript)), deps);
    await runHook('drain', '', deps);
    const raw = fs.readFileSync(path.join(t.home, 'logs', 'hooks.log'), 'utf8');
    expect(raw).not.toContain('PLANTED');
    expect(raw).not.toContain('canary');
    expect(raw).not.toContain('auth');
    expect(raw).not.toContain('4471');
    expect(raw).not.toContain(AWS_KEY);
    const lines = readLog(t.home);
    expect(lines.length).toBe(6);
    const allowed = [
      'ts',
      'event',
      'session',
      'project',
      'outcome',
      'counts',
      'timings',
      'degraded',
      'ids',
    ];
    for (const l of lines) {
      for (const k of Object.keys(l)) expect(allowed).toContain(k);
      for (const v of Object.values(l.counts)) expect(typeof v).toBe('number');
      for (const v of Object.values(l.timings)) expect(typeof v).toBe('number');
    }
  });

  it('hook.log-is-owner-only', async () => {
    const t = tempHome();
    await handleUserPromptSubmit(prompt(t, 'ok'), makeDeps(t));
    if (process.platform === 'win32') return;
    expect(mode(path.join(t.home, 'logs'))).toBe(0o700);
    expect(mode(path.join(t.home, 'logs', 'hooks.log'))).toBe(0o600);
  });

  it('hook.log-rotates-at-5mb', () => {
    const t = tempHome();
    const log = createHookLogger(t.home);
    const file = path.join(t.home, 'logs', 'hooks.log');
    const entry = {
      event: 'Stop',
      session: null,
      project: null,
      outcome: 'ok',
      counts: {},
      timings: {},
    };
    log.write(entry);
    fs.appendFileSync(file, 'x'.repeat(5 * 1024 * 1024));
    log.write(entry);
    expect(fs.statSync(`${file}.1`).size).toBeGreaterThan(5 * 1024 * 1024);
    expect(readLog(t.home)).toHaveLength(1);
    fs.appendFileSync(file, 'y'.repeat(5 * 1024 * 1024));
    log.write(entry);
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toContain('yyyy');
    expect(fs.existsSync(`${file}.2`)).toBe(false);
    if (process.platform !== 'win32') expect(mode(`${file}.1`)).toBe(0o600);
  });

  it('hook.log-never-throws', () => {
    const t = tempHome();
    fs.mkdirSync(t.home, { recursive: true });
    fs.writeFileSync(path.join(t.home, 'logs'), 'a file where the log dir should be');
    const log = createHookLogger(t.home);
    expect(() =>
      log.write({
        event: 'Stop',
        session: null,
        project: null,
        outcome: 'ok',
        counts: {},
        timings: {},
      }),
    ).not.toThrow();
  });

  it('hook.log-clamps-tokens', () => {
    const t = tempHome();
    const log = createHookLogger(t.home);
    log.write({
      event: 'Stop now please',
      session: 'which port does the auth service use?',
      project: null,
      outcome: 'the user said: which port does the auth service use, and much more text after that',
      counts: {},
      timings: {},
      degraded: ['embed failed: ECONNREFUSED at 10.0.0.1', 'timeout'],
    });
    const [line] = readLog(t.home);
    const TOKEN = /^[A-Za-z0-9:_-]{1,64}$/;
    expect(line?.event).toMatch(TOKEN);
    expect(line?.outcome).toMatch(TOKEN);
    for (const d of line?.degraded ?? []) expect(d).toMatch(TOKEN);
    expect(line?.degraded).toContain('timeout');
    expect(line?.session).toBe('[invalid]');
    const raw = fs.readFileSync(path.join(t.home, 'logs', 'hooks.log'), 'utf8');
    expect(raw).not.toMatch(/auth service/);
  });
});
