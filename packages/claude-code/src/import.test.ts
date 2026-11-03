import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scrubObservation } from '@oortmem/core';
import {
  AWS_KEY,
  SESSION,
  fixtureText,
  makeDeps,
  newCalls,
  queueLines,
  tempHome,
  writeTranscript,
  type TempHome,
} from '../test/helpers.js';
import { handleStop } from './hooks.js';
import { importTranscripts } from './import.js';
import { parseTranscript, turnsToObservations } from './transcript.js';

const OTHER = '22222222-2222-4222-8222-222222222222';
const LOCAL = { orgId: 'local', customerId: 'self', agentId: 'claude-code', projectIds: [null] };

/** Two projects: the fixture session, and a second session whose turns are all older. */
function projects(t: TempHome): string {
  const dir = path.join(t.root, 'claude-projects');
  writeTranscript(path.join(dir, '-synthetic-project-a'), t.cwd);
  const older = fixtureText(t.cwd)
    .replaceAll(SESSION, OTHER)
    .replaceAll('2026-10-01T09:0', '2026-09-01T09:0')
    .replaceAll('"uuid":"', '"uuid":"o-')
    .replaceAll('"parentUuid":"', '"parentUuid":"o-');
  writeTranscript(path.join(dir, '-synthetic-project-b'), t.cwd, OTHER, older);
  // Not transcripts: a subagent transcript, an orphaned copy, and a stray file.
  writeTranscript(path.join(dir, '-synthetic-project-a', SESSION, 'subagents'), t.cwd, 'agent-x');
  writeTranscript(path.join(dir, '-synthetic-project-a'), t.cwd, `${SESSION}.orphaned-1-abc`);
  fs.writeFileSync(path.join(dir, 'README.txt'), 'not a project');
  return dir;
}

function expectedTokens(t: TempHome): number {
  let sum = 0;
  for (const text of [fixtureText(t.cwd), fixtureText(t.cwd)]) {
    for (const o of turnsToObservations(parseTranscript(text))) {
      const s = scrubObservation(o);
      if (s.dropped) continue;
      const chars =
        s.obs.userText.length +
        s.obs.assistantText.length +
        s.obs.toolSummaries.reduce((n, x) => n + x.length, 0);
      sum += chars / 4 + 400;
    }
  }
  return Math.ceil(sum * 0.25);
}

