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

/** Group write on a directory is taken from root (gid 0) and, on macOS, `admin` (80): by number. */
const groupMayWrite = (gid: number): boolean =>
  gid === 0 || (process.platform === 'darwin' && gid === 80);

/** A directory every user may write into but only the owner of an entry may rename or remove. */
const sharedSticky = (st: fs.Stats): boolean =>
  (st.mode & 0o002) !== 0 && (st.mode & 0o1000) !== 0 && st.uid === 0;

/**
 * Every path entry met resolving `p` from `/`: each component, and each link's target components
 * in turn (so `token -> ..data/token` yields `token`, `..data`, `..data`'s target, ...).
 */
function entriesOn(p: string): string[] {
  const seen: string[] = [];
  const parts = (x: string): string[] => x.split(path.sep).filter((c) => c !== '' && c !== '.');
  let pending = parts(p);
  let cur: string = path.sep;
  for (let hops = 0; pending.length > 0;) {
    const c = pending.shift() as string;
    if (c === '..') {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, c);
    seen.push(next);
    if (fs.lstatSync(next).isSymbolicLink()) {
      if (++hops > 40) throw Object.assign(new Error('too many links'), { code: 'ELOOP' });
      const target = fs.readlinkSync(next);
      pending = [...parts(target), ...pending];
      if (path.isAbsolute(target)) cur = path.sep;
    } else {
      cur = next;
    }
  }
  return seen;
}

/**
 * The trust rules for the directories a mounted token is reached through. Every directory from
 * each entry's parent up to `/` must belong to this user or root, and:
 *
 * - others may not write it, except a root-owned sticky directory (`/tmp`, a Kubernetes secret
 *   mount's tmpfs), where the sticky bit stops anyone replacing an entry that is not theirs, so
 *   every entry met on the path inside it (the `token` link, the `..data` link, a generation
 *   directory) must itself belong to this user or root (`lstat`, on the link, not its target);
 * - a group may not write it (when the mask lets a group read at all) except gid 0, and gid 80
 *   on macOS. Groups are never trusted by name or as a "private group".
 */
function checkMountedPath(
  configured: string,
  real: string,
  mask: number,
  me: number | undefined,
): void {
  const entries = [...new Set([...entriesOn(configured), ...entriesOn(real)])];
  const owned = (uid: number): boolean => me === undefined || uid === me || uid === 0;
  for (const e of entries) {
    const parent = path.dirname(e);
    if (sharedSticky(fs.statSync(parent)) && !owned(fs.lstatSync(e).uid)) {
      throw new Refusal(
        `${shown(e)} (on the token file's path, in the shared directory ${shown(parent)}) belongs to another user; refusing to use ${shown(configured)}.`,
      );
    }
  }
  const dirs = new Set<string>();
  for (const e of entries) {
    for (let d = path.dirname(e); !dirs.has(d); d = path.dirname(d)) {
      dirs.add(d);
      if (path.dirname(d) === d) break;
    }
  }
  for (const d of dirs) {
    const st = fs.statSync(d);
    const othersWrite = (st.mode & 0o002) !== 0 && !sharedSticky(st);
    const groupWrite = mask === 0o027 && (st.mode & 0o020) !== 0 && !groupMayWrite(st.gid);
    if (othersWrite || groupWrite || !owned(st.uid)) {
      throw new Refusal(
        `${shown(d)} (a directory on the token file's path) can be changed by others; refusing to use ${shown(configured)}.`,
      );
    }
  }
}

/**
 * A token file's contents, refused unless it is a regular file of this user's (or root's, for a
 * mounted secret) that neither group nor others may write and others may not read (`mask`: 0o077
 * for the home's own file; 0o027 for a mounted secret, which a group may share).
 *
 * A mounted secret (`mounted`) is reached through links an orchestrator re-points on rotation
 * (`token -> ..data/token`, `..data -> ..<generation>`, the old generation then deleted), so the
 * path is resolved afresh on every call, and then: every entry and directory on the path as
 * configured (the folder holding the link, the links, the generation) and on the resolved path
 * passes `checkMountedPath` (owners, others, groups, shared sticky directories); the resolved file is opened with
 * O_NOFOLLOW; and the opened file must be the very file that was checked (same device and inode
 * as a `stat` of the resolved path), so a swap between the checks and the open is refused.
 * `between` runs after the checks and before the open (tests swap the file there).
 */
