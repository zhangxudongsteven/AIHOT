-- DEV-02 experiment only. The test installs this in a transaction-local random schema.
-- This is not a production migration or the complete AIHOT data model.
CREATE TABLE spaces (
  id text PRIMARY KEY CHECK (id <> '')
);

CREATE TABLE space_configs (
  space_id text NOT NULL REFERENCES spaces(id),
  config_version integer NOT NULL CHECK (config_version > 0),
  rule_version text NOT NULL,
  model_id text NOT NULL,
  required_keyword text NOT NULL CHECK (required_keyword <> ''),
  PRIMARY KEY (space_id, config_version),
  UNIQUE (space_id, config_version, rule_version, model_id)
);

CREATE TABLE articles (
  id uuid PRIMARY KEY,
  space_id text NOT NULL REFERENCES spaces(id),
  canonical_url text NOT NULL,
  title text NOT NULL,
  input_revision integer NOT NULL DEFAULT 1 CHECK (input_revision > 0),
  UNIQUE (space_id, id),
  UNIQUE (space_id, canonical_url)
);

CREATE TABLE processing_results (
  id uuid PRIMARY KEY,
  space_id text NOT NULL,
  article_id uuid NOT NULL,
  input_revision integer NOT NULL CHECK (input_revision > 0),
  config_version integer NOT NULL,
  rule_version text NOT NULL,
  model_id text NOT NULL,
  request_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('BLOCK', 'PASS')),
  selected boolean NOT NULL,
  CHECK (NOT selected OR decision = 'PASS'),
  FOREIGN KEY (space_id, article_id) REFERENCES articles(space_id, id),
  FOREIGN KEY (space_id, config_version, rule_version, model_id)
    REFERENCES space_configs(space_id, config_version, rule_version, model_id),
  UNIQUE (space_id, request_id),
  UNIQUE (space_id, article_id, input_revision, config_version)
);

CREATE TABLE reports (
  id uuid PRIMARY KEY,
  space_id text NOT NULL,
  config_version integer NOT NULL,
  report_date date NOT NULL,
  FOREIGN KEY (space_id, config_version) REFERENCES space_configs(space_id, config_version),
  UNIQUE (space_id, id),
  UNIQUE (space_id, report_date)
);

CREATE TABLE report_items (
  space_id text NOT NULL,
  report_id uuid NOT NULL,
  article_id uuid NOT NULL,
  PRIMARY KEY (space_id, report_id, article_id),
  FOREIGN KEY (space_id, report_id) REFERENCES reports(space_id, id),
  FOREIGN KEY (space_id, article_id) REFERENCES articles(space_id, id)
);

CREATE TABLE notify_targets (
  id uuid PRIMARY KEY,
  space_id text NOT NULL REFERENCES spaces(id),
  sink_label text NOT NULL,
  UNIQUE (space_id, id)
);

CREATE TABLE deliveries (
  id uuid PRIMARY KEY,
  space_id text NOT NULL,
  report_id uuid NOT NULL,
  target_id uuid NOT NULL,
  status text NOT NULL CHECK (status = 'pending'),
  FOREIGN KEY (space_id, report_id) REFERENCES reports(space_id, id),
  FOREIGN KEY (space_id, target_id) REFERENCES notify_targets(space_id, id),
  UNIQUE (space_id, report_id, target_id)
);
