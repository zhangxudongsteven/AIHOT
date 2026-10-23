ALTER TABLE story_heat_hourly ADD CONSTRAINT story_heat_hourly_space_fk FOREIGN KEY (space_id) REFERENCES spaces (id) NOT VALID;
