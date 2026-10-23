ALTER TABLE quote_translations ADD CONSTRAINT quote_translations_scope_pair_check CHECK (space_id = 'default' OR config_version IS NOT NULL) NOT VALID;
