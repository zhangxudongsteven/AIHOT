ALTER TABLE reports ADD CONSTRAINT reports_space_id_fkey FOREIGN KEY (space_id) REFERENCES spaces(id) NOT VALID;
