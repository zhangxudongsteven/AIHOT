CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS receipts_space_version_id_idx ON receipts (space_id, config_version, id);
