ALTER TABLE story_links ADD CONSTRAINT story_links_space_other_id_fk FOREIGN KEY (space_id, other_id) REFERENCES stories (space_id, id) ON DELETE CASCADE NOT VALID;
