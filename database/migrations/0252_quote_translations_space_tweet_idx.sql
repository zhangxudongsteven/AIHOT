CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS quote_translations_space_tweet_idx ON quote_translations(space_id, tweet_id);
