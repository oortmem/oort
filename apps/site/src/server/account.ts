import type Stripe from 'stripe';
import { rates } from '@/lib/oort-data';
import type { D1DatabaseLike } from './d1';
import { generateKey, hashKey, keyPrefix } from './keys';
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
  /** Site origin for Stripe return URLs, e.g. https://oortcloud.dev */
  origin: string;
  pricePro: string;
}

/** Monthly included use on Pro, from Structure A (the relay enforces the same numbers). */
export const PRO_LIMITS = { saves: rates.managed.Pro.saves, recalls: rates.managed.Pro.recalls };
export const ENTITLED_STATUSES: readonly string[] = ['active', 'trialing'];
export const MAX_LIVE_KEYS = 20;
export const CLI_SESSION_TTL_MS = 10 * 60_000;
export const SESSION_ID = /^[A-Za-z0-9_-]{32,128}$/;

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

/** Inserts a new key for an account and returns it. Only the hash and prefix are stored. */
export async function mintKey(
  db: D1DatabaseLike,
  accountId: string,
  name: string,
  now: Date,
): Promise<{ id: string; key: string; prefix: string; name: string }> {
  const key = generateKey();
  const id = crypto.randomUUID();
  const prefix = keyPrefix(key);
  await db
    .prepare(
      'INSERT INTO api_keys (id, account_id, prefix, hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(id, accountId, prefix, await hashKey(key), name, now.toISOString())
    .run();
  return { id, key, prefix, name };
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
  const live = await d.db
    .prepare('SELECT COUNT(*) AS n FROM api_keys WHERE account_id = ? AND revoked_at IS NULL')
    .bind(a.id)
    .first<{ n: number }>();
  if ((live?.n ?? 0) >= MAX_LIVE_KEYS) {
    throw new AccountError(`You can have up to ${MAX_LIVE_KEYS} live keys. Revoke one first.`);
  }
  return mintKey(d.db, a.id, name, nowOf(d));
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

/** The signed-in user approves an `oort login` session. The key is minted when the CLI polls. */
export async function approveCli(d: AccountDeps, sessionId: string): Promise<{ approved: true }> {
  const a = await requireAccount(d);
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    throw new AccountError('This CLI session link is not valid. Run oort login again.');
  }
  const id = await hashKey(sessionId);
  const now = nowOf(d);
  await d.db
    .prepare('INSERT INTO cli_sessions (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING')
    .bind(id, now.toISOString())
    .run();
  const row = await d.db
    .prepare('SELECT created_at, account_id, consumed_at FROM cli_sessions WHERE id = ?')
    .bind(id)
    .first<{ created_at: string; account_id: string | null; consumed_at: string | null }>();
  if (!row || row.consumed_at !== null) {
    throw new AccountError('This sign-in request was already used. Run oort login again.');
  }
  if (now.getTime() - Date.parse(row.created_at) > CLI_SESSION_TTL_MS) {
    throw new AccountError('This sign-in request expired. Run oort login again.');
  }
  if (row.account_id !== null && row.account_id !== a.id) {
    throw new AccountError('This sign-in request was already approved by another account.');
  }
  await d.db
    .prepare(
      'UPDATE cli_sessions SET account_id = ?, approved_at = ? WHERE id = ? AND consumed_at IS NULL',
    )
    .bind(a.id, now.toISOString(), id)
    .run();
  return { approved: true };
}