describe('importTranscripts', () => {
  it('import.estimate-only-writes-nothing', async () => {
    const t = tempHome();
    const dir = projects(t);
    const deps = makeDeps(t);
    const r = await importTranscripts({ projectsDir: dir, estimateOnly: true }, deps);
    expect(r).toEqual({ sessions: 2, observations: 6, estimatedTokens: expectedTokens(t) });
    expect(await deps.store.list(LOCAL, { validOnly: false })).toEqual([]);
    expect(await deps.store.getCursor(`claude-code:${SESSION}`)).toBeNull();
    expect(await deps.store.getCursor(`claude-code:${OTHER}`)).toBeNull();
    expect(fs.existsSync(path.join(t.home, 'eval'))).toBe(false);
    expect(deps.calls).toMatchObject({ embed: 0, gate: 0, write: 0 });

    const half = await importTranscripts(
      { projectsDir: dir, estimateOnly: true, writerFraction: 0.5 },
      deps,
    );
    expect(half.estimatedTokens).toBeGreaterThan(r.estimatedTokens);
  });

  it('import.since-filters-by-mtime', async () => {
    const t = tempHome();
    const dir = projects(t);
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(path.join(dir, '-synthetic-project-b', `${OTHER}.jsonl`), old, old);
    const r = await importTranscripts(
      { projectsDir: dir, estimateOnly: true, since: new Date('2025-01-01T00:00:00Z') },
      makeDeps(t),
    );
    expect(r).toMatchObject({ sessions: 1, observations: 3 });
  });

  it('import.oldest-first', async () => {
    const t = tempHome();
    const calls = newCalls();
    const deps = makeDeps(t, { calls });
    const r = await importTranscripts({ projectsDir: projects(t), estimateOnly: false }, deps);
    expect(r).toMatchObject({ sessions: 2, observations: 6, outcomes: { added: 6 } });
    expect(r.results).toHaveLength(6);
    const at = calls.written.map((o) => o.at);
    expect(at).toEqual([...at].sort());
    expect(calls.written.map((o) => o.sessionId)).toEqual([
      OTHER,
      OTHER,
      OTHER,
      SESSION,
      SESSION,
      SESSION,
    ]);
  });

  it('import.sets-cursors-so-stop-skips-imported-turns', async () => {
    const t = tempHome();
    const dir = projects(t);
    const deps = makeDeps(t);
    await importTranscripts({ projectsDir: dir, estimateOnly: false }, deps);
    expect(await deps.store.getCursor(`claude-code:${SESSION}`)).toBe('a-0003b');
    expect(await deps.store.getCursor(`claude-code:${OTHER}`)).toBe('o-a-0003b');
    await handleStop(
      {
        transcript_path: path.join(dir, '-synthetic-project-a', `${SESSION}.jsonl`),
        session_id: SESSION,
        cwd: t.cwd,
        stop_hook_active: false,
      },
      deps,
    );
    expect(queueLines(t.home)).toEqual([]);

    // Importing again finds nothing new.
    const again = await importTranscripts({ projectsDir: dir, estimateOnly: false }, deps);
    expect(again).toMatchObject({ sessions: 0, observations: 0, estimatedTokens: 0 });
  });

  it('import.respects-existing-cursor', async () => {
    const t = tempHome();
    const deps = makeDeps(t);
    await deps.store.setCursor(`claude-code:${SESSION}`, 'a-0001c');
    const r = await importTranscripts({ projectsDir: projects(t), estimateOnly: true }, deps);
    expect(r).toMatchObject({ sessions: 2, observations: 5 });
  });

  it('import.scrubs-before-observe', async () => {
    const t = tempHome();
    const calls = newCalls();
    const deps = makeDeps(t, { calls });
    const now = new Date('2026-11-03T12:00:00Z');
    const r = await importTranscripts(
      { projectsDir: projects(t), estimateOnly: false },
      { ...deps, now: () => now },
    );
    expect(calls.written).toHaveLength(6);
    expect(JSON.stringify(calls.written)).not.toContain(AWS_KEY);
    expect(JSON.stringify(calls.written)).toContain('[REDACTED:aws-access-key]');

    const evalFile = path.join(t.home, 'eval', 'import-2026-11-03.jsonl');
    const rows = fs
      .readFileSync(evalFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const added = (r.results ?? []).filter((x) => x.outcome === 'added');
    expect(rows).toHaveLength(added.length);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        'asOf',
        'expectedMemoryIds',
        'memoryId',
        'question',
      ]);
      expect(row['question']).toBe('');
      expect(row['expectedMemoryIds']).toEqual([row['memoryId']]);
    }
    expect(rows[0]?.['asOf']).toBe('2026-09-01T09:00:04.000Z');
    expect(fs.readFileSync(evalFile, 'utf8')).not.toContain(AWS_KEY);
    if (process.platform !== 'win32') {
      expect(fs.statSync(evalFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(evalFile)).mode & 0o777).toBe(0o700);
    }
  });

  it('import.refuses-without-adapters', async () => {
    const t = tempHome();
    const { write: _w, ...deps } = makeDeps(t);
    await expect(
      importTranscripts({ projectsDir: projects(t), estimateOnly: false }, deps),
    ).rejects.toThrow(/adapters/);
    expect(
      (await importTranscripts({ projectsDir: projects(t), estimateOnly: true }, deps))
        .observations,
    ).toBe(6);
  });
});
