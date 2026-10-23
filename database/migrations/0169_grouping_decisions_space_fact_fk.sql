ALTER TABLE grouping_decisions ADD CONSTRAINT grouping_decisions_space_fact_fk FOREIGN KEY (space_id, fact_id) REFERENCES facts (space_id, id) NOT VALID;
