ALTER TABLE reports ADD CONSTRAINT reports_space_config_fkey FOREIGN KEY (space_id, config_version) REFERENCES space_configs(space_id, config_version) NOT VALID;
