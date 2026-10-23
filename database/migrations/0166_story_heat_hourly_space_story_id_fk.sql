ALTER TABLE story_heat_hourly ADD CONSTRAINT story_heat_hourly_space_story_id_fk FOREIGN KEY (space_id, story_id) REFERENCES stories (space_id, id) ON DELETE CASCADE NOT VALID;
