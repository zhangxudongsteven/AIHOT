ALTER TABLE articles ADD CONSTRAINT articles_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
