CREATE TABLE space_budgets (
  space_id text NOT NULL REFERENCES spaces(id),
  service text NOT NULL,
  per_minute integer NOT NULL CHECK (per_minute >= 0),
  per_hour integer NOT NULL CHECK (per_hour >= 0),
  per_day integer NOT NULL CHECK (per_day >= 0),
  reserved_minute integer NOT NULL DEFAULT 0 CHECK (reserved_minute >= 0 AND reserved_minute <= per_minute),
  reserved_hour integer NOT NULL DEFAULT 0 CHECK (reserved_hour >= 0 AND reserved_hour <= per_hour),
  reserved_day integer NOT NULL DEFAULT 0 CHECK (reserved_day >= 0 AND reserved_day <= per_day),
  note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, service)
);
