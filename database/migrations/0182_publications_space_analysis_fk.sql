ALTER TABLE publications ADD CONSTRAINT publications_space_analysis_fk FOREIGN KEY (space_id, article_id, analysis_id) REFERENCES analyses (space_id, article_id, id) NOT VALID;
