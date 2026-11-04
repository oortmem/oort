import type Stripe from 'stripe';
import { rates } from '@/lib/oort-data';
import type { D1DatabaseLike } from './d1';
import { formatUserCode, generateKey, hashKey, keyPrefix, normalizeUserCode } from './keys';
import type { StripeLike } from './stripe';

/**
 * Account actions for /account and /account/cli. Every exported action starts with
 * `requireAccount`, which asks Clerk (server side) who is signed in and refuses otherwise.
 */

export class NotSignedIn extends Error {
  constructor() {
    super('Sign in to continue.');
    this.name = 'NotSignedIn';
  }
}

/** A refusal with a plain message that is safe to show. */
export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

export interface AccountDeps {
  db: D1DatabaseLike;
  /** Clerk `auth()` on the server, reduced to the user id (null when signed out). */
  getAuth: () => Promise<{ userId: string | null }>;
  stripe: () => StripeLike;
  now?: () => Date;
  /**
   * A budget for typing CLI user codes (RFC 8628 §5.1): false refuses the attempt. See
   * `codeAttemptGuard` for the production one (per account and per IP). Default: always allowed.
   */
  allowCodeAttempt?: (accountId: string) => boolean | Promise<boolean>;
  /** Site origin for Stripe return URLs, e.g. https://oortcloud.dev */
  origin: string;
  pricePro: string;
}

/** Monthly included use on Pro, from Structure A (the relay enforces the same numbers). */
export const PRO_LIMITS = { saves: rates.managed.Pro.saves, recalls: rates.managed.Pro.recalls };
export const ENTITLED_STATUSES: readonly string[] = ['active', 'trialing'];
export const MAX_LIVE_KEYS = 20;
export const CLI_SESSION_TTL_MS = 10 * 60_000;

interface AccountRow {
  id: string;
  clerk_user_id: string;
  stripe_customer_id: string | null;
  plan: string;
  status: string;
  current_period_end: string | null;
  created_at: string;
}

