ALTER TABLE stories ADD CONSTRAINT stories_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
