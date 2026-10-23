ALTER TABLE article_discoveries ADD CONSTRAINT article_discoveries_space_source_fk FOREIGN KEY (space_id, source_id) REFERENCES sources (space_id, id) NOT VALID;
