CREATE INDEX CONCURRENTLY IF NOT EXISTS selected_ledger_space_article_idx ON selected_ledger (space_id, article_id, seq DESC);