export function readTokenFile(
  configured: string,
  mask: number,
  mounted: boolean,
  between?: () => void,
  opts?: { uid?: number },
): string {
  const win = process.platform === 'win32';
  let file = configured;
  if (mounted) {
    try {
      file = fs.realpathSync(configured);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new Refusal(
        code === 'ENOENT'
          ? `${shown(configured)} does not exist: run \`oort serve token\` first.`
          : `${shown(configured)} cannot be resolved (${code ?? 'error'}).`,
        { fix: code === 'ENOENT' ? 'oort serve token' : undefined },
      );
    }
    if (!win) {
      try {
        checkMountedPath(configured, file, mask, opts?.uid ?? currentUid());
      } catch (e) {
        if (e instanceof Refusal) throw e;
        throw new Refusal(
          `${shown(configured)} cannot be examined (${(e as NodeJS.ErrnoException).code ?? 'error'}).`,
        );
      }
    }
  }
  let checked: fs.Stats | undefined;
  try {
    checked = fs.statSync(file);
  } catch {
    checked = undefined; // the open below reports it
  }
  between?.();
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
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
    if (checked !== undefined && (st.dev !== checked.dev || st.ino !== checked.ino)) {
      throw new Refusal(
        `${shown(file)} changed while it was being checked (a different file than the one examined); refusing to use it.`,
      );
    }
    if (me !== undefined && st.uid !== me && !(mounted && st.uid === 0)) {
      throw new Refusal(`${shown(file)} belongs to another user; refusing to use it.`);
    }
    if (!win && (st.mode & mask) !== 0) {
      throw new Refusal(
        `${shown(file)} is mode ${(st.mode & 0o777).toString(8)}, so others could read or change the service token. Fix: chmod ${mask === 0o077 ? '600' : '640'} ${shown(file)}`,
      );
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Where the token comes from, and how a file is judged. */
interface TokenSource {
  where: string;
  /** Undefined for `OORT_SERVE_TOKEN`: fixed for the life of the process. Else the file's real
   * path now (links followed afresh on each call: a mounted secret's path changes on rotation). */
  locate?: () => string;
  mask: number;
  mounted: boolean;
  read: () => string;
}

function sourceOf(env: Env, home: string): TokenSource {
  const fromEnv = env['OORT_SERVE_TOKEN'];
  const fileEnv = env['OORT_SERVE_TOKEN_FILE'];
  if (fromEnv !== undefined && fromEnv !== '') {
    return { where: 'OORT_SERVE_TOKEN', mask: 0, mounted: false, read: () => fromEnv };
  }
  if (fileEnv !== undefined && fileEnv !== '') {
    if (!path.isAbsolute(fileEnv))
      throw new Refusal('OORT_SERVE_TOKEN_FILE must be an absolute path.');
    // A mounted secret is reached through links (`token -> ..data/token`) that a rotation
    // re-points and whose targets it deletes: resolved again on every stamp and every read.
    const locate = (): string => {
      try {
        return fs.realpathSync(fileEnv);
      } catch {
        return fileEnv; // readTokenFile reports it (ENOENT, a loop)
      }
    };
    return {
      where: 'OORT_SERVE_TOKEN_FILE',
      locate,
      mask: 0o027,
      mounted: true,
      read: () => readTokenFile(fileEnv, 0o027, true),
    };
  }
  const file = tokenPathFor(home);
  return {
    where: shown(file),
    locate: () => file,
    mask: 0o077,
    mounted: false,
    read: () => readTokenFile(file, 0o077, false),
  };
}

/** One to two tokens from the text, each at least 43 base64url characters; as SHA-256 digests. */
function digestsOf(raw: string, where: string): Buffer[] {
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

/**
 * The tokens service mode accepts, as SHA-256 digests: `OORT_SERVE_TOKEN` (up to two, comma
 * separated, for rotation), else the file `OORT_SERVE_TOKEN_FILE` names (a mounted secret; prefer
 * it: an environment variable is readable in `/proc/<pid>/environ`), else `<home>/serve.token`.
 * Each must be at least 43 base64url characters (256 bits).
 */
export function serviceDigests(env: Env, home: string): Buffer[] {
  const src = sourceOf(env, home);
  return digestsOf(src.read(), src.where);
}

/**
 * The digests, and (for a token file) a `reload` that follows the file: on each request the
 * file's identity and times are checked (one `stat`), and a changed file is read again, so
 * `oort serve token --rotate` takes effect on the next request with no restart. A file that has
 * become unreadable or invalid accepts no token at all (fails closed) until it is fixed.
 * `forceReload` (SIGHUP) reads it again whatever `stat` says.
 */
export function serviceTokens(
  env: Env,
  home: string,
): {
  digests: Buffer[];
  reload?: (log?: (line: string) => void) => readonly Buffer[];
  forceReload?: () => void;
} {
  const src = sourceOf(env, home);
  let current = digestsOf(src.read(), src.where);
  const locate = src.locate;
  if (locate === undefined) return { digests: current };
  const stamp = (): string | undefined => {
    try {
      const st = fs.statSync(locate(), { bigint: true });
      return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    } catch {
      return undefined;
    }
  };
  let seen = stamp();
  let force = false;
  return {
    digests: current,
    forceReload: () => {
      force = true;
    },
    reload: (log) => {
      const now = stamp();
      if (!force && now === seen) return current;
      force = false;
      seen = now;
      try {
        current = digestsOf(src.read(), src.where);
        log?.(
          JSON.stringify({ level: 'info', msg: 'service token reloaded', tokens: current.length }),
        );
      } catch (e) {
        current = [];
        log?.(
          JSON.stringify({
            level: 'error',
            msg: 'service token unreadable: refusing every request until it is fixed',
            reason: e instanceof Refusal ? e.message.slice(0, 200) : 'error',
          }),
        );
      }
      return current;
    },
  };
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
  [0x01021997, '9p'],
  [0x00c36400, 'Ceph'],
]);

/**
 * The network filesystem `dir` is on, else undefined. Linux only: macOS and Windows are not
 * checked (undefined), and a network volume that a container runtime mounts through a local
 * driver (an overlay, a bind of a host path) reports the type the kernel shows, which may be the
 * local one. A best-effort refusal, not a guarantee: keep OORT_HOME on a local block volume.
 */
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
  return { host, port, auth: { ...serviceTokens(env, home), org } };
}
