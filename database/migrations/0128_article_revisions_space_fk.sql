ALTER TABLE article_revisions ADD CONSTRAINT article_revisions_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
