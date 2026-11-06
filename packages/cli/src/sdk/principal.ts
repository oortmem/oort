import { ANONYMOUS_AGENT, agentHome, isAgentId, CONFIGURED_ID_PREFIX } from '@oortmem/core';
import type { Env } from '../io.js';
import { principalFor, type Engine, type Principal, type WiredAgent } from '../wire.js';
import { OortRefusedError, OortUsageError } from './errors.js';
import { NAME } from './validate.js';

/**
 * Who a handle reads and writes as (CON-108 §6.4): org, end user, agent and project, fixed when
 * the handle is made. These are configuration, not authentication: the trust boundary is the
 * handle host code gives to model-facing tools.
 */

/** The agent id named in code, else `OORT_AGENT`, checked (no I/O); undefined: anonymous. */
export function agentName(env: Env, name: string | undefined): string | undefined {
  const fromEnv = env['OORT_AGENT'];
  const id = name ?? (fromEnv === undefined || fromEnv === '' ? undefined : fromEnv);
  if (id !== undefined && !isAgentId(id)) {
    throw new OortUsageError(
      `${name !== undefined ? 'agent' : 'OORT_AGENT'} is not an agent id: lowercase letters, digits, ".", "_" or "-", starting with a letter or digit (not "anonymous").`,
      { reason: 'invalid-argument' },
    );
  }
  return id;
}

/** The agent named in code, else `OORT_AGENT`, else anonymous (the Planet only). */
export function agentFor(home: string, env: Env, name: string | undefined): WiredAgent {
  const id = agentName(env, name);
  if (id === undefined) return { id: ANONYMOUS_AGENT, home: 'planet', source: 'none' };
  return { id, home: agentHome(home, id), source: name !== undefined ? 'flag' : 'env' };
}

/**
 * Checks an end user and the org: `user` needs an explicit `org` other than `local`, and is never
 * `self` (the person), so a server bug that drops the user id cannot fall back to the person's
 * own memories.
 */
export function checkUser(user: string | undefined, org: string | undefined): void {
  if (org !== undefined && !NAME.test(org)) {
    throw new OortUsageError('org is not a valid id.', { reason: 'invalid-argument' });
  }
  if (user === undefined) return;
  if (user === 'self') {
    throw new OortUsageError(
      'user cannot be "self": a handle for an end user never reaches the person’s own memories.',
      { reason: 'self-not-derivable' },
    );
  }
  if (!NAME.test(user)) {
    throw new OortUsageError('user is not a valid id.', { reason: 'invalid-argument' });
  }
  if (org === undefined || org === 'local') {
    throw new OortUsageError('user needs an explicit org (your tenant), other than "local".', {
      reason: 'principal-required',
    });
  }
}

/** An agent configured as a Star keeps one Star per org, shared by every user: refused with `user`. */
export function refuseStarWithUser(agent: WiredAgent, user: string | null): void {
  if (user !== null && agent.home === 'star') {
    throw new OortRefusedError(
      'This agent is configured as a Star, and a Star is shared by every user of the agent; an end-user handle gets their Planet only. Use an agent that writes the Planet (`oort connect <agent> --no-star`).',
      { reason: 'star-with-user' },
    );
  }
}

/** `project` as host code names it: an id (`cfg:<id>`), `null` (global only), or undefined (the cwd's). */
export function projectIdFor(
  project: string | null | undefined,
  engine: Pick<Engine, 'project'>,
): string | undefined {
  if (project === null) return undefined;
  if (project === undefined) return engine.project.projectId;
  return `${CONFIGURED_ID_PREFIX}${project}`;
}

/** The principal for a handle: an end user's Planet alone, or the agent's local grant. */
export function principalOf(
  engine: Engine,
  p: { org: string; user: string | null; agent: WiredAgent; projectId: string | undefined },
): Principal {
  refuseStarWithUser(p.agent, p.user);
  return principalFor(engine, {
    orgId: p.org,
    ...(p.user !== null && { customerId: p.user }),
    agent: p.agent,
    ...(p.projectId !== undefined && { projectId: p.projectId }),
    planetOnly: p.user !== null,
  });
}
