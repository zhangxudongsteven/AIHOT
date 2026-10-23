ALTER TABLE hot_rankings ADD CONSTRAINT hot_rankings_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
