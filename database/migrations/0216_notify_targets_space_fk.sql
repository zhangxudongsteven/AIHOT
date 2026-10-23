ALTER TABLE notify_targets ADD CONSTRAINT notify_targets_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
