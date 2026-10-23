ALTER TABLE grouping_decisions ADD CONSTRAINT grouping_decisions_space_story_id_fk FOREIGN KEY (space_id, story_id) REFERENCES stories (space_id, id) NOT VALID;
