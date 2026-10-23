ALTER TABLE story_links ADD CONSTRAINT story_links_space_story_id_fk FOREIGN KEY (space_id, story_id) REFERENCES stories (space_id, id) ON DELETE CASCADE NOT VALID;
