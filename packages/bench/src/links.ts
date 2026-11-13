/**
 * The bench's switch for memory relationships (CON-145 design, sections 11 and 12).
 *
 * Recall follows links since CON-149 (`recall.links`, `recall.userLinks`): explicit links, and
 * the `episode` and `about` indexes. Learned `recalledWith` pairs arrive with CON-150 and
 * `distilledFrom` with CON-152; until then those two modes are refused, and `all` and `grid`
 * cover the kinds this build follows.
 *
 * - `linksSupported(config)` is true when the resolved config has a `recall.links` object.
 * - `followedKinds(config)` lists the kinds this build's recall follows.
 * - `linksOverride(mode, config)` turns a mode from the ablation grid into recall settings, and
 *   throws `LinksUnavailableError` for a kind the build does not follow.
 * - `GATHER_TIMING` names the recall timing the gather step reports (`timings.linksMs`).
 * - `viaOf(memory)` reads `explanation.via`, the field a link-admitted memory carries.
 */
import { resolveConfig, type RecalledMemory, type ResolvedConfig } from '@oortmem/core';

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

/**
 * `recall.links` as the bench reads it (design section 12). `factors` holds the kinds the build
 * follows: a kind without a factor is not built yet.
 */
export interface RecallLinksConfig {
  enabled: boolean;
  seeds: number;
  pool: number;
  admit: number;
  budgetMs: number;
  fMax: number;
  factors: Partial<Record<LinkKind, number>>;
}

/** The design's start values for kind factors (section 5). */
export const START_FACTORS: Record<LinkKind, number> = {
  explicit: 1,
  distilledFrom: 1,
  recalledWith: 1,
  about: 0.6,
  episode: 0.5,
};

/** The issue that builds each kind recall does not follow yet. */
const BUILT_BY: Partial<Record<LinkKind, string>> = {
  recalledWith: 'CON-150',
  distilledFrom: 'CON-152',
};

export class LinksUnavailableError extends Error {
  constructor(mode: string, followed?: readonly LinkKind[]) {
    super(
      followed === undefined
        ? `--links ${mode} needs recall.links, which this build of @oortmem/core does not have ` +
            '(CON-149). Only --links off runs.'
        : `--links ${mode}: recall does not follow ${mode} links yet` +
            `${BUILT_BY[mode as LinkKind] === undefined ? '' : ` (${BUILT_BY[mode as LinkKind]})`}. ` +
            `This build follows ${followed.join(', ')}.`,
    );
    this.name = 'LinksUnavailableError';
  }
}

type RecallConfig = ResolvedConfig['recall'];
type WithLinks = Omit<RecallConfig, 'links' | 'userLinks'> & {
  links?: RecallLinksConfig;
  userLinks?: boolean;
};

/** True once `@oortmem/core` resolves a `recall.links` object (CON-149). */
export function linksSupported(config: ResolvedConfig): boolean {
  const links = (config.recall as WithLinks).links;
  return typeof links === 'object' && links !== null;
}

/** The kinds this build's recall follows: those `recall.links.factors` has a factor for. */
export function followedKinds(config: ResolvedConfig): LinkKind[] {
  if (!linksSupported(config)) return [];
  const factors = ((config.recall as WithLinks).links as RecallLinksConfig).factors;
  return LINK_KINDS.filter((k) => typeof factors[k] === 'number');
}

/** The modes of `list` this build can run: `grid` skips a kind that is not built yet. */
export function runnableModes(list: readonly LinksMode[], config: ResolvedConfig): LinksMode[] {
  const followed = followedKinds(config) as readonly string[];
  return list.filter((m) => m === 'off' || m === 'user' || m === 'all' || followed.includes(m));
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
 * `--links` as the entry points take it: a comma list of modes, or `grid` for every mode this
 * build can run (a kind that is not built yet is left out of the grid, and refused by name).
 */
export function linkModesFor(raw: string): LinksMode[] {
  const modes = parseLinkModes(raw);
  if (raw.trim() !== 'grid') return modes;
  const defaults = resolveConfig(
    '/nonexistent',
    { OORT_HOME: '/nonexistent' },
    { projectConfig: false },
  );
  return runnableModes(modes, defaults);
}

/**
 * Recall settings for one mode, to spread over `config.recall`. `off` is today's recall: with a
 * build that has links it also stops a person's explicit links, so the baseline follows nothing.
 * In a build without `recall.links`, `off` changes nothing and every other mode throws.
 */
export function linksOverride(mode: LinksMode, config: ResolvedConfig): Partial<WithLinks> {
  if (!linksSupported(config)) {
    if (mode === 'off') return {};
    throw new LinksUnavailableError(mode);
  }
  const base = (config.recall as WithLinks).links as RecallLinksConfig;
  const followed = followedKinds(config);
  // The start value when the config has switched a kind off (factor 0).
  const only = (kinds: readonly LinkKind[]): Partial<Record<LinkKind, number>> =>
    Object.fromEntries(
      followed.map((k) => [k, kinds.includes(k) ? base.factors[k] || START_FACTORS[k] : 0]),
    );
  switch (mode) {
    case 'off':
      return { links: { ...base, enabled: false }, userLinks: false };
    case 'user':
      return { links: { ...base, enabled: false }, userLinks: true };
    case 'all':
      return { links: { ...base, enabled: true, factors: only(LINK_KINDS) }, userLinks: true };
    default:
      if (!followed.includes(mode)) throw new LinksUnavailableError(mode, followed);
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
