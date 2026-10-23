ALTER TABLE publications ADD CONSTRAINT publications_space_source_fk FOREIGN KEY (space_id, source_id) REFERENCES sources (space_id, id) NOT VALID;
