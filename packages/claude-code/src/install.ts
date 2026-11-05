import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from './fsutil.js';

/**
 * Installs Oort's hooks into a Claude Code settings file (usually
 * `~/.claude/settings.json`). Schema, per https://code.claude.com/docs/en/hooks:
 *
 *     { "hooks": { "<Event>": [ { "matcher"?: string, "hooks": [ { "type": "command", "command": string, "timeout"?: seconds } ] } ] } }
 *
 * UserPromptSubmit and Stop take no matcher (one would be ignored); SessionStart's
 * matcher filters the session source, and is omitted so it fires on every source.
 */

export const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'SessionStart'] as const;
export type InstalledEvent = (typeof HOOK_EVENTS)[number];

/** Seconds. Claude Code's defaults are 30 (UserPromptSubmit) and 600 (others). */
export const HOOK_TIMEOUTS: Record<InstalledEvent, number> = {
  UserPromptSubmit: 10,
  Stop: 5,
  SessionStart: 10,
};

type Json = Record<string, unknown>;
type Handler = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `cmd` as one shell word: as is when it is plainly safe, otherwise single-quoted. */
export function shellQuote(cmd: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(cmd) ? cmd : `'${cmd.replaceAll("'", `'\\''`)}'`;
}

const commandFor = (cmd: string, event: InstalledEvent): string =>
  `${shellQuote(cmd)} hook ${event}`;

/**
 * Ours, under `event`: exactly `<cmd> hook <event>`, or exactly `oort hook
 * <event>` from any install path (a stale entry from a moved binary). Anything
 * with more around it (`cd x && oort hook Stop`, `oort hook Stop --flag`) is
 * the user's own wrapper and is never touched.
 */
function isOurs(h: unknown, cmd: string, event: InstalledEvent): boolean {
  if (!isObject(h) || h['type'] !== 'command' || typeof h['command'] !== 'string') return false;
  const c = h['command'];
  return (
    c === commandFor(cmd, event) ||
    new RegExp(`^(?:\\S*/)?oort hook ${event}$`).test(c) ||
    // A package's bin, as `oort install` writes it: `<prefix>/oort(mem)/dist/main.js`.
    // Also a repo checkout (`<repo>/packages/cli/dist/main.js`), with an optional `node `.
    new RegExp(
      `^(?:node )?(?:'[^']*/(?:oort(?:mem)?|packages/cli)/dist/main\\.js'|[^'\\s]*/(?:oort(?:mem)?|packages/cli)/dist/main\\.js) hook ${event}$`,
    ).test(c)
  );
}

function desired(cmd: string, event: InstalledEvent): Handler {
  return { type: 'command', command: commandFor(cmd, event), timeout: HOOK_TIMEOUTS[event] };
}

function parseSettings(text: string, file: string): Json {
  let parsed: unknown;
  try {
    parsed = text.trim().length === 0 ? {} : JSON.parse(text);
  } catch (e) {
    throw new Error(`Claude Code settings ${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error(`Claude Code settings ${file} is not a JSON object`);
  const hooks = parsed['hooks'];
  if (hooks === undefined) return parsed;
  if (!isObject(hooks)) throw new Error(`Claude Code settings ${file}: "hooks" is not an object`);
  for (const event of HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new Error(`Claude Code settings ${file}: "hooks.${event}" is not an array`);
    }
  }
  return parsed;
}

function readSettings(file: string): { settings: Json; existed: boolean; mode: number } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { settings: {}, existed: false, mode: 0o600 };
    }
    throw e;
  }
  return {
    settings: parseSettings(text, file),
    existed: true,
    mode: fs.statSync(file).mode & 0o777,
  };
}

const backupPath = (file: string): string => `${file}.oort-backup`;

function writeSettings(file: string, settings: Json, existed: boolean, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const backup = backupPath(file);
  if (existed && !fs.existsSync(backup)) {
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') fs.chmodSync(backup, 0o600);
  }
  // A settings file symlinked from a dotfiles repo stays a symlink: write its target.
  const target = existed ? fs.realpathSync(file) : file;
  writeFileAtomic(target, `${JSON.stringify(settings, null, 2)}\n`, mode);
}

/**
 * Containers (`hooks`, `hooks.<Event>`) that existed before Oort first
 * installed, read from the one-time backup. No backup means the file did not
 * exist then, so every container is ours. An unreadable backup keeps them all.
 */
function preexisting(file: string): { hooks: boolean; events: Set<string> } {
  let text: string;
  try {
    text = fs.readFileSync(backupPath(file), 'utf8');
  } catch {
    return { hooks: false, events: new Set() };
  }
  try {
    const before = parseSettings(text, backupPath(file));
    const hooks = before['hooks'];
    return {
      hooks: isObject(hooks),
      events: new Set(isObject(hooks) ? Object.keys(hooks) : []),
    };
  } catch {
    return { hooks: true, events: new Set(HOOK_EVENTS) };
  }
}

