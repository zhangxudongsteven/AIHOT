CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS reports_space_kind_key_uidx ON reports (space_id, kind, key);
