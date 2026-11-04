-- Waitlist for Oort Cloud early access.
-- Stores only the email, when it was added and which page it came from.
-- No IP address and no user agent are stored.
CREATE TABLE IF NOT EXISTS waitlist (
  email TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL
);
