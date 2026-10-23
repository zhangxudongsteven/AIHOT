ALTER TABLE story_signals ADD CONSTRAINT story_signals_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
