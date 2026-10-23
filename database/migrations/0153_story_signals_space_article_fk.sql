ALTER TABLE story_signals ADD CONSTRAINT story_signals_space_article_fk FOREIGN KEY (space_id, article_id) REFERENCES articles (space_id, id) ON DELETE CASCADE NOT VALID;
