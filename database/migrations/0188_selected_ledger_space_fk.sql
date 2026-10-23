ALTER TABLE selected_ledger ADD CONSTRAINT selected_ledger_space_fk FOREIGN KEY (space_id) REFERENCES spaces(id) NOT VALID;
