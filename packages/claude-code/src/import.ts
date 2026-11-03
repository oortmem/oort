import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  appendPrivateFile,
  localScope,
  observe,
  projectIdFor,
  scrubObservation,
  type Observation,
  type ObserveResult,
  type Scope,
} from '@oortmem/core';
import type { HookDeps } from './deps.js';
import { cursorKey } from './hooks.js';
import { parseTranscriptDetailed, selectAfterCursor } from './transcript.js';

export interface ImportOptions {
  /** Claude Code's projects directory, usually `~/.claude/projects`. */
  projectsDir: string;
  /** Only transcripts modified at or after this time. */
  since?: Date;
  /** Count and estimate only; write nothing. */
  estimateOnly: boolean;
  /** Share of observations expected to reach the writer (after the gate). Default 0.25. */
  writerFraction?: number;
  /**
   * Import sessions whose project cannot be resolved into global scope.
   * Default false: they are skipped, since a deleted private project's
   * memories would otherwise surface in every project.
   */
  includeUnresolved?: boolean;
}

export interface ImportResult {
  /** Sessions with at least one observation to import. */
  sessions: number;
  observations: number;
  /** Writer tokens: Σ(chars / 4 + 400) × writerFraction. No price table in Phase 1. */
  estimatedTokens: number;
  /**
   * Sessions with observations that were left out because their project could
   * not be resolved (recorded `cwd` gone, or not in a git repository).
   */
  skippedUnresolved: number;
  results?: ObserveResult[];
  /** Per-outcome counts, plus `failed` for observations whose observe threw. */
  outcomes?: Record<string, number>;
}

/** Fixed per-call writer overhead (system prompt, schema), in tokens. */
const WRITER_OVERHEAD_TOKENS = 400;
const DEFAULT_WRITER_FRACTION = 0.25;

interface Item {
  session: string;
  /** Position within the session, oldest first. */
  pos: number;
  obs: Observation;
  scope: Scope;
}

/**
 * Session transcripts: `<projectsDir>/<project>/<session>.jsonl`. Subagent
 * transcripts (one level deeper) and orphaned copies Claude Code set aside
 * (`<session>.orphaned-…jsonl`) are not sessions of their own.
 */
function transcripts(projectsDir: string, since: Date | undefined): string[] {
  const out: string[] = [];
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(projectsDir, p.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl') || f.name.includes('.orphaned-')) continue;
      const file = path.join(dir, f.name);
      if (since !== undefined && fs.statSync(file).mtimeMs < since.getTime()) continue;
      out.push(file);
    }
  }
  return out.sort();
}

/**
 * The session's project id, or undefined when it cannot be resolved. A missing
 * directory is unresolved even inside a git repo: walking up from it would
 * attribute the session to the enclosing repository instead.
 */
function resolveProject(cwd: string | undefined): string | undefined {
  if (cwd === undefined || !fs.existsSync(cwd)) return undefined;
  return projectIdFor(cwd);
}

function chars(o: Observation): number {
  return (
    o.userText.length + o.assistantText.length + o.toolSummaries.reduce((n, s) => n + s.length, 0)
  );
}

/**
 * Imports existing Claude Code transcripts. Every transcript is parsed,
 * paired and scrubbed; turns already behind a session's cursor (observed by
 * the Stop hook or an earlier import) are skipped. With `estimateOnly` it
 * only reports the estimate. Otherwise it observes oldest first across all
 * sessions, advances each session's cursor so the Stop hook never re-observes
 * imported turns, and appends one eval row per added memory to
 * `$OORT_HOME/eval/import-<YYYY-MM-DD>.jsonl`.
 *
 * The scope of each transcript is derived from the `cwd` its rows recorded.
 * A session whose project cannot be resolved is skipped (and counted in
 * `skippedUnresolved`) unless `includeUnresolved` imports it as global.
 */
export async function importTranscripts(
  opts: ImportOptions,
  deps: HookDeps,
): Promise<ImportResult> {
  const items: Item[] = [];
  let weighted = 0;
  const sessions = new Set<string>();
  let skippedUnresolved = 0;
  for (const file of transcripts(opts.projectsDir, opts.since)) {
    const session = path.basename(file, '.jsonl');
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const detailed = parseTranscriptDetailed(text);
    const cwd = detailed.find((d) => d.turn.cwd.length > 0)?.turn.cwd;
    const projectId = resolveProject(cwd);
    const scope = localScope(projectId);
    const { fresh } = selectAfterCursor(detailed, await deps.store.getCursor(cursorKey(session)));
    const mine: Item[] = [];
    for (const raw of fresh) {
      const s = scrubObservation(raw);
      if (s.dropped) continue;
      mine.push({ session, pos: mine.length, obs: s.obs, scope });
    }
    if (mine.length === 0) continue;
    if (projectId === undefined && opts.includeUnresolved !== true) {
      skippedUnresolved++;
      continue;
    }
    for (const item of mine) weighted += chars(item.obs) / 4 + WRITER_OVERHEAD_TOKENS;
    items.push(...mine);
    sessions.add(session);
  }
  const fraction = opts.writerFraction ?? DEFAULT_WRITER_FRACTION;
  const summary = {
    sessions: sessions.size,
    observations: items.length,
    estimatedTokens: Math.ceil(weighted * fraction),
    skippedUnresolved,
  };
  if (opts.estimateOnly) return summary;

  const { embed, decide, write } = deps;
  if (embed === undefined || decide === undefined || write === undefined) {
    throw new Error('import needs the embed, decide and write adapters');
  }
  const at = (o: Observation): number => {
    const t = Date.parse(o.at);
    return Number.isNaN(t) ? 0 : t;
  };
  items.sort((a, b) => at(a.obs) - at(b.obs)); // Stable: ties keep transcript order.

  const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const evalFile = path.join(deps.config.home, 'eval', `import-${day}.jsonl`);
  const results: ObserveResult[] = [];
  const outcomes: Record<string, number> = {};
  const done = new Map<string, number>();
  for (const item of items) {
    try {
      const r = await observe(item.obs, item.scope, {
        store: deps.store,
        embed,
        decide,
        write,
        config: deps.config,
        now: deps.now?.() ?? new Date(),
        harness: 'claude-code',
      });
      results.push(r);
      outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
      if (r.outcome === 'added' && r.memoryId !== undefined) {
        const row = {
          memoryId: r.memoryId,
          question: '',
          expectedMemoryIds: [r.memoryId],
          asOf: item.obs.at,
        };
        appendPrivateFile(evalFile, `${JSON.stringify(row)}\n`);
      }
    } catch {
      outcomes['failed'] = (outcomes['failed'] ?? 0) + 1;
    }
    // The cursor only moves forward within a session, even if timestamps do not.
    const prev = done.get(item.session) ?? -1;
    if (item.pos > prev && item.obs.turnRef !== undefined) {
      await deps.store.setCursor(cursorKey(item.session), item.obs.turnRef);
      done.set(item.session, item.pos);
    }
  }
  return { ...summary, results, outcomes };
}
