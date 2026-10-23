CREATE TABLE spaces (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  active_config_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);
