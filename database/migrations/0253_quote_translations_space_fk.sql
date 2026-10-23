ALTER TABLE quote_translations ADD CONSTRAINT quote_translations_space_fk FOREIGN KEY (space_id) REFERENCES spaces(id) NOT VALID;
