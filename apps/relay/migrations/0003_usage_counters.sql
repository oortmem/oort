-- Every call the relay forwards is metered (review C1). saves and recalls stay the user-facing
-- units; these three are internal hard caps per account per month, so no route is unbounded.
ALTER TABLE usage ADD COLUMN embed_inputs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN rerank_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN decide_calls INTEGER NOT NULL DEFAULT 0;
