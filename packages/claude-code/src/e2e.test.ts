import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqliteStore } from '@oortmem/store-sqlite';
import {
  SESSION,
  makeDeps,
  newCalls,
  queueLines,
  readLog,
  tempHome,
  writeTranscript,
} from '../test/helpers.js';
import { runHook } from './hooks.js';

describe('end to end', () => {
  it('e2e.stop-then-drain-then-recall', async () => {
    const t = tempHome();
    const store = await openSqliteStore({
      path: path.join(t.home, 'oort.sqlite'),
      coldDir: path.join(t.home, 'cold'),
      dimension: 4,
      log: () => {},
    });
    try {
      const calls = newCalls();
      let spawned = 0;
      const deps = { ...makeDeps(t, { calls, store }), spawnDrain: () => spawned++ };
      const transcript = writeTranscript(path.join(t.root, 'projects', 'p'), t.cwd);

      // 1. Stop queues the new turns without touching any adapter.
      const stop = await runHook(
        'Stop',
        JSON.stringify({
          session_id: SESSION,
          transcript_path: transcript,
          cwd: t.cwd,
          hook_event_name: 'Stop',
          stop_hook_active: false,
          last_assistant_message: 'Done: the auth service now listens on port 5582.',
        }),
        deps,
      );
      expect(stop).toEqual({ stdout: '', exitCode: 0 });
      expect(queueLines(t.home)).toHaveLength(5);
      expect(calls).toMatchObject({ embed: 0, gate: 0, write: 0 });
      expect(spawned).toBe(1);

      // 2. The drain observes them with the fake decide and write.
      expect(await runHook('drain', '', deps)).toEqual({ stdout: '', exitCode: 0 });
      expect(queueLines(t.home)).toEqual([]);
      expect(calls.write).toBe(5);

      // 3. A later prompt recalls the memory as additional context.
      const out = await runHook(
        'UserPromptSubmit',
        JSON.stringify({
          session_id: 'next-session',
          cwd: t.cwd,
          hook_event_name: 'UserPromptSubmit',
          prompt: 'what port does the auth service listen on now?',
        }),
        deps,
      );
      const parsed = JSON.parse(out.stdout) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('port 5582');
      expect(readLog(t.home).map((l) => [l.event, l.outcome])).toEqual([
        ['Stop', 'queued'],
        ['drain', 'ok'],
        // The first drain on a store also consolidates it (CON-48).
        ['consolidate', 'ok'],
        ['UserPromptSubmit', 'injected'],
      ]);
    } finally {
      await store.close();
    }
  });
});
