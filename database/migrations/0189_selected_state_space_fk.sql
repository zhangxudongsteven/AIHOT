ALTER TABLE selected_state ADD CONSTRAINT selected_state_space_fk FOREIGN KEY (space_id) REFERENCES spaces(id) NOT VALID;
