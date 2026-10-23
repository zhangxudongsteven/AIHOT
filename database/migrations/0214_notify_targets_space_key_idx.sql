CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS notify_targets_space_key_idx ON notify_targets (space_id, key);
