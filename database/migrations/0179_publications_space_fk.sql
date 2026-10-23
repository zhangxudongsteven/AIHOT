ALTER TABLE publications ADD CONSTRAINT publications_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
