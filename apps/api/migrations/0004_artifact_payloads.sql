ALTER TABLE skill_artifacts ADD COLUMN payload jsonb NOT NULL DEFAULT '{"files":[]}'::jsonb;
