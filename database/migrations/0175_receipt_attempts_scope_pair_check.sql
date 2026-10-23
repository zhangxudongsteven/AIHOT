ALTER TABLE receipt_attempts ADD CONSTRAINT receipt_attempts_scope_pair_check CHECK ((space_id IS NULL) = (config_version IS NULL)) NOT VALID;
