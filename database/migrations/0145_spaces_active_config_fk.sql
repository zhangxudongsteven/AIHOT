ALTER TABLE spaces ADD CONSTRAINT spaces_active_config_fk FOREIGN KEY (id, active_config_version) REFERENCES space_configs (space_id, config_version) NOT VALID;
