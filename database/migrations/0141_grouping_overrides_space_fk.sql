ALTER TABLE grouping_overrides ADD CONSTRAINT grouping_overrides_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
