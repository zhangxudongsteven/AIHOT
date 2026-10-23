ALTER TABLE notify_targets ADD COLUMN subject_kinds text[] NOT NULL DEFAULT '{selected}'::text[];
