ALTER TABLE articles ADD CONSTRAINT articles_space_config_fk FOREIGN KEY (space_id, processing_config_version) REFERENCES space_configs (space_id, config_version) NOT VALID;
