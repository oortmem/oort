export type MemoryType = 'semantic' | 'episodic' | 'procedural' | 'preference';
export type Tier = 'hot' | 'warm' | 'cold';

export interface Scope {
  orgId: string;
  customerId: string;
  agentId: string;
  projectId?: string;
}

export interface AccessLog {
  count: number;
  /** ISO timestamps, at most 32. */
  recent: string[];
  compactedSum: number;
  compactedAt: string | null;
  /**
   * Mean age in hours (at `compactedAt`) of the folded accesses, weighted by
   * their contribution to `compactedSum`. Used to re-age `compactedSum` to
   * the present. Optional; absent means 0 (treated as the one-minute floor).
   */
  compactedMeanAgeHours?: number;
}

export interface Decision {
  stage: string;
  question: string;
  answer: string;
  probability: number;
}

export interface MemorySource {
  harness: string;
  sessionId?: string;
  turnRef?: string;
  decisions: Decision[];
}

export interface Memory {
  id: string;
  scope: Scope;
  type: MemoryType;
  text: string;
  stub: string;
  entities: string[];
  salience: number;
  pinned: boolean;
  tier: Tier;
  accessLog: AccessLog;
  validFrom: string;
  validTo: string | null;
  supersedes: string | null;
  supersededBy: string | null;
  source: MemorySource;
  embedding?: Int8Array;
  createdAt: string;
  updatedAt: string;
}
