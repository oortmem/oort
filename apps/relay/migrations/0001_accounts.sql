-- Oort Pro accounts, shared by apps/site (writes) and apps/relay (reads keys, writes usage).
-- No prompt or memory content is ever stored here. Usage is numbers only.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY NOT NULL,
  clerk_user_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  -- 'free' or 'pro'. Set from Stripe webhooks.
  plan TEXT NOT NULL DEFAULT 'free',
  -- 'none' until a subscription exists, then the Stripe subscription status
  -- (active, trialing, past_due, canceled, unpaid, incomplete, ...).
  status TEXT NOT NULL DEFAULT 'none',
  current_period_end TEXT,
  created_at TEXT NOT NULL
);

-- Only the SHA-256 hash of a key is stored. The prefix is for display.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS api_keys_account ON api_keys (account_id);

-- Monthly counters. month is 'YYYY-MM' in UTC.
CREATE TABLE IF NOT EXISTS usage (
  account_id TEXT NOT NULL,
  month TEXT NOT NULL,
  saves INTEGER NOT NULL DEFAULT 0,
  recalls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
);

-- Stripe webhook idempotency.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY NOT NULL,
  received_at TEXT NOT NULL
);
