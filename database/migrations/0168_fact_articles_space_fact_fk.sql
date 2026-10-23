ALTER TABLE fact_articles ADD CONSTRAINT fact_articles_space_fact_fk FOREIGN KEY (space_id, fact_id) REFERENCES facts (space_id, id) ON DELETE CASCADE NOT VALID;
