ALTER TABLE deliveries ADD CONSTRAINT deliveries_scope_pair_check CHECK (space_id = 'default' OR config_version IS NOT NULL) NOT VALID;
