import type { Observation } from '@oortmem/core';

/**
 * Claude Code session transcripts (`~/.claude/projects/<project>/<session>.jsonl`).
 * Only `user` and `assistant` rows carry conversation; every other row type
 * (`attachment`, `system`, `api-request`, `file-history-snapshot`,
 * `queue-operation`, titles, cost state, ...) is skipped.
 */

export interface Turn {
  /** The last row of the turn (for an assistant turn: its last assistant row). */
  uuid: string;
  /** The first row's parent. */
  parentUuid: string | null;
  role: 'user' | 'assistant';
  text: string;
  toolSummaries: string[];
  /** The last row's timestamp. */
  timestamp: string;
  sessionId: string;
  cwd: string;
}

/** A turn plus the uuids of every message row merged into it, in order. */
export interface DetailedTurn {
  turn: Turn;
  rowUuids: string[];
}

const TOOL_INPUT_CHARS = 120;
const TOOL_RESULT_CHARS = 200;

/**
 * Cheap pre-filter: a message row always carries a top-level `"type":"user"` or
 * `"type":"assistant"`. Lines without either (the bulky `api-request` rows, for
 * one) are never handed to `JSON.parse`. Nested occurrences inside strings are
 * escaped (`\"type\"`), so they never match.
 */
const MESSAGE_ROW = /"type":\s*"(?:user|assistant)"/;

type Row = Record<string, unknown>;
type Block = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function blocksOf(content: unknown): Block[] | string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content.filter((b): b is Block => typeof b === 'object' && b !== null);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as unknown[]) {
    if (typeof b === 'object' && b !== null && (b as Block)['type'] === 'text') {
      const t = str((b as Block)['text']);
      if (t !== undefined) parts.push(t);
    }
  }
  return parts.join('\n');
}

function toolUseSummary(b: Block): string {
  const name = str(b['name']) ?? 'tool';
  let input: string;
  try {
    input = JSON.stringify(b['input'] ?? {}) ?? '';
  } catch {
    input = '';
  }
  return `${name}(${input.slice(0, TOOL_INPUT_CHARS)})`;
}

function toolResultSummary(b: Block): string {
  return `result: ${resultText(b['content']).slice(0, TOOL_RESULT_CHARS)}`;
}

