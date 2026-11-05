import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The wire format between the hooks and `oort serve` (CON-18), shared by the client and the
 * daemon. It imports Node built-ins only: the hook client loads it on every prompt.
 *
 * A frame is a 4-byte big-endian length, then that many bytes of UTF-8 JSON. A request is
 * `{ v, id, method, params }`; its response is `{ v, id, ok: true, result }` or
 * `{ v, id, ok: false, error: { code, message } }`. `v` is PROTOCOL_VERSION: either side drops a
 * frame with another version (the hook then runs in-process).
 */
export const PROTOCOL_VERSION = 1;

/** A frame longer than this is refused (a prompt pasted whole still fits). */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export const METHODS = ['ping', 'status', 'stop', 'hook', 'recall'] as const;
export type Method = (typeof METHODS)[number];

/** The hook events the daemon serves: the two that inject context. Stop and drain stay in-process. */
export const SERVED_EVENTS = ['UserPromptSubmit', 'SessionStart'] as const;
export type ServedEvent = (typeof SERVED_EVENTS)[number];

export const isServedEvent = (e: string): e is ServedEvent =>
  (SERVED_EVENTS as readonly string[]).includes(e);

export type ErrorCode =
  | 'bad-frame'
  | 'bad-request'
  | 'unknown-method'
  | 'protocol'
  | 'version-mismatch'
  | 'migration-required'
  | 'busy'
  | 'shutting-down'
  | 'internal';

export interface Request {
  v: number;
  id: number;
  method: Method;
  params: Record<string, unknown>;
}

export type Response =
  | { v: number; id: number; ok: true; result: Record<string, unknown> }
  | { v: number; id: number | null; ok: false; error: { code: ErrorCode; message: string } };

/** One frame: the length prefix and the JSON body. */
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new RangeError('frame too large');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Splits a byte stream into frames. `push` returns the complete frames' bodies parsed as JSON;
 * a length over MAX_FRAME_BYTES or a body that is not JSON throws, and the connection is then
 * dropped (a frame boundary cannot be trusted after either).
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    for (;;) {
      if (this.buf.length < 4) return out;
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) throw new RangeError('frame too large');
      if (this.buf.length < 4 + len) return out;
      const body = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      out.push(JSON.parse(body));
    }
  }
}

/** The longest Unix socket path the platforms take (macOS: 104 bytes with the NUL). */
const SUN_PATH_MAX = 103;

/**
 * Where the daemon for `home` listens: `<home>/oort.sock`, or, when that path is too long for a
 * Unix socket, `/tmp/oort-<uid>/<hash of home>.sock` (a directory checked like the home). One
 * daemon per Oort home: a hook with another `OORT_HOME` finds another socket, or none.
 */
export function socketPathFor(home: string): string {
  const preferred = path.join(home, 'oort.sock');
  if (Buffer.byteLength(preferred) <= SUN_PATH_MAX) return preferred;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const hash = fnv1a64(home);
  return path.join('/tmp', `oort-${uid}`, `${hash}.sock`);
}

/**
 * FNV-1a, 64 bits, as 16 hex digits: names the fallback socket after the home. Not a security
 * boundary (the directory's ownership is); node:crypto alone would cost the hook 2 ms to load.
 */
function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, 'utf8')) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** The single-instance lock beside the socket: the daemon's pid, created exclusively. */
export const lockPathFor = (socket: string): string => socket.replace(/\.sock$/, '.pid');

/**
 * Oort's home, as `resolveHome` in @oortmem/core computes it (repeated here so the hook client
 * does not load core): `OORT_HOME` resolved against the cwd, else `$HOME/.oort`.
 */
export function homeFrom(env: Record<string, string | undefined>, homedir: () => string): string {
  const set = env['OORT_HOME'];
  if (set !== undefined && set !== '') return path.resolve(set);
  const home = env['HOME'];
  return path.resolve(home !== undefined && home !== '' ? home : homedir(), '.oort');
}

/**
 * This CLI's version, from its package.json (core's VERSION matches it: `release-check` fails
 * otherwise). Read once; the client sends it so a daemon from another install is never used.
 */
let cachedVersion: string | undefined;
export function cliVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const raw = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    cachedVersion = typeof raw.version === 'string' ? raw.version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}
