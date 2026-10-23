CREATE INDEX CONCURRENTLY IF NOT EXISTS receipt_attempts_space_service_time_idx ON receipt_attempts(space_id, service, started_at) WHERE origin = 'live';
