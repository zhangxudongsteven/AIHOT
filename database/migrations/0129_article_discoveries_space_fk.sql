ALTER TABLE article_discoveries ADD CONSTRAINT article_discoveries_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
