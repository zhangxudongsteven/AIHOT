CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS articles_space_identity_idx ON articles (space_id, identity_key);
