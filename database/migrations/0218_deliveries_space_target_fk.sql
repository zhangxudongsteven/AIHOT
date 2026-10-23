ALTER TABLE deliveries ADD CONSTRAINT deliveries_space_target_fk FOREIGN KEY (space_id, target_key) REFERENCES notify_targets (space_id, key) NOT VALID;
