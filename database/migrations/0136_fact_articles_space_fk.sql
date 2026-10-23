ALTER TABLE fact_articles ADD CONSTRAINT fact_articles_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
