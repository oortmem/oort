-- `oort login`, redesigned after review findings I3, I4 and I5 (RFC 8628 style).
-- The CLI keeps a secret S (32 random bytes) and sends only h = base64url(SHA-256(S)) when it
-- starts a session; it polls with S in a POST body, never in a URL. The user types user_code,
-- shown in their terminal, on /account/cli. No API key is stored here: it is minted when the CLI
-- collects it, and only its hash lands in api_keys. Rows are pruned by the relay's cron
-- (apps/relay/src/prune.ts) once they are an hour old; nothing here was ever deployed, so the old
-- table is simply replaced.
DROP TABLE IF EXISTS cli_sessions;

CREATE TABLE cli_sessions (
  -- h: base64url SHA-256 of the CLI's secret.
  id TEXT PRIMARY KEY NOT NULL,
  -- 8 letters from BCDFGHJKLMNPQRSTVWXZ, shown as XXXX-XXXX, stored without the dash.
  user_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  -- Shown on the approve page so the user can tell the request is theirs. Two-letter country
  -- from Cloudflare's request.cf at creation (the IP itself is never stored), and the OS and
  -- host name the CLI reported.
  country TEXT,
  client_os TEXT,
  client_host TEXT,
  account_id TEXT REFERENCES accounts(id),
  approved_at TEXT,
  consumed_at TEXT
);

CREATE INDEX cli_sessions_created ON cli_sessions (created_at);
