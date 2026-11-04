import {
  localGrant,
  type Grant,
  type Memory,
  type MemoryStore,
  type ScopeFilter,
} from '@oortmem/core';
import { PROJECTS } from './generate.js';

/** A scope filter covering global memories and every synthetic project. */
export const ALL_SCOPE: ScopeFilter = {
  orgId: 'local',
  customerId: 'self',
  agentId: 'claude-code',
  projectIds: [null, ...PROJECTS],
};

/** The grant for `ALL_SCOPE`: what the bench seeds, consolidates and reads. */
export const ALL_GRANT: Grant = localGrant(ALL_SCOPE);

/** Writes `memories` to `store` in transactions of `batch`. */
export async function seedStore(
  store: MemoryStore,
  memories: Memory[],
  batch = 500,
): Promise<void> {
  for (let i = 0; i < memories.length; i += batch) {
    await store.upsertMany(ALL_GRANT, memories.slice(i, i + batch));
  }
}
