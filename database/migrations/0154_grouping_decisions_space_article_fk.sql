ALTER TABLE grouping_decisions ADD CONSTRAINT grouping_decisions_space_article_fk FOREIGN KEY (space_id, article_id) REFERENCES articles (space_id, id) ON DELETE CASCADE NOT VALID;
