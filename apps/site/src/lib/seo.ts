/** The one public origin. Clerk production and the canonical URLs both live here. */
export const SITE_ORIGIN = 'https://oortcloud.dev';

/** Absolute canonical URL for a path: no query or hash, no trailing slash except the root. */
export function canonicalUrl(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] || '/';
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return `${SITE_ORIGIN}${trimmed || '/'}`;
}

/**
 * Pages search engines should index. Legal drafts, sign-in and account pages carry
 * `noindex` and stay out; so do /api routes and the /explorer redirect.
 */
export const indexablePaths = [
  '/',
  '/pricing',
  '/architecture',
  '/enterprise',
  '/dashboard',
  '/docs',
  '/docs/quickstart',
  '/docs/claude-desktop',
  '/docs/codex',
  '/docs/cursor',
  '/docs/vscode',
  '/docs/gemini-cli',
  '/docs/mcp-clients',
  '/docs/frameworks',
  '/docs/chatgpt-and-claude-web',
  '/docs/pro',
  '/docs/own-keys',
  '/docs/privacy',
  '/docs/troubleshooting',
] as const;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function sitemapXml(paths: readonly string[] = indexablePaths): string {
  const urls = paths.map((p) => `  <url><loc>${esc(canonicalUrl(p))}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** Structured data for the home page: the software and who publishes it. */
export const homeJsonLd = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Oort',
    description:
      'Open-source memory for AI agents. Changed facts are closed out, old history moves to cheap storage, and every recall can explain itself.',
    url: `${SITE_ORIGIN}/`,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows',
    license: 'https://www.apache.org/licenses/LICENSE-2.0',
    codeRepository: 'https://github.com/oortmem/oort',
    offers: [
      { '@type': 'Offer', name: 'Open Source', price: '0', priceCurrency: 'USD' },
      {
        '@type': 'Offer',
        name: 'Oort Pro',
        price: '19',
        priceCurrency: 'USD',
        url: `${SITE_ORIGIN}/pricing`,
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          price: '19',
          priceCurrency: 'USD',
          billingDuration: 'P1M',
          valueAddedTaxIncluded: true,
        },
      },
    ],
  },
  {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Oort',
    url: `${SITE_ORIGIN}/`,
    logo: `${SITE_ORIGIN}/icon-512.png`,
    email: 'hello@oortcloud.dev',
    sameAs: ['https://github.com/oortmem/oort'],
  },
];

/** JSON for a <script type="application/ld+json">: `<` is escaped so no string can close the tag. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
