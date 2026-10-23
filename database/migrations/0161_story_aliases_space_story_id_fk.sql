ALTER TABLE story_aliases ADD CONSTRAINT story_aliases_space_story_id_fk FOREIGN KEY (space_id, story_id) REFERENCES stories (space_id, id) NOT VALID;
