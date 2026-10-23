ALTER TABLE grouping_decisions ADD CONSTRAINT grouping_decisions_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