/** A row that is conversation: a user or assistant message on the main chain, not injected. */
function messageRow(line: string): Row | undefined {
  if (!MESSAGE_ROW.test(line)) return undefined;
  let r: unknown;
  try {
    r = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return undefined;
  const row = r as Row;
  if (row['type'] !== 'user' && row['type'] !== 'assistant') return undefined;
  if (row['isSidechain'] === true) return undefined;
  // Injected rows: caveats, skill bodies, compaction summaries, synthetic API errors.
  if (
    row['isMeta'] === true ||
    row['isCompactSummary'] === true ||
    row['isVisibleInTranscriptOnly'] === true ||
    row['isApiErrorMessage'] === true
  ) {
    return undefined;
  }
  if (typeof row['uuid'] !== 'string') return undefined;
  const message = row['message'];
  if (typeof message !== 'object' || message === null) return undefined;
  return row;
}

/**
 * Parses a transcript into alternating user and assistant turns, keeping the
 * uuids of the rows behind each turn. Rules:
 * - only `user`/`assistant` rows; sidechain, meta and malformed rows are skipped;
 * - consecutive assistant rows (Claude Code writes one row per content block)
 *   merge into one assistant turn; `thinking` blocks are ignored;
 * - `tool_use` blocks become `"<name>(<first 120 chars of input>)"` summaries;
 * - a user row holding only `tool_result` blocks merges into the previous
 *   turn's summaries as `"result: <first 200 chars>"`; mixed rows contribute
 *   their results to the previous turn and their text to a new user turn.
 */
export function parseTranscriptDetailed(jsonl: string): DetailedTurn[] {
  const out: DetailedTurn[] = [];
  for (const line of jsonl.split('\n')) {
    const row = messageRow(line);
    if (row === undefined) continue;
    const role = row['type'] as 'user' | 'assistant';
    const uuid = row['uuid'] as string;
    const content = blocksOf((row['message'] as Row)['content']);
    if (content === undefined) continue;

    const texts: string[] = [];
    const summaries: string[] = [];
    const results: string[] = [];
    if (typeof content === 'string') {
      texts.push(content);
    } else {
      for (const b of content) {
        const type = b['type'];
        if (type === 'text') {
          const t = str(b['text']);
          if (t !== undefined) texts.push(t);
        } else if (type === 'tool_use') {
          summaries.push(toolUseSummary(b));
        } else if (type === 'tool_result') {
          results.push(toolResultSummary(b));
        }
      }
    }
    const text = texts.filter((t) => t.length > 0).join('\n');
    const prev = out.at(-1);

    if (role === 'user') {
      if (results.length > 0 && prev !== undefined) prev.turn.toolSummaries.push(...results);
      if (text.length === 0) continue;
      out.push({
        turn: {
          uuid,
          parentUuid: str(row['parentUuid']) ?? null,
          role,
          text,
          toolSummaries: [],
          timestamp: str(row['timestamp']) ?? '',
          sessionId: str(row['sessionId']) ?? '',
          cwd: str(row['cwd']) ?? '',
        },
        rowUuids: [uuid],
      });
      continue;
    }

    if (prev?.turn.role === 'assistant') {
      const t = prev.turn;
      if (text.length > 0) t.text = t.text.length > 0 ? `${t.text}\n${text}` : text;
      t.toolSummaries.push(...summaries);
      t.uuid = uuid;
      t.timestamp = str(row['timestamp']) ?? t.timestamp;
      prev.rowUuids.push(uuid);
      continue;
    }
    out.push({
      turn: {
        uuid,
        parentUuid: str(row['parentUuid']) ?? null,
        role,
        text,
        toolSummaries: summaries,
        timestamp: str(row['timestamp']) ?? '',
        sessionId: str(row['sessionId']) ?? '',
        cwd: str(row['cwd']) ?? '',
      },
      rowUuids: [uuid],
    });
  }
  return out;
}

export function parseTranscript(jsonl: string): Turn[] {
  return parseTranscriptDetailed(jsonl).map((d) => d.turn);
}

/** An observation and the index (into the turn list) of the assistant turn it came from. */
export interface PairedObservation {
  obs: Observation;
  assistantIndex: number;
}

/**
 * One observation per user→assistant pair, at the assistant turn's timestamp.
 * Consecutive user turns (an interrupted prompt and its retry) are joined; an
 * assistant turn without a user turn before it, and a trailing unanswered user
 * turn, yield nothing.
 */
export function pairTurns(turns: Turn[]): PairedObservation[] {
  const out: PairedObservation[] = [];
  let pending: Turn[] = [];
  turns.forEach((t, i) => {
    if (t.role === 'user') {
      pending.push(t);
      return;
    }
    if (pending.length === 0) return;
    out.push({
      obs: {
        userText: pending.map((u) => u.text).join('\n'),
        assistantText: t.text,
        toolSummaries: [...pending.flatMap((u) => u.toolSummaries), ...t.toolSummaries],
        sessionId: t.sessionId,
        turnRef: t.uuid,
        at: t.timestamp,
      },
      assistantIndex: i,
    });
    pending = [];
  });
  return out;
}

export function turnsToObservations(turns: Turn[]): Observation[] {
  return pairTurns(turns).map((p) => p.obs);
}

export interface CursorSelection {
  /** Observations after the cursor, oldest first. */
  fresh: Observation[];
  /** False when a cursor was set but no row of this transcript carries it. */
  cursorFound: boolean;
}

/**
 * Observations not yet processed, given `cursor` (the uuid of the last
 * processed assistant row). When the cursor sits inside a turn rather than at
 * its end, the turn grew after it was processed (the transcript lagged, or a
 * stop hook made Claude continue), so it is taken again.
 */
export function selectAfterCursor(
  detailed: DetailedTurn[],
  cursor: string | null,
): CursorSelection {
  const paired = pairTurns(detailed.map((d) => d.turn));
  if (cursor === null) return { fresh: paired.map((p) => p.obs), cursorFound: true };
  for (let i = detailed.length - 1; i >= 0; i--) {
    const d = detailed[i];
    if (d === undefined || d.turn.role !== 'assistant') continue;
    const at = d.rowUuids.lastIndexOf(cursor);
    if (at < 0) continue;
    const from = at === d.rowUuids.length - 1 ? i + 1 : i;
    return {
      fresh: paired.filter((p) => p.assistantIndex >= from).map((p) => p.obs),
      cursorFound: true,
    };
  }
  return { fresh: paired.map((p) => p.obs), cursorFound: false };
}
