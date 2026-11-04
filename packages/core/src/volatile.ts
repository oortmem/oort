import type { Memory } from './model.js';

const DAY_MS = 86_400_000;

/** The fields these checks read, so a memory without its embedding (a cloud copy) works too. */
export type Datable = Pick<Memory, 'source' | 'lastConfirmedAt' | 'validFrom'>;

/**
 * A fact likely to change within weeks (a status, a current version, an owner). The write gate
 * records it as a `gate`/`volatile` decision; the latest such decision on the memory counts.
 */
export function isVolatile(m: Pick<Memory, 'source'>): boolean {
  for (let i = m.source.decisions.length - 1; i >= 0; i--) {
    const d = m.source.decisions[i]!;
    if (d.stage === 'gate' && d.question === 'volatile') return d.answer === 'yes';
  }
  return false;
}

/** When the memory was last known to hold: its last confirmation, else its start. */
export function lastConfirmed(m: Pick<Memory, 'lastConfirmedAt' | 'validFrom'>): string {
  return m.lastConfirmedAt ?? m.validFrom;
}

/** A volatile memory not confirmed within `staleAfterDays` (0 switches the check off). */
export function isStale(m: Datable, now: Date, staleAfterDays: number): boolean {
  if (staleAfterDays <= 0 || !isVolatile(m)) return false;
  return now.getTime() - Date.parse(lastConfirmed(m)) > staleAfterDays * DAY_MS;
}
