ALTER TABLE story_aliases ADD CONSTRAINT story_aliases_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
