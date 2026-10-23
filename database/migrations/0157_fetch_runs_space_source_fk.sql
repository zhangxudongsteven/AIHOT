ALTER TABLE fetch_runs ADD CONSTRAINT fetch_runs_space_source_fk FOREIGN KEY (space_id, source_id) REFERENCES sources (space_id, id) ON DELETE CASCADE NOT VALID;
