ALTER TABLE sources ADD CONSTRAINT sources_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
