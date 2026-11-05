import * as fs from 'node:fs';
import * as path from 'node:path';
import { ANONYMOUS_AGENT, type Home } from './grant.js';
import { writePrivateFile } from './private-fs.js';

/**
 * Agent identities on one machine (CON-62). Every host Oort is connected to
 * acts as its own agent (`claude-code`, `codex`, `cursor`, …): they share the
 * person's Planet, and each has a Star of its own that no other agent reads.
 * An agent configured as a Star (`oort connect cursor --star`) writes new
 * memories to its Star instead of the Planet. The configuration lives in
 * `$OORT_HOME/agents.json` (0600).
 */

/**
 * Claude Code's agent id: what every local memory before agents was written as, and what the
 * Claude Code hooks and transcript import always act as. A caller that names no agent is
 * `ANONYMOUS_AGENT` (Planet only), never this.
 */
export const DEFAULT_AGENT = 'claude-code';

export { ANONYMOUS_AGENT };

/** Agents configured as Stars, under `OORT_HOME`. */
export const AGENTS_FILE = 'agents.json';

/** A lowercase id: letters, digits, `.`, `_` and `-`, at most 64 characters, starting alphanumeric. */
export const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A valid agent id that is not reserved (`anonymous` names a caller that named none). */
export const isAgentId = (s: string): boolean => AGENT_ID.test(s) && s !== ANONYMOUS_AGENT;

export interface AgentSettings {
  /** New memories land in this agent's Star (private to it) instead of the person's Planet. */
  star: boolean;
}

/**
 * The agents configured in `home`. A missing or unreadable file means none,
 * so every agent writes to the Planet (as before agents existed).
 */
export function readAgents(home: string): Record<string, AgentSettings> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(home, AGENTS_FILE), 'utf8'));
  } catch {
    return {};
  }
  const agents = (parsed as { agents?: unknown } | null)?.agents;
  if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) return {};
  const out: Record<string, AgentSettings> = {};
  for (const [id, v] of Object.entries(agents)) {
    if (!isAgentId(id) || typeof v !== 'object' || v === null) continue;
    out[id] = { star: (v as { star?: unknown }).star === true };
  }
  return out;
}

/**
 * Records whether agent `id` keeps a Star (0600). Returns true when that changed anything. An agent
 * that stops keeping one stays listed (`star: false`), so its Star is still found (export).
 */
export function setAgentStar(home: string, id: string, star: boolean): boolean {
  if (!isAgentId(id)) throw new RangeError(`not an agent id: ${JSON.stringify(id)}`);
  const agents = readAgents(home);
  if ((agents[id]?.star ?? false) === star) return false;
  agents[id] = { star };
  writePrivateFile(
    path.join(home, AGENTS_FILE),
    `${JSON.stringify({ version: 1, agents }, null, 2)}\n`,
  );
  return true;
}

/** Where agent `id`'s new memories land. */
export function agentHome(home: string, id: string): Home {
  return readAgents(home)[id]?.star === true ? 'star' : 'planet';
}
