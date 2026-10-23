ALTER TABLE story_digests ADD CONSTRAINT story_digests_space_story_id_fk FOREIGN KEY (space_id, story_id) REFERENCES stories (space_id, id) ON DELETE CASCADE NOT VALID;
