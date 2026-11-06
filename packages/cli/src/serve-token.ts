import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { writePrivateFile } from '@oortmem/core';
import type { Env } from './io.js';
import { currentUid } from './serve-protocol.js';
import { TOKEN_PATTERN, digestOf, type ServiceAuth } from './serve-http.js';
import { NAME } from './sdk/validate.js';
import { Refusal, echo, shown } from './util.js';

/**
 * Service mode's settings (`oort serve --listen`, CON-108 §9.4): where it listens, the tokens it
 * accepts and the org they act in. Every check here runs before the daemon opens anything, and
 * each failure is a refusal to start: there is no TCP listener without a token.
 */

/** The token file `oort serve token` writes: `<OORT_HOME>/serve.token`, mode 600. */
export const tokenPathFor = (home: string): string => path.join(home, 'serve.token');

/** The variables that carry a token: read once, then removed from every child's environment. */
export const TOKEN_ENV = ['OORT_SERVE_TOKEN', 'OORT_SERVE_TOKEN_FILE'] as const;

/** A new service token: 256 random bits as base64url (43 characters). */
export const newToken = (): string => randomBytes(32).toString('base64url');

/**
 * Writes a new token to `<home>/serve.token` (0600, atomically, in a 0700 home). An existing file
 * is kept unless `rotate`: replacing it locks out every client that has the old one.
 */
export function writeTokenFile(home: string, rotate: boolean): { file: string; created: boolean } {
  const file = tokenPathFor(home);
  let exists = false;
  try {
    fs.lstatSync(file);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists && !rotate) return { file, created: false };
  writePrivateFile(file, `${newToken()}\n`);
  return { file, created: true };
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * A token file's contents, refused unless it is a regular file of this user's that `others` may
 * neither read nor write (`mask`: 0o077 for the home's own file, 0o007 for a mounted secret,
 * which a group may share). The home's file is never followed through a symlink.
 */
function readTokenFile(file: string, mask: number, follow: boolean): string {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (follow ? 0 : NOFOLLOW));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Refusal(
      code === 'ENOENT'
        ? `${shown(file)} does not exist: run \`oort serve token\` first.`
        : `${shown(file)} cannot be opened (${code ?? 'error'}); it must be a regular file, never a symlink.`,
      { fix: code === 'ENOENT' ? 'oort serve token' : undefined },
    );
  }
  try {
    const st = fs.fstatSync(fd);
    const me = currentUid();
    if (!st.isFile()) throw new Refusal(`${shown(file)} is not a regular file.`);
    if (me !== undefined && st.uid !== me) {
      throw new Refusal(`${shown(file)} belongs to another user; refusing to use it.`);
    }
    if (process.platform !== 'win32' && (st.mode & mask) !== 0) {
      throw new Refusal(
        `${shown(file)} is mode ${(st.mode & 0o777).toString(8)}, so others could read the service token. Fix: chmod 600 ${shown(file)}`,
      );
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The tokens service mode accepts, as SHA-256 digests: `OORT_SERVE_TOKEN` (up to two, comma
 * separated, for rotation), else the file `OORT_SERVE_TOKEN_FILE` names (a mounted secret), else
 * `<home>/serve.token`. Each must be at least 43 base64url characters (256 bits).
 */
export function serviceDigests(env: Env, home: string): Buffer[] {
  const fromEnv = env['OORT_SERVE_TOKEN'];
  const fileEnv = env['OORT_SERVE_TOKEN_FILE'];
  let raw: string;
  let where: string;
  if (fromEnv !== undefined && fromEnv !== '') {
    raw = fromEnv;
    where = 'OORT_SERVE_TOKEN';
  } else if (fileEnv !== undefined && fileEnv !== '') {
    if (!path.isAbsolute(fileEnv))
      throw new Refusal('OORT_SERVE_TOKEN_FILE must be an absolute path.');
    raw = readTokenFile(fileEnv, 0o007, true);
    where = 'OORT_SERVE_TOKEN_FILE';
  } else {
    raw = readTokenFile(tokenPathFor(home), 0o077, false);
    where = shown(tokenPathFor(home));
  }
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  if (tokens.length === 0 || tokens.length > 2) {
    throw new Refusal(`${where} must hold one token (or two, comma separated, while rotating).`);
  }
  for (const t of tokens) {
    if (!TOKEN_PATTERN.test(t)) {
      throw new Refusal(
        `${where} holds a token that is too short or not base64url: a token needs at least 43 characters (256 bits). Make one with \`oort serve token\`.`,
        { fix: 'oort serve token' },
      );
    }
  }
  return tokens.map(digestOf);
}

/** Loopback addresses: a listener there is reachable from this host (or this pod) only. */
export function isLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  return net.isIPv4(host) && host.startsWith('127.');
}

/**
 * `--listen`'s address: `PORT`, `HOST:PORT` or `[IPv6]:PORT`. A bare port binds 127.0.0.1. Only
 * IP literals (and `localhost`) are taken, so a name can never resolve somewhere unexpected.
 */
export function parseListen(text: string): { host: string; port: number } {
  const t = text.trim();
  const m =
    /^(?:\[([0-9a-fA-F:.]+)\]|([0-9.]+|localhost)):(\d{1,5})$/.exec(t) ?? /^()()(\d{1,5})$/.exec(t);
  const port = m === null ? NaN : Number(m[3]);
  const host = m === null ? '' : m[1] || m[2] || '127.0.0.1';
  const validHost = host === 'localhost' || net.isIP(host) !== 0;
  if (m === null || !validHost || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Refusal(
      `--listen ${echo(text)} is not an address: use PORT, HOST:PORT or [IPv6]:PORT (an IP address, not a name).`,
    );
  }
  return { host: host === 'localhost' ? '127.0.0.1' : host, port };
}

/** Linux `statfs` magic numbers of network and FUSE filesystems (SQLite WAL needs one host). */
const NETWORK_FS = new Map<number, string>([
  [0x6969, 'NFS'],
  [0x517b, 'SMB'],
  [0xff534d42, 'CIFS'],
  [0xfe534d42, 'SMB2'],
  [0x65735546, 'FUSE'],
  [0x564c, 'NCP'],
  [0x5346414f, 'AFS'],
  [0x6b414653, 'AFS'],
  [0x47504653, 'GPFS'],
  [0x0bd00bd0, 'Lustre'],
]);

/** The network filesystem `dir` is on (Linux), else undefined (local, or unknown elsewhere). */
export function networkFilesystem(dir: string): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return NETWORK_FS.get(Number(fs.statfsSync(dir).type) >>> 0);
  } catch {
    return undefined;
  }
}

