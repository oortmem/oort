declare const __CF_BEACON_TOKEN__: string | undefined;

/** Cloudflare Web Analytics token, set at build time through CF_BEACON_TOKEN. Empty in dev and tests. */
export const beaconToken: string =
  typeof __CF_BEACON_TOKEN__ === 'undefined' ? '' : (__CF_BEACON_TOKEN__ ?? '');

/** Head script entries for Cloudflare Web Analytics. Nothing at all without a token. */
export function beaconScripts(token: string) {
  const t = token.trim();
  if (!t) return [];
  return [
    {
      src: 'https://static.cloudflareinsights.com/beacon.min.js',
      defer: true,
      'data-cf-beacon': JSON.stringify({ token: t }),
    },
  ];
}