/**
 * Merges Oort's three hook entries (`<cmd> hook <Event>`) into the settings
 * file, creating it if missing. Idempotent; replaces a stale Oort entry in
 * place; never removes or reorders anyone else's hooks. Writes atomically and
 * keeps a one-time backup of the original at `<settingsPath>.oort-backup`.
 * Refuses (file untouched) settings that are not JSON, or whose `hooks` or
 * hook event values have the wrong shape.
 */
export function installHooks(settingsPath: string, cmd: string): { changed: boolean } {
  const { settings, existed, mode } = readSettings(settingsPath);
  const before = JSON.stringify(settings);
  const hooks: Json = isObject(settings['hooks']) ? { ...settings['hooks'] } : {};
  for (const event of HOOK_EVENTS) {
    const want = desired(cmd, event);
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    // Replace the first of ours in place, drop any other copies.
    let placed = false;
    const next: unknown[] = [];
    for (const g of groups) {
      if (!isObject(g) || !Array.isArray(g['hooks'])) {
        next.push(g);
        continue;
      }
      const hs: unknown[] = [];
      let touched = false;
      for (const h of g['hooks'] as unknown[]) {
        if (!isOurs(h, cmd, event)) {
          hs.push(h);
        } else if (!placed) {
          hs.push(want);
          placed = true;
          touched = true;
        } else {
          touched = true;
        }
      }
      if (!touched) next.push(g);
      else if (hs.length > 0) next.push({ ...g, hooks: hs });
    }
    if (!placed) next.push({ hooks: [want] });
    hooks[event] = next;
  }
  const updated: Json = { ...settings, hooks };
  if (JSON.stringify(updated) === before) return { changed: false };
  writeSettings(settingsPath, updated, existed, mode);
  return { changed: true };
}

/**
 * Removes only Oort's entries. A group left empty by the removal goes too; an
 * event array or `hooks` object left empty goes only if Oort created it (it is
 * absent from the pre-install backup). A missing file is left missing.
 */
export function uninstallHooks(settingsPath: string, cmd: string): { changed: boolean } {
  if (!fs.existsSync(settingsPath)) return { changed: false };
  const { settings, existed, mode } = readSettings(settingsPath);
  if (!isObject(settings['hooks'])) return { changed: false };
  const hooks: Json = { ...settings['hooks'] };
  const kept = preexisting(settingsPath);
  let removed = false;
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const next: unknown[] = [];
    for (const g of groups) {
      if (!isObject(g) || !Array.isArray(g['hooks'])) {
        next.push(g);
        continue;
      }
      const hs = g['hooks'] as unknown[];
      const left = hs.filter((h) => !isOurs(h, cmd, event));
      if (left.length === hs.length) next.push(g);
      else if (left.length > 0) next.push({ ...g, hooks: left });
    }
    if (next.length === groups.length && next.every((g, i) => g === groups[i])) continue;
    removed = true;
    if (next.length === 0 && !kept.events.has(event)) delete hooks[event];
    else hooks[event] = next;
  }
  if (!removed) return { changed: false };
  const updated: Json = { ...settings, hooks };
  if (Object.keys(hooks).length === 0 && !kept.hooks) delete updated['hooks'];
  writeSettings(settingsPath, updated, existed, mode);
  return { changed: true };
}

export interface HookEventStatus {
  event: InstalledEvent;
  /**
   * `current`: `<cmd> hook <event>` for this bin. `stale`: Oort's entry from
   * another install path. `found`: Oort's entry, with no bin to compare
   * against. `missing`: no Oort entry (a wrapper such as `cd x && oort hook
   * Stop` is the user's own and does not count).
   */
  state: 'current' | 'stale' | 'found' | 'missing';
  /** The bin the entry runs, unquoted, for `stale` and `found`. */
  command?: string;
}

/** The bin part of `<bin> hook <event>`, with shellQuote's quoting undone. */
function binOf(command: string, event: InstalledEvent): string {
  const bin = command.slice(0, -` hook ${event}`.length);
  return bin.startsWith("'") && bin.endsWith("'") ? bin.slice(1, -1).replaceAll(`'\\''`, "'") : bin;
}

/**
 * Read-only: which of Oort's hooks the settings file holds, for `oort
 * doctor`. Throws, like `installHooks`, on settings that are not JSON or have
 * the wrong shape.
 */
export function hookStatus(
  settingsPath: string,
  cmd?: string,
): { exists: boolean; events: HookEventStatus[] } {
  const { settings, existed } = readSettings(settingsPath);
  const hooks = isObject(settings['hooks']) ? settings['hooks'] : {};
  const events = HOOK_EVENTS.map((event): HookEventStatus => {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    for (const g of groups) {
      if (!isObject(g) || !Array.isArray(g['hooks'])) continue;
      for (const h of g['hooks'] as unknown[]) {
        if (!isOurs(h, cmd ?? 'oort', event)) continue;
        const command = (h as { command: string }).command;
        if (cmd !== undefined && command === commandFor(cmd, event)) {
          return { event, state: 'current' };
        }
        return {
          event,
          state: cmd === undefined ? 'found' : 'stale',
          command: binOf(command, event),
        };
      }
    }
    return { event, state: 'missing' };
  });
  return { exists: existed, events };
}
