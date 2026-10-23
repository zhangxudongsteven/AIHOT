CREATE TABLE space_configs (
  space_id text NOT NULL REFERENCES spaces (id),
  config_version text NOT NULL,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, config_version)
);
