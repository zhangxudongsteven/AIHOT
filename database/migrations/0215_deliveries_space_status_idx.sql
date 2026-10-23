CREATE INDEX CONCURRENTLY IF NOT EXISTS deliveries_space_status_idx ON deliveries (space_id, status, created_at);