interface KeyRow {
  id: string;
  prefix: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface KeyView {
  id: string;
  prefix: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface Overview {
  plan: 'free' | 'pro';
  status: string;
  entitled: boolean;
  currentPeriodEnd: string | null;
  hasBilling: boolean;
  keys: KeyView[];
  usage: { month: string; saves: number; recalls: number; limits: typeof PRO_LIMITS };
}

const nowOf = (d: { now?: () => Date }) => (d.now ?? (() => new Date()))();

export const isEntitled = (a: { plan: string; status: string }) =>
  a.plan === 'pro' && ENTITLED_STATUSES.includes(a.status);

async function requireAccount(d: AccountDeps): Promise<AccountRow> {
  const { userId } = await d.getAuth();
  if (!userId) throw new NotSignedIn();
  const find = () =>
    d.db.prepare('SELECT * FROM accounts WHERE clerk_user_id = ?').bind(userId).first<AccountRow>();
  const found = await find();
  if (found) return found;
  await d.db
    .prepare(
      'INSERT INTO accounts (id, clerk_user_id, created_at) VALUES (?, ?, ?) ON CONFLICT (clerk_user_id) DO NOTHING',
    )
    .bind(crypto.randomUUID(), userId, nowOf(d).toISOString())
    .run();
  const created = await find();
  if (!created) throw new Error('account row missing after insert');
  return created;
}

/**
 * Inserts a new key for an account and returns it, or null when the account already has
 * MAX_LIVE_KEYS live keys. The count and the insert are one statement, so two requests at once
 * cannot both pass the limit. Only the hash and prefix are stored.
 */
export async function mintKey(
  db: D1DatabaseLike,
  accountId: string,
  name: string,
  now: Date,
): Promise<{ id: string; key: string; prefix: string; name: string } | null> {
  const key = generateKey();
  const id = crypto.randomUUID();
  const prefix = keyPrefix(key);
  const r = await db
    .prepare(
      `INSERT INTO api_keys (id, account_id, prefix, hash, name, created_at)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM api_keys WHERE account_id = ? AND revoked_at IS NULL) < ?`,
    )
    .bind(
      id,
      accountId,
      prefix,
      await hashKey(key),
      name,
      now.toISOString(),
      accountId,
      MAX_LIVE_KEYS,
    )
    .run();
  return r.meta.changes === 1 ? { id, key, prefix, name } : null;
}

export const KEY_LIMIT_MESSAGE = `You can have up to ${MAX_LIVE_KEYS} live keys. Revoke one first.`;

async function liveKeys(db: D1DatabaseLike, accountId: string): Promise<number> {
  const r = await db
    .prepare('SELECT COUNT(*) AS n FROM api_keys WHERE account_id = ? AND revoked_at IS NULL')
    .bind(accountId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function getOverview(d: AccountDeps): Promise<Overview> {
  const a = await requireAccount(d);
  const month = nowOf(d).toISOString().slice(0, 7);
  const keys = await d.db
    .prepare(
      'SELECT id, prefix, name, created_at, last_used_at, revoked_at FROM api_keys WHERE account_id = ? ORDER BY created_at DESC, id LIMIT 50',
    )
    .bind(a.id)
    .all<KeyRow>();
  const used = await d.db
    .prepare('SELECT saves, recalls FROM usage WHERE account_id = ? AND month = ?')
    .bind(a.id, month)
    .first<{ saves: number; recalls: number }>();
  return {
    plan: a.plan === 'pro' ? 'pro' : 'free',
    status: a.status,
    entitled: isEntitled(a),
    currentPeriodEnd: a.current_period_end,
    hasBilling: a.stripe_customer_id !== null,
    keys: keys.results.map((k) => ({
      id: k.id,
      prefix: k.prefix,
      name: k.name,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      revokedAt: k.revoked_at,
    })),
    usage: { month, saves: used?.saves ?? 0, recalls: used?.recalls ?? 0, limits: PRO_LIMITS },
  };
}

export async function createKey(d: AccountDeps, rawName: string) {
  const a = await requireAccount(d);
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (name.length < 1 || name.length > 60) {
    throw new AccountError('Give the key a name of 1 to 60 characters.');
  }
  const k = await mintKey(d.db, a.id, name, nowOf(d));
  if (!k) throw new AccountError(KEY_LIMIT_MESSAGE);
  return k;
}

export async function revokeKey(d: AccountDeps, keyId: string): Promise<{ revoked: boolean }> {
  const a = await requireAccount(d);
  const r = await d.db
    .prepare(
      'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL',
    )
    .bind(nowOf(d).toISOString(), String(keyId), a.id)
    .run();
  return { revoked: r.meta.changes === 1 };
}

async function ensureCustomer(d: AccountDeps, a: AccountRow): Promise<string> {
  if (a.stripe_customer_id) return a.stripe_customer_id;
  // No email or name is sent: Checkout collects what Stripe needs from the buyer.
  const c = await d.stripe().customers.create({ metadata: { account_id: a.id } });
  await d.db
    .prepare(
      'UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL',
    )
    .bind(c.id, a.id)
    .run();
  const row = await d.db
    .prepare('SELECT stripe_customer_id FROM accounts WHERE id = ?')
    .bind(a.id)
    .first<{ stripe_customer_id: string | null }>();
  return row?.stripe_customer_id ?? c.id;
}

const ENDED_SUBSCRIPTIONS: readonly string[] = ['canceled', 'incomplete_expired'];

/**
 * Checkout for a new Pro subscription. While the customer has any subscription that has not
 * ended (past_due, unpaid, incomplete...), a second one would bill twice, so the user is sent to
 * the Customer Portal instead (`portal: true`). Open Checkout sessions from other tabs are
 * expired first, so only the newest one can complete.
 */
export async function startCheckout(d: AccountDeps): Promise<{ url: string; portal?: true }> {
  const a = await requireAccount(d);
  if (isEntitled(a)) {
    throw new AccountError('You already have Oort Pro. Use Manage billing to change it.');
  }
  if (!d.pricePro) throw new AccountError('Billing is not set up yet.');
  if (a.stripe_customer_id) {
    const stripe = d.stripe();
    const subs = await stripe.subscriptions.list({
      customer: a.stripe_customer_id,
      status: 'all',
      limit: 100,
    });
    if (subs.data.some((x) => !ENDED_SUBSCRIPTIONS.includes(x.status))) {
      const p = await stripe.billingPortal.sessions.create({
        customer: a.stripe_customer_id,
        return_url: `${d.origin}/account`,
      });
      return { url: p.url, portal: true };
    }
    const open = await stripe.checkout.sessions.list({
      customer: a.stripe_customer_id,
      status: 'open',
      limit: 10,
    });
    for (const cs of open.data) await stripe.checkout.sessions.expire(cs.id);
  }
  const customer = await ensureCustomer(d, a);
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    customer,
    client_reference_id: a.id,
    line_items: [{ price: d.pricePro, quantity: 1 }],
    automatic_tax: { enabled: true },
    billing_address_collection: 'required',
    customer_update: { address: 'auto', name: 'auto' },
    tax_id_collection: { enabled: true },
    subscription_data: { metadata: { account_id: a.id } },
    consent_collection: { terms_of_service: 'required' },
    custom_text: {
      terms_of_service_acceptance: {
        message: `I agree to the [Oort Pro terms of service](${d.origin}/legal/terms-of-service). I ask for Oort Pro to start right away, and I understand that I lose my 14-day right of withdrawal once it starts. Oort still refunds the unused part on request within 14 days.`,
      },
    },
    success_url: `${d.origin}/account?checkout=success`,
    cancel_url: `${d.origin}/account?checkout=cancel`,
  };
  const s = await d.stripe().checkout.sessions.create(params);
  if (!s.url) throw new Error('Stripe returned no Checkout URL');
  return { url: s.url };
}

export async function openPortal(d: AccountDeps): Promise<{ url: string }> {
  const a = await requireAccount(d);
  if (!a.stripe_customer_id) {
    throw new AccountError('Subscribe first. Billing opens after your first Checkout.');
  }
  const s = await d.stripe().billingPortal.sessions.create({
    customer: a.stripe_customer_id,
    return_url: `${d.origin}/account`,
  });
  return { url: s.url };
}

interface CliRow {
  user_code: string;
  created_at: string;
  country: string | null;
  client_os: string | null;
  client_host: string | null;
  account_id: string | null;
  approved_at: string | null;
  consumed_at: string | null;
}

/** What the approve page shows about a sign-in request, so the user can tell it is theirs. */
export interface CliRequestView {
  code: string;
  createdAt: string;
  country: string | null;
  os: string | null;
  host: string | null;
  /** The account already has MAX_LIVE_KEYS live keys, so approving would not give the CLI one. */
  keyLimitReached: boolean;
}

/** The slice of a Workers Rate Limiting binding this uses. */
export interface LimiterLike {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The budget for typed `oort login` codes: counted in a Workers Rate Limiting binding (shared
 * across isolates), once per account and once per IP, and refused when either is spent. The IP
 * is the counter's key only and is never stored. `local` is the in-memory fallback for a build
 * without the binding (local development).
 */
export function codeAttemptGuard(
  limiter: LimiterLike | undefined,
  ip: string,
  local: (key: string) => boolean,
): (accountId: string) => Promise<boolean> {
  return async (accountId) => {
    if (!limiter) return local(`account:${accountId}`) && local(`ip:${ip}`);
    const [byAccount, byIp] = await Promise.all([
      limiter.limit({ key: `code-account:${accountId}` }),
      limiter.limit({ key: `code-ip:${ip}` }),
    ]);
    return byAccount.success && byIp.success;
  };
}

const CODE_NOT_FOUND =
  'No pending sign-in request has that code. Check the code in your terminal, or run oort login again.';

/** The request behind a typed code, checked as the approve step will check it. */
async function pendingRequest(d: AccountDeps, accountId: string, typed: unknown): Promise<CliRow> {
  if (d.allowCodeAttempt && !(await d.allowCodeAttempt(accountId))) {
    throw new AccountError('Too many codes tried. Wait a minute, then try again.');
  }
  const code = normalizeUserCode(typed);
  if (!code) {
    throw new AccountError('Type the 8-letter code your terminal shows, like BCDF-GHJK.');
  }
  const row = await d.db
    .prepare(
      'SELECT user_code, created_at, country, client_os, client_host, account_id, approved_at, consumed_at FROM cli_sessions WHERE user_code = ?',
    )
    .bind(code)
    .first<CliRow>();
  if (!row) throw new AccountError(CODE_NOT_FOUND);
  if (row.consumed_at !== null) {
    throw new AccountError('This sign-in request was already used. Run oort login again.');
  }
  if (nowOf(d).getTime() - Date.parse(row.created_at) > CLI_SESSION_TTL_MS) {
    throw new AccountError('This sign-in request expired. Run oort login again.');
  }
  if (row.approved_at !== null) {
    throw new AccountError(
      row.account_id === accountId
        ? 'You already approved this sign-in request. Go back to your terminal.'
        : CODE_NOT_FOUND,
    );
  }
  return row;
}

/** Step 1 of the approve page: the user typed the code from their terminal. */
export async function lookupCli(d: AccountDeps, typed: unknown): Promise<CliRequestView> {
  const a = await requireAccount(d);
  const row = await pendingRequest(d, a.id, typed);
  return {
    code: formatUserCode(row.user_code),
    createdAt: row.created_at,
    country: row.country,
    os: row.client_os,
    host: row.client_host,
    keyLimitReached: (await liveKeys(d.db, a.id)) >= MAX_LIVE_KEYS,
  };
}

/**
 * Step 2: the signed-in user approves the `oort login` request with that code. The key is minted
 * when the CLI collects it. Approval is one conditional update, so it happens at most once.
 */
export async function approveCli(d: AccountDeps, typed: unknown): Promise<{ approved: true }> {
  const a = await requireAccount(d);
  const row = await pendingRequest(d, a.id, typed);
  if ((await liveKeys(d.db, a.id)) >= MAX_LIVE_KEYS) {
    throw new AccountError(
      `This account already has ${MAX_LIVE_KEYS} live keys. Revoke one on your account page, then approve again.`,
    );
  }
  const now = nowOf(d);
  const r = await d.db
    .prepare(
      `UPDATE cli_sessions SET account_id = ?, approved_at = ?
        WHERE user_code = ? AND approved_at IS NULL AND consumed_at IS NULL AND created_at > ?`,
    )
    .bind(
      a.id,
      now.toISOString(),
      row.user_code,
      new Date(now.getTime() - CLI_SESSION_TTL_MS).toISOString(),
    )
    .run();
  if (r.meta.changes !== 1) {
    throw new AccountError('This sign-in request is no longer pending. Run oort login again.');
  }
  return { approved: true };
}
