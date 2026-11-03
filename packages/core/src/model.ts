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
  /**
   * Sum of t^-d over compacted accesses. Only valid for the `d` it was folded
   * with: callers must pass the same `d` to `appendAccess` and `activation`.
   */
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
  /** When the system stopped believing this fact (transaction time); null while believed. */
  expiredAt: string | null;
  endReason: 'superseded' | 'corrected' | 'expired' | null;
  /** Last time an observation re-confirmed this fact. */
  lastConfirmedAt: string | null;
  supersedes: string | null;
  supersededBy: string | null;
  source: MemorySource;
  embedding?: Int8Array;
  createdAt: string;
  updatedAt: string;
}

/**
 * True when the system still believes `m` (`expiredAt === null`) and `at` lies
 * in its validity interval: `validFrom <= at` (inclusive), `at < validTo`
 * (exclusive; a null `validTo` is open-ended, so a future expiry is still current).
 */
export function isCurrent(m: Memory, at: Date): boolean {
  const t = at.getTime();
  return (
    m.expiredAt === null &&
    Date.parse(m.validFrom) <= t &&
    (m.validTo === null || t < Date.parse(m.validTo))
  );
}
