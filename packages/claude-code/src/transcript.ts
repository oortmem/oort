import * as fs from 'node:fs';
import { scrub, type Observation } from '@oortmem/core';

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
  /** Byte offset in the file of the turn's first row (the parsed text's `base` plus its position). */
  offset: number;
}

/**
 * XML-style blocks Claude Code writes into user rows on the harness's behalf:
 * background-task reports, `!` shell mode, slash commands and their local
 * output, and system reminders (which carry hook context). They are not the
 * user's words and are stripped, tag and content, before a row becomes text.
 */
export const HARNESS_TAGS = [
  'task-notification',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-caveat',
  'system-reminder',
] as const;

/**
 * Oort's own injected block (see `formatForInjection`). Stripped from user and
 * assistant text alike, so recalled memories are never observed back into memory.
 */
export const OORT_MEMORY_TAG = 'oort-memory';

/** Attributes on an opening tag are scanned at most this far, so a `<tag` with no `>` costs O(1). */
const MAX_OPEN_TAG_ATTRS = 256;

interface TagSet {
  names: ReadonlySet<string>;
  /** Sticky: an opening tag of one of `names`, at `lastIndex`. */
  open: RegExp;
}

function tagSet(tags: readonly string[]): TagSet {
  return {
    names: new Set(tags),
    open: new RegExp(`<(${tags.join('|')})(?:\\s[^>]{0,${MAX_OPEN_TAG_ATTRS}})?>`, 'y'),
  };
}
const USER_BLOCKS = tagSet([...HARNESS_TAGS, OORT_MEMORY_TAG]);
const ASSISTANT_BLOCKS = tagSet([OORT_MEMORY_TAG]);

/**
 * Removes whole `<tag …>…</tag>` blocks for the tags in `set`: each block ends
 * at the first matching close after it (non-greedy, across lines); an opening
 * tag with no close is left as text. A linear scan: every tag's closing-tag
 * search only moves forward, and a tag found to have no later close is never
 * searched again, so unclosed tags cannot make it quadratic. Whitespace is
 * tidied only when something was removed.
 */
function stripBlocks(text: string, set: TagSet): string {
  if (!text.includes('<')) return text;
  /** Per tag: the next close found (start, end), or null once none remains. */
  const closes = new Map<string, { start: number; end: number } | null>();
  const findClose = (tag: string, from: number): { start: number; end: number } | null => {
    const cached = closes.get(tag);
    if (cached === null) return null;
    if (cached !== undefined && cached.start >= from) return cached;
    const needle = `</${tag}`;
    let p = from;
    for (;;) {
      const k = text.indexOf(needle, p);
      if (k < 0) {
        closes.set(tag, null);
        return null;
      }
      let e = k + needle.length;
      while (e < text.length && /\s/.test(text[e] ?? '')) e++;
      if (text[e] === '>') {
        const found = { start: k, end: e + 1 };
        closes.set(tag, found);
        return found;
      }
      p = k + 1;
    }
  };

  let out = '';
  let i = 0;
  let removed = false;
  for (;;) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    set.open.lastIndex = lt;
    const m = set.open.exec(text);
    const tag = m?.[1];
    if (m === null || tag === undefined || !set.names.has(tag)) {
      out += text.slice(i, lt + 1);
      i = lt + 1;
      continue;
    }
    const afterOpen = lt + m[0].length;
    const close = findClose(tag, afterOpen);
    if (close === null) {
      out += text.slice(i, afterOpen);
      i = afterOpen;
      continue;
    }
    out += text.slice(i, lt);
    i = close.end;
    removed = true;
  }
  if (!removed) return text;
  out += text.slice(i);
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const TOOL_INPUT_CHARS = 120;
const TOOL_RESULT_CHARS = 200;
/**
 * Scrubbing looks this far past the cut, so a secret that straddles the cut is
 * seen whole (the longest secrets the scrubber knows, PEM keys, fit easily).
 */
const SCRUB_LOOKAHEAD = 8192;
const MARKER = /\[REDACTED:[a-z0-9-]*\]/g;

/**
 * Scrubs `s` before cutting it to `n` chars: cutting first would leave a
 * secret's prefix that the scrubber no longer recognises. A cut that would
 * fall inside a `[REDACTED:…]` marker moves to just before it.
 */
export function scrubThenCut(s: string, n: number): string {
  const clean = scrub(s.length > n + SCRUB_LOOKAHEAD ? s.slice(0, n + SCRUB_LOOKAHEAD) : s).text;
  if (clean.length <= n) return clean;
  let cut = n;
  MARKER.lastIndex = 0;
  for (let m = MARKER.exec(clean); m !== null && m.index < n; m = MARKER.exec(clean)) {
    if (m.index + m[0].length > n) cut = m.index;
  }
  return clean.slice(0, cut);
}

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

/**
 * Scrubs every string leaf of a tool input before it is serialised:
 * `JSON.stringify` turns a newline into a literal `\n`, and a secret right
 * after it would then follow a letter. Only what can reach the summary is
 * scrubbed, so a huge input stays cheap: a leaf is cut to the remaining budget
 * and leaves past it are emptied (serialising only lengthens text, so the
 * budget still covers the summary and the scrub lookahead after it).
 */
