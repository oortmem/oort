import type { Env } from './io.js';
import { PROVIDER_ENV, type KeychainReader, type Provider, type Vendor } from './keychain.js';

export type AdapterRole = 'embed' | 'rerank' | 'decide' | 'write';
export const ROLES: readonly AdapterRole[] = ['embed', 'rerank', 'decide', 'write'];

/** The vendor each role calls, directly with its own key or through the relay. */
export const ROLE_VENDOR: Record<AdapterRole, Vendor> = {
  embed: 'voyage',
  rerank: 'voyage',
  decide: 'typesafe',
  write: 'anthropic',
};

export type KeyOrigin = 'env' | 'keychain';

/**
 * Where one role's key comes from. A vendor key always wins; the Oort key
 * (`OORT_API_KEY`, then Keychain `oort.oort`) serves only the roles whose
 * vendor key is missing, through the relay.
 */
export type RoleRoute =
  | { role: AdapterRole; via: 'vendor'; provider: Vendor; source: KeyOrigin; key: string }
  | { role: AdapterRole; via: 'oort'; provider: 'oort'; source: KeyOrigin; key: string }
  | { role: AdapterRole; via: 'none'; provider: Vendor };

export type KeyLookup = (p: Provider) => Promise<{ source: KeyOrigin; key: string } | undefined>;

/** Env (set and non-empty) first, then the Keychain; each Keychain item is read at most once. */
export function keyLookup(env: Env, reader: KeychainReader): KeyLookup {
  const reads = new Map<Provider, Promise<string | undefined>>();
  return async (p) => {
    const fromEnv = env[PROVIDER_ENV[p]];
    if (fromEnv !== undefined && fromEnv !== '') return { source: 'env', key: fromEnv };
    let read = reads.get(p);
    if (read === undefined) {
      read = reader(p).then((v) => (v === '' ? undefined : v));
      reads.set(p, read);
    }
    const key = await read;
    return key === undefined ? undefined : { source: 'keychain', key };
  };
}

export async function routeFor(role: AdapterRole, lookup: KeyLookup): Promise<RoleRoute> {
  const vendor = ROLE_VENDOR[role];
  const own = await lookup(vendor);
  if (own !== undefined) return { role, via: 'vendor', provider: vendor, ...own };
  const oort = await lookup('oort');
  if (oort !== undefined) return { role, via: 'oort', provider: 'oort', ...oort };
  return { role, via: 'none', provider: vendor };
}

/** A route without its key: what `doctor`, `setup` and `Wired.routes` show. */
export interface RouteSummary {
  role: AdapterRole;
  via: RoleRoute['via'];
  provider: Provider;
  /** Where the winning key comes from; absent when there is none. */
  source?: KeyOrigin;
}

export const summary = (r: RoleRoute): RouteSummary =>
  r.via === 'none'
    ? { role: r.role, via: r.via, provider: r.provider }
    : { role: r.role, via: r.via, provider: r.provider, source: r.source };

/** Every role's route, without the keys. */
export async function routeSummaries(
  lookup: KeyLookup,
): Promise<Record<AdapterRole, RouteSummary>> {
  const out = {} as Record<AdapterRole, RouteSummary>;
  for (const role of ROLES) out[role] = summary(await routeFor(role, lookup));
  return out;
}
