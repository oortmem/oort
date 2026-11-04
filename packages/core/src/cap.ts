import type { Observation } from './adapters.js';

/** User and assistant text each reach the gate and writer at no more than this many UTF-8 bytes. */
export const OBSERVATION_TEXT_MAX_BYTES = 32 * 1024;
/** Tool summaries are bounded too: at most this many, each at most `TOOL_SUMMARY_MAX_BYTES`. */
export const TOOL_SUMMARIES_MAX = 16;
export const TOOL_SUMMARY_MAX_BYTES = 512;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8Bytes = (s: string): number => encoder.encode(s).byteLength;

/** Moves `i` back to the start of the UTF-8 sequence it falls inside (continuation bytes are 10xxxxxx). */
function backToBoundary(b: Uint8Array, i: number): number {
  while (i > 0 && i < b.length && (b[i]! & 0xc0) === 0x80) i--;
  return i;
}

/** Moves `i` forward to the next sequence start. */
function forwardToBoundary(b: Uint8Array, i: number): number {
  while (i < b.length && (b[i]! & 0xc0) === 0x80) i++;
  return i;
}

/** The first `max` UTF-8 bytes of `text`, ended on a character boundary (so never inside a surrogate pair). */
export function truncateUtf8(text: string, max: number): string {
  if (text.length * 3 <= max) return text;
  const b = encoder.encode(text);
  if (b.length <= max) return text;
  return decoder.decode(b.subarray(0, backToBoundary(b, max)));
}

/**
 * Caps `text` at `max` UTF-8 bytes, marker included. Keeps the head (about 2/3) and the tail
 * (about 1/3) around a line `[… N bytes omitted …]`; cuts only on character boundaries.
 */
export function capUtf8(text: string, max: number): string {
  if (text.length * 3 <= max) return text;
  const b = encoder.encode(text);
  if (b.length <= max) return text;
  // The marker's number is at most the total length, so reserve for that many digits.
  const reserve = utf8Bytes(`\n[… ${b.length} bytes omitted …]\n`);
  const budget = Math.max(0, max - reserve);
  const headEnd = backToBoundary(b, Math.floor((budget * 2) / 3));
  const tailStart = forwardToBoundary(b, b.length - (budget - Math.floor((budget * 2) / 3)));
  const from = Math.max(tailStart, headEnd);
  const omitted = from - headEnd;
  return (
    decoder.decode(b.subarray(0, headEnd)) +
    `\n[… ${omitted} bytes omitted …]\n` +
    decoder.decode(b.subarray(from))
  );
}

/** The observation with its texts capped, or the same object when nothing needed it. */
export function capObservation(obs: Observation): Observation {
  const userText = capUtf8(obs.userText, OBSERVATION_TEXT_MAX_BYTES);
  const assistantText = capUtf8(obs.assistantText, OBSERVATION_TEXT_MAX_BYTES);
  const tools = obs.toolSummaries
    .slice(0, TOOL_SUMMARIES_MAX)
    .map((t) => truncateUtf8(t, TOOL_SUMMARY_MAX_BYTES));
  const same =
    userText === obs.userText &&
    assistantText === obs.assistantText &&
    tools.length === obs.toolSummaries.length &&
    tools.every((t, i) => t === obs.toolSummaries[i]);
  return same ? obs : { ...obs, userText, assistantText, toolSummaries: tools };
}
