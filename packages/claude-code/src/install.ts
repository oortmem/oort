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
interface Handler {
  type?: unknown;
  command?: unknown;
  [k: string]: unknown;
}
interface Group {
  matcher?: unknown;
  hooks?: unknown;
  [k: string]: unknown;
}

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Ours: a command that starts with `<cmd> hook `, or any `oort hook <Event>`
 * command (an install from another path or an older version of the binary).
 */
function isOurs(h: unknown, cmd: string): boolean {
  if (!isObject(h) || h['type'] !== 'command' || typeof h['command'] !== 'string') return false;
  const c = h['command'];
  return (
    c.startsWith(`${cmd} hook `) ||
    /(?:^|[\s/\\])oort(?:\.c?[jt]s|\.mjs|\.cmd|\.exe)? hook (?:UserPromptSubmit|Stop|SessionStart|drain)\b/.test(
      c,
    )
  );
}

function desired(cmd: string, event: InstalledEvent): Handler {
  return { type: 'command', command: `${cmd} hook ${event}`, timeout: HOOK_TIMEOUTS[event] };
}

function readSettings(file: string): { settings: Json; existed: boolean; mode: number } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { settings: {}, existed: false, mode: 0o600 };
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = text.trim().length === 0 ? {} : JSON.parse(text);
  } catch (e) {
    throw new Error(`Claude Code settings ${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error(`Claude Code settings ${file} is not a JSON object`);
  if (parsed['hooks'] !== undefined && !isObject(parsed['hooks'])) {
    throw new Error(`Claude Code settings ${file}: "hooks" is not an object`);
  }
  return { settings: parsed, existed: true, mode: fs.statSync(file).mode & 0o777 };
}

function writeSettings(file: string, settings: Json, existed: boolean, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const backup = `${file}.oort-backup`;
  if (existed && !fs.existsSync(backup)) {
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') fs.chmodSync(backup, 0o600);
  }
  // A settings file symlinked from a dotfiles repo stays a symlink: write its target.
  const target = existed ? fs.realpathSync(file) : file;
  writeFileAtomic(target, `${JSON.stringify(settings, null, 2)}\n`, mode);
}

/** Removes our handlers from `groups`; drops groups that held only ours. Returns the new list. */
function withoutOurs(groups: unknown[], cmd: string): unknown[] {
  const out: unknown[] = [];
  for (const g of groups) {
    if (!isObject(g) || !Array.isArray(g['hooks'])) {
      out.push(g);
      continue;
    }
    const hooks = g['hooks'] as unknown[];
    const kept = hooks.filter((h) => !isOurs(h, cmd));
    if (kept.length === hooks.length) out.push(g);
    else if (kept.length > 0) out.push({ ...g, hooks: kept });
  }
  return out;
}

/**
 * Merges Oort's three hook entries (`<cmd> hook <Event>`) into the settings
 * file, creating it if missing. Idempotent; replaces a stale Oort entry in
 * place; never removes or reorders anyone else's hooks. Writes atomically and
 * keeps a one-time backup of the original at `<settingsPath>.oort-backup`.
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
        if (!isOurs(h, cmd)) {
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
      else if (hs.length > 0) next.push({ ...(g as Group), hooks: hs });
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
 * Removes only Oort's entries. A group, event array or `hooks` object left
 * empty by the removal is removed too. A missing file is left missing.
 */
export function uninstallHooks(settingsPath: string, cmd: string): { changed: boolean } {
  if (!fs.existsSync(settingsPath)) return { changed: false };
  const { settings, existed, mode } = readSettings(settingsPath);
  if (!isObject(settings['hooks'])) return { changed: false };
  const hooks: Json = { ...settings['hooks'] };
  let removed = false;
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const next = withoutOurs(groups, cmd);
    if (next.length === groups.length && next.every((g, i) => g === groups[i])) continue;
    removed = true;
    if (next.length === 0) delete hooks[event];
    else hooks[event] = next;
  }
  if (!removed) return { changed: false };
  const updated: Json = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete updated['hooks'];
  writeSettings(settingsPath, updated, existed, mode);
  return { changed: true };
}
