// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SITE = resolve(import.meta.dirname, '..', '..', '..');
const RELAY = resolve(SITE, '..', 'relay');

/** Reads a wrangler.jsonc: strips comments outside strings and trailing commas. */
function jsonc(path: string): Record<string, unknown> {
  const src = readFileSync(path, 'utf8')
    .replace(
      /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
      (_m, s: string | undefined) => s ?? '',
    )
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(src) as Record<string, unknown>;
}

type D1Binding = {
  binding: string;
  database_name: string;
  database_id: string;
  migrations_dir: string;
};
const d1 = (cfg: Record<string, unknown>) => cfg['d1_databases'] as D1Binding[];

describe('one oort-accounts schema for site and relay', () => {
  const site = d1(jsonc(join(SITE, 'wrangler.jsonc')));
  const relay = d1(jsonc(join(RELAY, 'wrangler.jsonc')));
  const siteAccounts = site.find((b) => b.binding === 'ACCOUNTS_DB')!;
  const relayAccounts = relay.find((b) => b.binding === 'DB')!;

  it('binds the same database in both Workers', () => {
    expect(siteAccounts.database_name).toBe('oort-accounts');
    expect(relayAccounts.database_name).toBe('oort-accounts');
    expect(siteAccounts.database_id).toBe(relayAccounts.database_id);
  });

  it('points the site at the relay migrations directory, not a copy', () => {
    expect(resolve(SITE, siteAccounts.migrations_dir)).toBe(
      resolve(RELAY, relayAccounts.migrations_dir),
    );
    expect(readdirSync(resolve(SITE, siteAccounts.migrations_dir)).sort()).toEqual([
      '0001_accounts.sql',
      '0002_cli_sessions.sql',
      '0003_usage_counters.sql',
    ]);
  });

  it('keeps the waitlist in its own database', () => {
    const waitlist = site.find((b) => b.binding === 'DB')!;
    expect(waitlist.database_name).toBe('oort-site-waitlist');
    expect(waitlist.migrations_dir).toBe('migrations');
    expect(readdirSync(join(SITE, 'migrations'))).toEqual(['0001_waitlist.sql']);
  });
});