export interface ListenRequest {
  listen: string;
  behindTlsProxy?: boolean;
  org?: string;
}

/**
 * Service mode's settings, every one checked: the address (loopback unless `--behind-tls-proxy`,
 * since this daemon has no TLS of its own), the org (`--org` or `OORT_SERVE_ORG`, never `local`:
 * a token is not the person), the tokens, and a store on a local disk.
 */
export function serviceSettings(
  r: ListenRequest,
  env: Env,
  home: string,
): { host: string; port: number; auth: ServiceAuth } {
  const { host, port } = parseListen(r.listen);
  if (!isLoopback(host) && r.behindTlsProxy !== true) {
    throw new Refusal(
      `--listen ${echo(r.listen)} is not a loopback address, and this daemon speaks plain HTTP: put it behind a TLS proxy and add --behind-tls-proxy, or listen on 127.0.0.1.`,
    );
  }
  const org = r.org ?? env['OORT_SERVE_ORG'];
  if (org === undefined || org === '') {
    throw new Refusal(
      'Service mode needs an org (--org or OORT_SERVE_ORG): a token acts in that org, never as you (`local`).',
    );
  }
  if (!NAME.test(org) || org === 'local') {
    throw new Refusal('The service org must be an id other than "local".');
  }
  const fsName = networkFilesystem(home);
  if (fsName !== undefined) {
    throw new Refusal(
      `${shown(home)} is on a network filesystem (${fsName}); SQLite needs a local disk for one store. Put OORT_HOME on a block volume.`,
    );
  }
  return { host, port, auth: { digests: serviceDigests(env, home), org } };
}
