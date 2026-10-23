ALTER TABLE delivery_leases ADD CONSTRAINT delivery_leases_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
