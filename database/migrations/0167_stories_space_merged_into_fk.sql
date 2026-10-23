ALTER TABLE stories ADD CONSTRAINT stories_space_merged_into_fk FOREIGN KEY (space_id, merged_into) REFERENCES stories (space_id, id) NOT VALID;
