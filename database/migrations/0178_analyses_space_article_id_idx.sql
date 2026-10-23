CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS analyses_space_article_id_idx ON analyses (space_id, article_id, id);
