ALTER TABLE fetch_runs ADD CONSTRAINT fetch_runs_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
