import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  linkProject,
  projectIdFor,
  scrubObservation,
  type Memory,
  type MemoryWriter,
} from '@oortmem/core';
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
import { importTranscripts, type TranscriptImportProgress } from './import.js';
import { parseTranscript, turnsToObservations } from './transcript.js';
import { TG } from '@oortmem/core/store-conformance';
import { localGrant } from '@oortmem/core';

const OTHER = '22222222-2222-4222-8222-222222222222';
const LOCAL = { orgId: 'local', customerId: 'self', agentId: 'claude-code', projectIds: [null] };

/** Local scope, for the project at `t.cwd` plus global memories. */
const scopeOf = (t: TempHome) => ({ ...LOCAL, projectIds: [projectIdFor(t.cwd) ?? null, null] });

/**
 * Two sessions in a resolvable project (a git repo at `t.cwd`): the fixture
 * session, and a second session whose turns are all older.
 */
function projects(t: TempHome): string {
  fs.mkdirSync(path.join(t.cwd, '.git'), { recursive: true });
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
    expect(r).toEqual({
      sessions: 2,
      observations: 10,
      estimatedTokens: expectedTokens(t),
      skippedUnresolved: 0,
      skippedUnreadable: 0,
    });
    expect(await deps.store.list(localGrant(scopeOf(t)), { validOnly: false })).toEqual([]);
    expect(await deps.store.getCursor(TG, `claude-code:${SESSION}`)).toBeNull();
    expect(await deps.store.getCursor(TG, `claude-code:${OTHER}`)).toBeNull();
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
    expect(r).toMatchObject({ sessions: 1, observations: 5 });
  });

  it('import.oldest-first', async () => {
    const t = tempHome();
    const calls = newCalls();
    const deps = makeDeps(t, { calls });
    const r = await importTranscripts({ projectsDir: projects(t), estimateOnly: false }, deps);
    expect(r).toMatchObject({ sessions: 2, observations: 10, outcomes: { added: 10 } });
    expect(r.results).toHaveLength(10);
    const at = calls.written.map((o) => o.at);
    expect(at).toEqual([...at].sort());
    expect(calls.written.map((o) => o.sessionId)).toEqual([
      ...Array<string>(5).fill(OTHER),
      ...Array<string>(5).fill(SESSION),
    ]);
  });

  it('import.recorded-cwd-project-id-needs-link', async () => {
    const t = tempHome();
    const dir = projects(t);
    // The recorded cwd's own oort.config.json names the project; it counts once linked.
    fs.writeFileSync(
      path.join(t.cwd, 'oort.config.json'),
      JSON.stringify({ project: { id: 'pinned-id' } }),
    );
    const deps = makeDeps(t);
    linkProject(t.home, t.cwd, 'pinned-id');
    const done = await importTranscripts({ projectsDir: dir, estimateOnly: false }, deps);
    expect(done).toMatchObject({ observations: 10, outcomes: { added: 10 } });
    const linked = { ...LOCAL, projectIds: ['cfg:pinned-id'] };
    expect(await deps.store.list(localGrant(linked), { validOnly: false })).toHaveLength(10);
    expect(await deps.store.list(localGrant(scopeOf(t)), { validOnly: false })).toEqual([]);
  });

  it('import.untrusted-project-id-keeps-derived', async () => {
    const t = tempHome();
    const dir = projects(t);
    fs.writeFileSync(
      path.join(t.cwd, 'oort.config.json'),
      JSON.stringify({ project: { id: 'pinned-id' } }),
    );
    const deps = makeDeps(t);
    await importTranscripts({ projectsDir: dir, estimateOnly: false }, deps);
    expect(await deps.store.list(localGrant(scopeOf(t)), { validOnly: false })).toHaveLength(10);
  });

  it('import.sets-cursors-so-stop-skips-imported-turns', async () => {
    const t = tempHome();
    const dir = projects(t);
    const deps = makeDeps(t);
    await importTranscripts({ projectsDir: dir, estimateOnly: false }, deps);
    expect(await deps.store.getCursor(TG, `claude-code:${SESSION}`)).toBe('a-0015');
    expect(await deps.store.getCursor(TG, `claude-code:${OTHER}`)).toBe('o-a-0015');
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
    await deps.store.setCursor(TG, `claude-code:${SESSION}`, 'a-0001c');
    const r = await importTranscripts({ projectsDir: projects(t), estimateOnly: true }, deps);
    expect(r).toMatchObject({ sessions: 2, observations: 9 });
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
    expect(calls.written).toHaveLength(10);
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
    ).toBe(10);
  });

  /**
   * Resolved (`t.cwd`, a git repo), plus two sessions whose project cannot be
   * resolved: a deleted directory inside another git repo, and a directory
   * that is not in any repo.
   */
  function unresolved(t: TempHome): string {
    const dir = projects(t);
    const parent = path.join(t.root, 'parent-repo');
    fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
    const gone = path.join(parent, 'deleted-private-project');
    const plain = path.join(t.root, 'not-a-repo');
    fs.mkdirSync(plain);
    writeTranscript(path.join(dir, '-gone'), gone, GONE);
    writeTranscript(path.join(dir, '-plain'), plain, PLAIN);
    return dir;
  }
  const GONE = '33333333-3333-4333-8333-333333333333';
  const PLAIN = '44444444-4444-4444-8444-444444444444';
  const GLOBAL_ONLY = { ...LOCAL, projectIds: [null] };

  it('import.skips-unresolved-projects-by-default', async () => {
    const t = tempHome();
    const dir = unresolved(t);
    const deps = makeDeps(t);
    const est = await importTranscripts({ projectsDir: dir, estimateOnly: true }, deps);
    expect(est).toMatchObject({ sessions: 2, observations: 10, skippedUnresolved: 2 });

    const r = await importTranscripts({ projectsDir: dir, estimateOnly: false }, deps);
    expect(r).toMatchObject({ sessions: 2, observations: 10, skippedUnresolved: 2 });
    expect(await deps.store.list(localGrant(GLOBAL_ONLY), { validOnly: false })).toEqual([]);
    const pid = projectIdFor(t.cwd);
    const stored = await deps.store.list(localGrant(scopeOf(t)), { validOnly: false });
    expect(stored).toHaveLength(10);
    expect(stored.every((m: Memory) => m.scope.projectId === pid)).toBe(true);
    expect(await deps.store.getCursor(TG, `claude-code:${GONE}`)).toBeNull();
    expect(await deps.store.getCursor(TG, `claude-code:${PLAIN}`)).toBeNull();
  });

  it('import.include-unresolved-imports-as-global', async () => {
    const t = tempHome();
    const dir = unresolved(t);
    const deps = makeDeps(t);
    const r = await importTranscripts(
      { projectsDir: dir, estimateOnly: false, includeUnresolved: true },
      deps,
    );
    expect(r).toMatchObject({ sessions: 4, observations: 20, skippedUnresolved: 0 });
    const global = await deps.store.list(localGrant(GLOBAL_ONLY), { validOnly: false });
    expect(global).toHaveLength(10);
    expect(global.every((m: Memory) => m.scope.projectId === undefined)).toBe(true);
    expect(await deps.store.getCursor(TG, `claude-code:${GONE}`)).toBe('a-0015');
  });

  it('import.private-project-keeps-project-id', async () => {
    const t = tempHome();
    const dir = projects(t);
    fs.writeFileSync(
      path.join(t.cwd, 'oort.config.json'),
      JSON.stringify({ project: { private: true } }),
    );
    const deps = makeDeps(t);
    await importTranscripts({ projectsDir: dir, estimateOnly: false }, deps);
    const pid = projectIdFor(t.cwd);
    expect(pid).toBeDefined();
    const stored = await deps.store.list(localGrant(scopeOf(t)), { validOnly: false });
    expect(stored).toHaveLength(10);
    expect(stored.every((m: Memory) => m.scope.projectId === pid)).toBe(true);
    // Invisible from global scope and from any other project, even on an exact lexical match.
    const elsewhere = { ...LOCAL, projectIds: [null, 'p-other'] };
    expect(await deps.store.list(localGrant(elsewhere), { validOnly: false })).toEqual([]);
    expect(await deps.store.lexical(localGrant(elsewhere), 'auth service port', 10)).toEqual([]);
  });

  it('import.failure-reason-names-the-error-never-its-message', async () => {
    const t = tempHome();
    const dir = projects(t);
    const base = makeDeps(t, { calls: newCalls() });
    const secret = ['observation', 'text', String(Date.now())].join('-');
    const write: MemoryWriter = {
      async write() {
        throw Object.assign(new Error(secret), { name: 'WriterError', kind: 'auth', status: 401 });
      },
    };
    const r = await importTranscripts(
      { projectsDir: dir, estimateOnly: false },
      { ...base, write },
    );
    const reasons = Object.values(r.failedSessions ?? {}).map((f) => f.reason);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((x) => x === 'WriterError (auth, HTTP 401)')).toBe(true);
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('import.permanent-writer-failure-skips-and-continues', async () => {
    const t = tempHome();
    const dir = projects(t);
    const calls = newCalls();
    const base = makeDeps(t, { calls });
    // The model's output for this one observation never fits the schema: retrying the
    // session later would fail the same way, so it is skipped and the session goes on.
    const write: MemoryWriter = {
      async write(obs, action, prior) {
        if (obs.turnRef === 'o-a-0002')
          throw Object.assign(new Error('x'), { name: 'WriterOutputError', fields: ['text'] });
        return base.write!.write(obs, action, prior);
      },
    };
    const r = await importTranscripts(
      { projectsDir: dir, estimateOnly: false },
      { ...base, write },
    );
    expect(r.outcomes).toEqual({ added: 9, unwritable: 1 });
    expect(r.failedSessions).toBeUndefined();
    expect(r.unwritable).toEqual({ 'WriterOutputError (fields: text)': 1 });
    // A re-run attempts nothing: the cursor moved past the skipped observation.
    const again = await importTranscripts(
      { projectsDir: dir, estimateOnly: false },
      { ...base, write },
    );
    expect(again.observations).toBe(0);
  });

  it('import.counts-each-memory-of-a-split-turn', async () => {
    const t = tempHome();
    const base = makeDeps(t, { calls: newCalls() });
    // A writer that splits every turn into two separate facts (CON-56).
    const write: MemoryWriter = {
      write: (obs, action, prior) => base.write!.write(obs, action, prior),
      async writeMany(obs) {
        const tag = obs.turnRef ?? 'turn';
        return [
          { text: `First fact of ${tag}.`, stub: `first ${tag}`, entities: [], type: 'semantic' },
          { text: `Second fact of ${tag}.`, stub: `second ${tag}`, entities: [], type: 'semantic' },
        ];
      },
    };
    const now = new Date('2026-11-03T12:00:00Z');
    const r = await importTranscripts(
      { projectsDir: projects(t), estimateOnly: false },
      { ...base, write, now: () => now },
    );
    expect(r.observations).toBe(10);
    expect(r.outcomes).toEqual({ added: 20 });
    const rows = fs
      .readFileSync(path.join(t.home, 'eval', 'import-2026-11-03.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(rows).toHaveLength(20);
  });

  it('import.cursor-stops-at-first-failure', async () => {
    const t = tempHome();
    const dir = projects(t);
    const calls = newCalls();
    const base = makeDeps(t, { calls });
    // The older session's second observation fails; nothing after it in that session runs.
    const write: MemoryWriter = {
      async write(obs, action, prior) {
        if (obs.turnRef === 'o-a-0002') throw new Error('writer unavailable');
        return base.write!.write(obs, action, prior);
      },
    };
    const deps = { ...base, write };
    const r = await importTranscripts({ projectsDir: dir, estimateOnly: false }, deps);
    expect(r.outcomes).toEqual({ added: 6, failed: 1 });
    expect(r.failedSessions).toEqual({ [OTHER]: { failed: 1, notAttempted: 3, reason: 'Error' } });
    expect(calls.written.map((o) => o.turnRef)).toEqual([
      'o-a-0001c',
      'a-0001c',
      'a-0002',
      'a-0003b',
      'a-0014',
      'a-0015',
    ]);
    expect(await deps.store.getCursor(TG, `claude-code:${OTHER}`)).toBe('o-a-0001c');
    expect(await deps.store.getCursor(TG, `claude-code:${SESSION}`)).toBe('a-0015');

    // The Stop hook (or a later import) picks the session up where it stopped.
    const again = await importTranscripts({ projectsDir: dir, estimateOnly: true }, base);
    expect(again).toMatchObject({ sessions: 1, observations: 4 });
  });

  it('import.progress-reports-scan-then-each-observation', async () => {
    const t = tempHome();
    const dir = projects(t);
    const seen: TranscriptImportProgress[] = [];
    const est = await importTranscripts(
      { projectsDir: dir, estimateOnly: true, onProgress: (p) => seen.push(p) },
      makeDeps(t),
    );
    // Two transcripts (the subagent and orphaned copies are not sessions), five new turns each.
    expect(seen).toEqual([
      { phase: 'scan', files: 1, totalFiles: 2, turns: 5 },
      { phase: 'scan', files: 2, totalFiles: 2, turns: 10 },
    ]);
    expect(est.observations).toBe(10);

    seen.length = 0;
    const r = await importTranscripts(
      { projectsDir: dir, estimateOnly: false, onProgress: (p) => seen.push(p) },
      makeDeps(t),
    );
    const observed = seen.filter((p) => p.phase === 'observe');
    expect(observed).toHaveLength(10);
    expect(observed.map((p) => p.done)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(observed.at(-1)).toEqual({ phase: 'observe', done: 10, total: 10, kept: 10, failed: 0 });
    expect(r.outcomes).toEqual({ added: 10 });
  });

  it('import.progress-counts-failed-and-not-attempted', async () => {
    const t = tempHome();
    const base = makeDeps(t);
    const write: MemoryWriter = {
      async write(obs, action, prior) {
        if (obs.turnRef === 'o-a-0002') throw new Error('writer unavailable');
        return base.write!.write(obs, action, prior);
      },
    };
    const seen: TranscriptImportProgress[] = [];
    await importTranscripts(
      { projectsDir: projects(t), estimateOnly: false, onProgress: (p) => seen.push(p) },
      { ...base, write },
    );
    // Every observation is finished one way or another: 6 kept, 1 failed, 3 not attempted.
    expect(seen.at(-1)).toEqual({ phase: 'observe', done: 10, total: 10, kept: 6, failed: 1 });
  });

  it('import.signal-stops-between-observations-with-cursors-consistent', async () => {
    const t = tempHome();
    const dir = projects(t);
    const calls = newCalls();
    const deps = makeDeps(t, { calls });
    const stop = new AbortController();
    // Ctrl-C during the second observation: it finishes, nothing after it starts.
    const r = await importTranscripts(
      {
        projectsDir: dir,
        estimateOnly: false,
        signal: stop.signal,
        onProgress: (p) => {
          if (p.phase === 'observe' && p.done === 2) stop.abort();
        },
      },
      deps,
    );
    expect(r.interrupted).toEqual({ notAttempted: 8 });
    expect(r.outcomes).toEqual({ added: 2 });
    expect(calls.written.map((o) => o.turnRef)).toEqual(['o-a-0001c', 'o-a-0002']);
    expect(await deps.store.getCursor(TG, `claude-code:${OTHER}`)).toBe('o-a-0002');
    expect(await deps.store.getCursor(TG, `claude-code:${SESSION}`)).toBeNull();

    // A re-run imports exactly the rest: nothing twice, nothing lost.
    const again = await importTranscripts({ projectsDir: dir, estimateOnly: false }, deps);
    expect(again).toMatchObject({ observations: 8, outcomes: { added: 8 } });
    expect(again.interrupted).toBeUndefined();
    expect(calls.written).toHaveLength(10);
    expect(new Set(calls.written.map((o) => `${o.sessionId}:${o.turnRef}`)).size).toBe(10);
  });

  it('import.counts-unreadable-transcripts', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const t = tempHome();
    const dir = projects(t);
    const locked = path.join(dir, '-synthetic-project-b', `${OTHER}.jsonl`);
    fs.chmodSync(locked, 0o000);
    try {
      const est = await importTranscripts(
        { projectsDir: dir, estimateOnly: true, since: new Date(0) },
        makeDeps(t),
      );
      expect(est).toMatchObject({ sessions: 1, observations: 5, skippedUnreadable: 1 });
    } finally {
      fs.chmodSync(locked, 0o600);
    }
  });
});
