ALTER TABLE skill_architectures
  ALTER COLUMN owner_user_id DROP NOT NULL;

ALTER TABLE skill_architectures
  ADD COLUMN owner_team_id uuid REFERENCES teams(id) ON DELETE RESTRICT;

ALTER TABLE skill_architectures
  ADD COLUMN access_policy_version integer NOT NULL DEFAULT 1;

ALTER TABLE skill_architectures
  ADD CONSTRAINT skill_architectures_exactly_one_owner_check
  CHECK ((owner_user_id IS NOT NULL) <> (owner_team_id IS NOT NULL));

ALTER TABLE skill_architectures
  ADD CONSTRAINT skill_architectures_access_policy_version_check
  CHECK (access_policy_version = 1);

DROP INDEX skill_architectures_owner_idx;

CREATE INDEX skill_architectures_owner_user_idx
  ON skill_architectures (owner_user_id, updated_at DESC)
  WHERE owner_user_id IS NOT NULL;

CREATE INDEX skill_architectures_owner_team_idx
  ON skill_architectures (owner_team_id, updated_at DESC)
  WHERE owner_team_id IS NOT NULL;
