import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
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

/** Linux groups whose members can already become root: group write from them adds nothing. */
const ROOT_GROUPS = new Set(['root', 'sudo', 'wheel', 'admin']);

/** What `groupCanBecomeRoot` reads: the system's group and user databases, and who this is. */
export interface SystemGroups {
  platform: NodeJS.Platform;
  /** `/etc/group`'s text (`name:x:gid:member,member`). */
  group: string;
  /** `/etc/passwd`'s text (`name:x:uid:gid:...`). */
  passwd: string;
  user: string;
}

let systemGroups: SystemGroups | undefined;

function readSystemGroups(): SystemGroups {
  const read = (f: string): string => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    // No user name: no user-private group either.
  }
  return {
    platform: process.platform,
    group: read('/etc/group'),
    passwd: read('/etc/passwd'),
    user,
  };
}

/**
 * Whether members of group `gid` can already become root, so letting them write changes nothing.
 * macOS: `wheel` (0) and `admin` (80), by number (an account's own group there is `staff`, 20,
 * which never counts). Elsewhere, from `/etc/group`: `root`, `sudo`, `wheel` or `admin`, or this
 * user's private group (named after the user, with no other members and no other user's primary
 * group). The same rule as `groupCanBecomeRoot` in trust.ts (PR #78), which this branch does not
 * have yet: fold the two together when both are in.
 */
export function groupCanBecomeRoot(gid: number, sys?: SystemGroups): boolean {
  const s = sys ?? (systemGroups ??= readSystemGroups());
  if (s.platform === 'darwin') return gid === 0 || gid === 80;
  if (gid === 0) return true;
  const entry = s.group
    .split('\n')
    .map((l) => l.split(':'))
    .find((f) => f.length >= 3 && Number(f[2]) === gid);
  if (entry === undefined) return false;
  const name = entry[0] ?? '';
  if (ROOT_GROUPS.has(name)) return true;
  const members = (entry[3] ?? '').split(',').filter((m) => m.trim() !== '');
  if (s.user === '' || name !== s.user || members.some((m) => m.trim() !== s.user)) return false;
  const others = s.passwd
    .split('\n')
    .map((l) => l.split(':'))
    .filter((f) => f.length >= 4 && Number(f[3]) === gid && f[0] !== s.user);
  return others.length === 0;
}

/**
 * Every directory from `file`'s parent up to `/`: each must belong to this user or root, and
 * not be writable by others (nor, for a mounted secret, by a group that cannot already become
 * root): whoever can change one can re-point the link or put a file of their own in the way.
 */
function checkDirectories(file: string, mask: number, seen: Set<string>): void {
  const me = currentUid();
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (!seen.has(dir)) {
      seen.add(dir);
      let st: fs.Stats;
      try {
        st = fs.statSync(dir);
      } catch {
        throw new Refusal(
          `${shown(dir)} (on the token file's path) cannot be examined; refusing to use ${shown(file)}.`,
        );
      }
      // A root-owned sticky directory (`/tmp`) is shared by design, and the sticky bit stops
      // anyone renaming or removing an entry that is not theirs: the one world-writable case taken.
      const systemShared = (st.mode & 0o1000) !== 0 && st.uid === 0;
      const others = (st.mode & 0o002) !== 0 && !systemShared;
      // mask 0o027 (a mounted secret) allows group *read*; group *write* only from a root group.
      const group = mask === 0o027 && (st.mode & 0o020) !== 0 && !groupCanBecomeRoot(st.gid);
      if (others || group || (me !== undefined && st.uid !== me && st.uid !== 0)) {
        throw new Refusal(
          `${shown(dir)} (a directory on the token file's path) can be changed by others; refusing to use ${shown(file)}.`,
        );
      }
    }
    if (path.dirname(dir) === dir) break;
  }
}

/**
 * A token file's contents, refused unless it is a regular file of this user's (or root's, for a
 * mounted secret) that neither group nor others may write and others may not read (`mask`: 0o077
 * for the home's own file; 0o027 for a mounted secret, which a group may share).
 *
 * A mounted secret (`mounted`) is reached through links an orchestrator re-points on rotation
 * (`token -> ..data/token`, `..data -> ..<generation>`, the old generation then deleted), so the
 * path is resolved afresh on every call, and then: every directory on the path as configured
 * (including the one holding the link) and on the resolved path must be this user's or root's and
 * unwritable by others (and by a group that cannot become root); the resolved file is opened with
 * O_NOFOLLOW; and the opened file must be the very file that was checked (same device and inode
 * as a `stat` of the resolved path), so a swap between the checks and the open is refused.
 * `between` runs after the checks and before the open (tests swap the file there).
 */
export function readTokenFile(
  configured: string,
  mask: number,
  mounted: boolean,
  between?: () => void,
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
      const seen = new Set<string>();
      checkDirectories(configured, mask, seen);
      checkDirectories(file, mask, seen);
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
