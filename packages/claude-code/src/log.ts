import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendPrivateFile } from '@oortmem/core';

/**
 * One JSON line per hook run in `$OORT_HOME/logs/hooks.log`. Entries hold ids,
 * outcomes, counts and timings only, never prompt, memory or transcript text:
 * the logger takes no free-form string beyond the fields below, and callers
 * pass outcome names they choose, never input.
 */
export interface HookLogEntry {
  ts: string;
  event: string;
  /** Claude Code's session id (sanitised). */
  session: string | null;
  project: string | null;
  outcome: string;
  counts: Record<string, number>;
  timings: Record<string, number>;
  degraded?: string[];
  /** Queue line ids (random uuids), e.g. for dead-lettered lines. */
  ids?: string[];
}

export interface HookLogger {
  /** Appends one line. Never throws: a broken log must not break a session. */
  write(entry: Omit<HookLogEntry, 'ts'> & { ts?: string }): void;
}

/** The log rotates to `hooks.log.1` (one rotation kept) once it exceeds this. */
export const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

const ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Ids and outcome names are ours, but are clamped to a safe charset anyway. */
function safeId(v: string | null): string | null {
  if (v === null) return null;
  return ID.test(v) ? v : '[invalid]';
}

function numbers(r: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r))
    if (typeof v === 'number') out[k] = Math.round(v * 10) / 10;
  return out;
}

export function createHookLogger(home: string, opts: { maxBytes?: number } = {}): HookLogger {
  const file = path.join(home, 'logs', 'hooks.log');
  const maxBytes = opts.maxBytes ?? HOOK_LOG_MAX_BYTES;
  return {
    write(entry) {
      try {
        const line: HookLogEntry = {
          ts: entry.ts ?? new Date().toISOString(),
          event: entry.event,
          session: safeId(entry.session),
          project: safeId(entry.project),
          outcome: entry.outcome,
          counts: numbers(entry.counts),
          timings: numbers(entry.timings),
          ...(entry.degraded !== undefined && entry.degraded.length > 0
            ? { degraded: entry.degraded }
            : {}),
          ...(entry.ids !== undefined && entry.ids.length > 0
            ? { ids: entry.ids.map((id) => safeId(id) ?? '[invalid]') }
            : {}),
        };
        try {
          if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
        } catch {
          // No log yet, or a concurrent hook rotated it first.
        }
        appendPrivateFile(file, `${JSON.stringify(line)}\n`);
      } catch {
        // Logging is best effort.
      }
    },
  };
}
