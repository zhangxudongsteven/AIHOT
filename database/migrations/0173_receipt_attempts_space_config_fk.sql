ALTER TABLE receipt_attempts ADD CONSTRAINT receipt_attempts_space_config_fk FOREIGN KEY (space_id, config_version) REFERENCES space_configs (space_id, config_version) NOT VALID;
