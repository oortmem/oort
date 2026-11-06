import { scrub, scrubObservation, type Redaction } from '@oortmem/core';
import type { CloudObservation } from './cloud.js';

/**
 * Every write to Oort Cloud is scrubbed on this machine first, with the same scrubber the local
 * write path uses, so a secret never leaves it (the API scrubs again). A turn that is mostly
 * secret is `dropped`: the caller sends nothing and reports `skipped` with reason `secret`, as
 * the local write path does.
 */

export interface ScrubbedTurn {
  turn: CloudObservation;
  dropped: boolean;
  redactions: Redaction[];
}

/** One turn (user, assistant, tool summaries) as it may leave the machine. */
export function scrubForCloud(turn: CloudObservation): ScrubbedTurn {
  const s = scrubObservation({
    userText: turn.user,
    assistantText: turn.assistant,
    toolSummaries: turn.tools ?? [],
    at: turn.at ?? '',
  });
  return {
    turn: {
      ...turn,
      user: s.obs.userText,
      assistant: s.obs.assistantText,
      ...(turn.tools !== undefined && { tools: s.obs.toolSummaries }),
    },
    dropped: s.dropped,
    redactions: s.redactions,
  };
}

/** Free text bound for Oort Cloud (a share's edited text), scrubbed. */
export function scrubTextForCloud(text: string): { text: string; dropped: boolean } {
  const r = scrub(text);
  return { text: r.text, dropped: r.secretRatio > 0.5 };
}

/**
 * One line of a v1 export bound for `oort cloud import`: its `text` and `stub` scrubbed again
 * (they were scrubbed when saved locally; this is cheap insurance). Every other field, and the
 * line count the resume logic relies on, stays as it is. A line that is not a JSON object passes
 * through: the API refuses it.
 */
export function scrubExportLine(line: string): string {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return line;
  }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return line;
  const rec = m as Record<string, unknown>;
  let changed = false;
  for (const k of ['text', 'stub'] as const) {
    const v = rec[k];
    if (typeof v !== 'string') continue;
    const clean = scrub(v).text;
    if (clean !== v) {
      rec[k] = clean;
      changed = true;
    }
  }
  return changed ? JSON.stringify(rec) : line;
}
