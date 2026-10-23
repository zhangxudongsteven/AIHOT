ALTER TABLE fact_articles ADD CONSTRAINT fact_articles_space_article_fk FOREIGN KEY (space_id, article_id) REFERENCES articles (space_id, id) ON DELETE CASCADE NOT VALID;
