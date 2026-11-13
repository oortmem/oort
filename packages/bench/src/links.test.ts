import { describe, expect, it } from 'vitest';
import { resolveConfig, type RecalledMemory, type ResolvedConfig } from '@oortmem/core';
import {
  followedKinds,
  LINK_MODES,
  linksOverride,
  linksSupported,
  LinksUnavailableError,
  parseLinkModes,
  runnableModes,
  START_FACTORS,
  viaOf,
  type RecallLinksConfig,
} from './links.js';

const today = resolveConfig(
  '/nonexistent',
  { OORT_HOME: '/nonexistent' },
  { projectConfig: false },
);

/** A build from before `recall.links` (CON-149). */
const { links: _links, userLinks: _userLinks, ...recallBefore } = today.recall;
const before = { ...today, recall: recallBefore } as ResolvedConfig;

/** A config with every designed kind built (design section 12). */
const withLinks: ResolvedConfig = {
  ...today,
  recall: {
    ...today.recall,
    links: {
      enabled: false,
      seeds: 3,
      pool: 5,
      admit: 2,
      budgetMs: 8,
      fMax: 50,
      factors: { ...START_FACTORS },
    } satisfies RecallLinksConfig,
    userLinks: true,
  } as ResolvedConfig['recall'],
};

describe('links switch', () => {
  it('links.a-build-without-recall-links-runs-only-off', () => {
    expect(linksSupported(before)).toBe(false);
    expect(linksOverride('off', before)).toEqual({});
    for (const mode of LINK_MODES.filter((m) => m !== 'off')) {
      expect(() => linksOverride(mode, before)).toThrow(LinksUnavailableError);
    }
  });

  it('links.this-build-follows-explicit-episode-and-about (CON-149)', () => {
    expect(linksSupported(today)).toBe(true);
    expect(followedKinds(today)).toEqual(['explicit', 'episode', 'about']);
    expect(linksOverride('off', today)).toMatchObject({
      links: { enabled: false },
      userLinks: false,
    });
    expect(linksOverride('about', today)).toMatchObject({
      links: { enabled: true, factors: { explicit: 0, episode: 0, about: 0.6 } },
      userLinks: false,
    });
    expect(linksOverride('all', today)).toMatchObject({
      links: { enabled: true, factors: { explicit: 1, episode: 0.5, about: 0.6 } },
      userLinks: true,
    });
    // The kinds later slices build are refused by name, and `grid` leaves them out.
    expect(() => linksOverride('recalledWith', today)).toThrow(/CON-150/);
    expect(() => linksOverride('distilledFrom', today)).toThrow(/CON-152/);
    expect(runnableModes(parseLinkModes('grid'), today)).toEqual([
      'off',
      'user',
      'explicit',
      'episode',
      'about',
      'all',
    ]);
    expect(runnableModes(['off'], before)).toEqual(['off']);
  });

  it('links.modes-map-onto-the-designed-config', () => {
    expect(linksSupported(withLinks)).toBe(true);
    expect(linksOverride('off', withLinks)).toMatchObject({
      links: { enabled: false },
      userLinks: false,
    });
    expect(linksOverride('user', withLinks)).toMatchObject({
      links: { enabled: false },
      userLinks: true,
    });
    const about = linksOverride('about', withLinks) as { links: RecallLinksConfig };
    expect(about.links.enabled).toBe(true);
    expect(about.links.factors).toEqual({
      explicit: 0,
      distilledFrom: 0,
      recalledWith: 0,
      episode: 0,
      about: 0.6,
    });
    expect(linksOverride('about', withLinks)).toMatchObject({ userLinks: false });
    expect(linksOverride('explicit', withLinks)).toMatchObject({ userLinks: true });
    const all = linksOverride('all', withLinks) as { links: RecallLinksConfig };
    expect(all.links.factors).toEqual(START_FACTORS);
  });

  it('links.parse-modes', () => {
    expect(parseLinkModes('off')).toEqual(['off']);
    expect(parseLinkModes('off, about,off')).toEqual(['off', 'about']);
    expect(parseLinkModes('grid')).toEqual([...LINK_MODES]);
    expect(() => parseLinkModes('similar')).toThrow(/--links/);
  });

  it('links.via-is-read-from-the-explanation', () => {
    const hit = { explanation: { fused: 1 } } as unknown as RecalledMemory;
    const linked = {
      explanation: { fused: 1, via: { kind: 'about', from: 'a', weight: 0.5 } },
    } as unknown as RecalledMemory;
    expect(viaOf(hit)).toBeUndefined();
    expect(viaOf(linked)).toEqual({ kind: 'about', from: 'a', weight: 0.5 });
  });
});
