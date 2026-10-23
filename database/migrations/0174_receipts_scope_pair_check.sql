ALTER TABLE receipts ADD CONSTRAINT receipts_scope_pair_check CHECK ((space_id IS NULL) = (config_version IS NULL)) NOT VALID;
