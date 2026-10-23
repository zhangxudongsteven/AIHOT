ALTER TABLE deliveries ADD CONSTRAINT deliveries_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
