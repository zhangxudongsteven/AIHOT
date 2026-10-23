ALTER TABLE article_discoveries ADD CONSTRAINT article_discoveries_space_article_fk FOREIGN KEY (space_id, article_id) REFERENCES articles (space_id, id) ON DELETE CASCADE NOT VALID;
