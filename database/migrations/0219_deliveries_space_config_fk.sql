ALTER TABLE deliveries ADD CONSTRAINT deliveries_space_config_fk FOREIGN KEY (space_id, config_version) REFERENCES space_configs (space_id, config_version) NOT VALID;
