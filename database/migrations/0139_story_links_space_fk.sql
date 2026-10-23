ALTER TABLE story_links ADD CONSTRAINT story_links_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
