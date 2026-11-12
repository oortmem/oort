/**
 * The bench's switch for memory relationships (CON-145 design, sections 11 and 12).
 *
 * Links are not built yet: `recall.links` arrives with CON-149 and learned `recalledWith` pairs
 * with CON-150. Until then every run here is "links off", which is today's recall. The switch is
 * written against the config the design specifies, so the bench needs no change on the day
 * `recall.links` exists:
 *
 * - `linksSupported(config)` is true once the resolved config has a `recall.links` object.
 * - `linksOverride(mode, config)` turns a mode from the ablation grid into recall settings, and
 *   throws `LinksUnavailableError` for any mode but `off` while the build has no links.
 * - `GATHER_TIMING` names the recall timing the gather step reports (`timings.linksMs`).
 * - `viaOf(memory)` reads `explanation.via`, the field a link-admitted memory carries.
 */
import type { RecalledMemory, ResolvedConfig } from '@oortmem/core';

/** The link kinds recall can follow (design section 3); `supersedes` is the existing chain. */
export const LINK_KINDS = [
  'explicit',
  'distilledFrom',
  'recalledWith',
  'episode',
  'about',
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/**
 * The ablation grid (design section 11): links off; a person's explicit links only; each other
 * kind alone; all of them.
 */
export const LINK_MODES = ['off', 'user', ...LINK_KINDS, 'all'] as const;
export type LinksMode = (typeof LINK_MODES)[number];

/** The recall timing, in ms, of the gather step (design section 10). Absent without links. */
export const GATHER_TIMING = 'linksMs';

/** The design's `recall.links` settings (section 12). CON-149 owns the real schema. */
export interface RecallLinksConfig {
  enabled: boolean;
  seeds: number;
  pool: number;
  admit: number;
  budgetMs: number;
  fMax: number;
  factors: Record<LinkKind, number>;
}

/** The design's start values for kind factors (section 5). */
export const START_FACTORS: Record<LinkKind, number> = {
  explicit: 1,
  distilledFrom: 1,
  recalledWith: 1,
  about: 0.6,
  episode: 0.5,
};

export class LinksUnavailableError extends Error {
  constructor(mode: string) {
    super(
      `--links ${mode} needs recall.links, which this build of @oortmem/core does not have yet ` +
        '(CON-149). Only --links off runs today.',
    );
    this.name = 'LinksUnavailableError';
  }
}

type RecallConfig = ResolvedConfig['recall'];
type WithLinks = RecallConfig & { links?: RecallLinksConfig; userLinks?: boolean };

/** True once `@oortmem/core` resolves a `recall.links` object (CON-149). */
export function linksSupported(config: ResolvedConfig): boolean {
  const links = (config.recall as WithLinks).links;
  return typeof links === 'object' && links !== null;
}

/** Parses a comma list of modes (`off,user,about`); `grid` is the whole ablation grid. */
export function parseLinkModes(raw: string): LinksMode[] {
  if (raw.trim() === 'grid') return [...LINK_MODES];
  const items = raw.split(',').map((s) => s.trim());
  const bad = items.filter((s) => !(LINK_MODES as readonly string[]).includes(s));
  if (bad.length > 0 || items.length === 0) {
    throw new Error(`--links takes ${LINK_MODES.join(', ')} or grid, got "${raw}"`);
  }
  return [...new Set(items)] as LinksMode[];
}

/**
 * Recall settings for one mode, to spread over `config.recall`. `off` is today's recall: with a
 * build that has links it also stops a person's explicit links, so the baseline follows nothing.
 * In this build `off` changes nothing and every other mode throws.
 */
export function linksOverride(mode: LinksMode, config: ResolvedConfig): Partial<WithLinks> {
  if (!linksSupported(config)) {
    if (mode === 'off') return {};
    throw new LinksUnavailableError(mode);
  }
  const base = (config.recall as WithLinks).links as RecallLinksConfig;
  const only = (kinds: readonly LinkKind[]): Record<LinkKind, number> =>
    Object.fromEntries(
      LINK_KINDS.map((k) => [k, kinds.includes(k) ? (base.factors[k] ?? START_FACTORS[k]) : 0]),
    ) as Record<LinkKind, number>;
  switch (mode) {
    case 'off':
      return { links: { ...base, enabled: false }, userLinks: false };
    case 'user':
      return { links: { ...base, enabled: false }, userLinks: true };
    case 'all':
      return { links: { ...base, enabled: true, factors: only(LINK_KINDS) }, userLinks: true };
    default:
      // One kind alone: a person's explicit links stay off unless the kind is `explicit`.
      return {
        links: { ...base, enabled: true, factors: only([mode]) },
        userLinks: mode === 'explicit',
      };
  }
}

/** A link-admitted memory's `explanation.via` (design section 10), when it has one. */
export function viaOf(
  m: RecalledMemory,
): { kind: string; from: string; weight: number } | undefined {
  const via = (m.explanation as { via?: unknown }).via;
  if (typeof via !== 'object' || via === null) return undefined;
  return via as { kind: string; from: string; weight: number };
}