function scrubLeaves(v: unknown, budget: { left: number }): unknown {
  if (typeof v === 'string') {
    if (budget.left <= 0) return '';
    const s = v.length > budget.left ? v.slice(0, budget.left) : v;
    budget.left -= s.length;
    return scrub(s).text;
  }
  if (Array.isArray(v)) return v.map((x) => scrubLeaves(x, budget));
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      budget.left -= k.length;
      Object.defineProperty(out, k, {
        value: scrubLeaves(x, budget),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return v;
}

function toolUseSummary(b: Block): string {
  const name = str(b['name']) ?? 'tool';
  let input: string;
  try {
    const budget = { left: TOOL_INPUT_CHARS + SCRUB_LOOKAHEAD };
    input = JSON.stringify(scrubLeaves(b['input'] ?? {}, budget)) ?? '';
  } catch {
    input = '';
  }
  return `${name}(${scrubThenCut(input, TOOL_INPUT_CHARS)})`;
}

function toolResultSummary(b: Block): string {
  return `result: ${scrubThenCut(resultText(b['content']), TOOL_RESULT_CHARS)}`;
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
 *   their results to the previous turn and their text to a new user turn;
 * - `HARNESS_TAGS` blocks and `<oort-memory>` are stripped from user text, and
 *   `<oort-memory>` from assistant text; a user row holding only harness output
 *   becomes a user turn with empty text, so the reply to it is a turn of its own.
 */
export function parseTranscriptDetailed(jsonl: string, base = 0): DetailedTurn[] {
  const out: DetailedTurn[] = [];
  let pos = base;
  for (const line of jsonl.split('\n')) {
    const offset = pos;
    pos += Buffer.byteLength(line, 'utf8') + 1;
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
    const tags = role === 'user' ? USER_BLOCKS : ASSISTANT_BLOCKS;
    const raw = texts.filter((t) => t.length > 0).join('\n');
    const text = stripBlocks(raw, tags);
    const prev = out.at(-1);

    if (role === 'user') {
      if (results.length > 0 && prev !== undefined) prev.turn.toolSummaries.push(...results);
      // A tool-result row (even one carrying a system reminder) stays part of the turn.
      if (text.length === 0 && (raw.length === 0 || results.length > 0)) continue;
      // A row of only harness output becomes an empty user turn: what Claude says
      // next answers the harness, not the previous prompt.
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
        offset,
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
      offset,
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
 * Per turn, its own timestamp when it parses, else the nearest turn's that
 * does (earlier first on a tie), else `""` (observe then uses its own time).
 * Linear: one pass each way.
 */
function nearestKnownTimestamps(turns: Turn[]): string[] {
  const known = (t: Turn | undefined): boolean =>
    t !== undefined && t.timestamp !== '' && !Number.isNaN(Date.parse(t.timestamp));
  const prev: number[] = [];
  let last = -1;
  turns.forEach((t, i) => {
    if (known(t)) last = i;
    prev.push(last);
  });
  const out: string[] = Array.from({ length: turns.length }, () => '');
  let next = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (known(turns[i])) next = i;
    const p = prev[i] as number;
    const pick = p < 0 ? next : next < 0 ? p : i - p <= next - i ? p : next;
    out[i] = pick < 0 ? '' : (turns[pick] as Turn).timestamp;
  }
  return out;
}

/**
 * One observation per user→assistant pair, at the assistant turn's timestamp
 * (or the nearest known one when it has none, see `nearestKnownTimestamps`).
 * Consecutive user turns (an interrupted prompt and its retry) are joined; an
 * assistant turn without a user turn before it, and a trailing unanswered user
 * turn, yield nothing. A reply to harness-only rows (a background task report,
 * say) is observed with `userText: ""`: no text is invented for the user. When
 * both sides are empty after stripping, the pair yields nothing.
 */
export function pairTurns(turns: Turn[]): PairedObservation[] {
  const at = nearestKnownTimestamps(turns);
  const out: PairedObservation[] = [];
  let pending: Turn[] = [];
  turns.forEach((t, i) => {
    if (t.role === 'user') {
      pending.push(t);
      return;
    }
    if (pending.length === 0) return;
    const userText = pending
      .map((u) => u.text)
      .filter((x) => x.length > 0)
      .join('\n');
    if (userText.length === 0 && t.text.length === 0) {
      pending = [];
      return;
    }
    out.push({
      obs: {
        userText,
        assistantText: t.text,
        toolSummaries: [...pending.flatMap((u) => u.toolSummaries), ...t.toolSummaries],
        sessionId: t.sessionId,
        turnRef: t.uuid,
        at: at[i] as string,
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

/** What `readTranscriptFrom` read. */
export interface TranscriptRead {
  text: string;
  /** Byte offset of `text` in the file: the offset asked for, or 0 when the file is shorter. */
  base: number;
  bytes: number;
}

/**
 * The transcript from byte `offset` to its end. A file shorter than `offset` (truncated, or a new
 * file at the same path) is read whole, with `base: 0`. A row still being written at the end is
 * returned as is; it fails to parse and is skipped, and the next read starts before it.
 */
export function readTranscriptFrom(file: string, offset: number): TranscriptRead {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const base = offset > 0 && offset <= size ? offset : 0;
    const buf = Buffer.allocUnsafe(size - base);
    let n = 0;
    while (n < buf.length) {
      const r = fs.readSync(fd, buf, n, buf.length - n, base + n);
      if (r === 0) break;
      n += r;
    }
    return { text: buf.toString('utf8', 0, n), base, bytes: n };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Where the next incremental read should start so that it sees `cursor` again with everything
 * `selectAfterCursor` needs around it: the first of the user turns before the assistant turn
 * holding `cursor` (so a pair, or a turn that grows later, is re-read whole). Undefined when no
 * turn holds `cursor`.
 */
export function resumeOffset(detailed: DetailedTurn[], cursor: string): number | undefined {
  for (let i = detailed.length - 1; i >= 0; i--) {
    if (!detailed[i]?.rowUuids.includes(cursor)) continue;
    let j = i;
    while (j > 0 && detailed[j - 1]?.turn.role === 'user') j--;
    return detailed[j]?.offset;
  }
  return undefined;
}
