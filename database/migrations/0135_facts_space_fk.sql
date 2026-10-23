ALTER TABLE facts ADD CONSTRAINT facts_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
