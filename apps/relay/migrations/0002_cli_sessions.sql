-- `oort login` sessions (site only). The id column holds the SHA-256 hash of the session id the
-- CLI generated, never the id itself. No API key is stored here: the key is minted when the CLI
-- polls after approval, handed over once, and only its hash lands in api_keys.
CREATE TABLE IF NOT EXISTS cli_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  approved_at TEXT,
  consumed_at TEXT
);
