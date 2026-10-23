ALTER TABLE story_digests ADD CONSTRAINT story_digests_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
