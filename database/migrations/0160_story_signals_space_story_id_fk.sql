ALTER TABLE story_signals ADD CONSTRAINT story_signals_space_story_id_fk FOREIGN KEY (space_id, story_id) REFERENCES stories (space_id, id) ON DELETE CASCADE NOT VALID;
