import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { Route as Root } from '@/routes/__root';
import { Route as Home } from '@/routes/index';
import { routeTree } from '@/routeTree.gen';
import {
  SITE_ORIGIN,
  canonicalUrl,
  homeJsonLd,
  indexablePaths,
  jsonLdScript,
  sitemapXml,
} from '@/lib/seo';

const routesDir = join(import.meta.dirname, '../routes');
const publicDir = join(import.meta.dirname, '../../public');

type Head = {
  meta?: Record<string, string>[];
  links?: { rel: string; href: string }[];
  scripts?: { type?: string; children?: string }[];
};
const rootHead = (pathname: string) =>
  Root.options.head?.({ matches: [{ pathname: '/' }, { pathname }] } as never) as Head;

describe('canonical URLs', () => {
  it('are absolute on oortcloud.dev, with no query, hash or trailing slash', () => {
    expect(canonicalUrl('/')).toBe('https://oortcloud.dev/');
    expect(canonicalUrl('/pricing/')).toBe('https://oortcloud.dev/pricing');
    expect(canonicalUrl('/docs/quickstart?ref=x#top')).toBe(
      'https://oortcloud.dev/docs/quickstart',
    );
  });
  it('the root head sets canonical and og:url for the page being served', () => {
    const head = rootHead('/pricing');
    expect(head.links).toContainEqual({ rel: 'canonical', href: `${SITE_ORIGIN}/pricing` });
    expect(head.meta).toContainEqual({ property: 'og:url', content: `${SITE_ORIGIN}/pricing` });
  });
  it('the root head links the social image, icons and manifest', () => {
    const head = rootHead('/');
    expect(head.meta).toContainEqual({ property: 'og:image', content: `${SITE_ORIGIN}/og.png` });
    expect(head.meta).toContainEqual({ name: 'twitter:card', content: 'summary_large_image' });
    const rels = (head.links ?? []).map((l) => `${l.rel} ${l.href}`);
    expect(rels).toEqual(
      expect.arrayContaining([
        'icon /favicon.ico',
        'apple-touch-icon /apple-touch-icon.png',
        'manifest /site.webmanifest',
      ]),
    );
    for (const f of [
      'og.png',
      'favicon.ico',
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-512.png',
      'site.webmanifest',
    ]) {
      expect(readdirSync(publicDir)).toContain(f);
    }
  });
});

describe('sitemap.xml', () => {
  const xml = sitemapXml();
  it('lists every indexable page as an absolute URL', () => {
    for (const p of indexablePaths) expect(xml).toContain(`<loc>${canonicalUrl(p)}</loc>`);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
  it('leaves out noindex pages, account, sign-in, the API and the old Explorer', () => {
    expect(xml).not.toMatch(/\/legal\/|\/account|\/signin|\/signup|\/api\/|\/explorer/);
  });
  it('matches the noindex flags in the route files', () => {
    const noindex = (f: string) =>
      readFileSync(join(routesDir, f), 'utf8').includes("content: 'noindex'");
    for (const p of indexablePaths) {
      const file = p === '/' ? 'index.tsx' : p === '/docs' ? 'docs/index.tsx' : `${p.slice(1)}.tsx`;
      expect(noindex(file), file).toBe(false);
    }
  });
  it('every indexable path is a real route', () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });
    for (const p of indexablePaths) {
      expect(
        router
          .matchRoutes(p)
          .at(-1)
          ?.fullPath.replace(/(.)\/$/, '$1'),
        p,
      ).toBe(p);
    }
  });
});

describe('robots.txt', () => {
  const robots = readFileSync(join(publicDir, 'robots.txt'), 'utf8');
  it('points crawlers at the sitemap and keeps them out of account and API routes', () => {
    expect(robots).toContain('Sitemap: https://oortcloud.dev/sitemap.xml');
    expect(robots).toMatch(/^Disallow: \/account$/m);
    expect(robots).toMatch(/^Disallow: \/api\/$/m);
  });
});

describe('structured data', () => {
  it('the home page describes Oort and its Pro offer', () => {
    const scripts = (Home.options.head!({} as never) as Head).scripts ?? [];
    const ld = scripts.find((s) => s.type === 'application/ld+json');
    const data = JSON.parse(ld!.children!) as Record<string, unknown>[];
    expect(data.map((d) => d['@type'])).toEqual(['SoftwareApplication', 'Organization']);
    expect(JSON.stringify(data)).toContain('"price":"19"');
    expect(JSON.stringify(data)).toContain('LICENSE-2.0');
  });
  it('cannot close its own script tag', () => {
    const out = jsonLdScript({ x: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('</script>');
    expect(JSON.parse(out)).toEqual({ x: '</script><script>alert(1)</script>' });
    expect(jsonLdScript(homeJsonLd)).not.toContain('<');
  });
});

describe('legal pages', () => {
  it('each has its own meta description', () => {
    const dir = join(routesDir, 'legal');
    for (const f of readdirSync(dir)) {
      expect(readFileSync(join(dir, f), 'utf8'), f).toMatch(/name: 'description'/);
    }
  });
});

describe('Explorer concept', () => {
  it('is no longer on the live site: /explorer redirects home with a 301', () => {
    const src = readFileSync(join(routesDir, 'explorer.tsx'), 'utf8');
    expect(src).toMatch(/redirect\(\{ to: '\/', statusCode: 301 \}\)/);
    const site = join(import.meta.dirname, '..');
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
      );
    const users = walk(site).filter(
      (f) =>
        !f.endsWith('seo.test.tsx') &&
        !f.endsWith('routeTree.gen.ts') &&
        /PhoneExplorer|to="\/explorer"|'\/explorer', '/.test(readFileSync(f, 'utf8')),
    );
    expect(users).toEqual([]);
  });
});
