-- Add durable team ownership without reassigning personal imports or touching
-- immutable provenance rows. Null personal skill owners remain reserved orphans.
ALTER TABLE skills
  ADD COLUMN owner_team_id uuid REFERENCES teams(id) ON DELETE RESTRICT,
  ADD CONSTRAINT skills_at_most_one_owner_check CHECK (num_nonnulls(owner_user_id, owner_team_id) <= 1);
CREATE INDEX skills_owner_team_idx ON skills(owner_team_id) WHERE owner_team_id IS NOT NULL;

ALTER TABLE library_import_lineages
  ALTER COLUMN owner_user_id DROP NOT NULL,
  ADD COLUMN owner_team_id uuid REFERENCES teams(id) ON DELETE RESTRICT,
  ADD CONSTRAINT library_import_lineages_exactly_one_owner_check CHECK (num_nonnulls(owner_user_id, owner_team_id) = 1);
CREATE UNIQUE INDEX library_import_lineages_team_identity_unique
  ON library_import_lineages(owner_team_id, source_id, source_path, ref_kind, ref_value)
  WHERE owner_team_id IS NOT NULL;

ALTER TABLE library_import_candidates
  ALTER COLUMN owner_user_id DROP NOT NULL,
  ADD COLUMN owner_team_id uuid REFERENCES teams(id) ON DELETE RESTRICT,
  ADD CONSTRAINT library_import_candidates_exactly_one_owner_check CHECK (num_nonnulls(owner_user_id, owner_team_id) = 1);

ALTER TABLE skill_release_provenance
  ALTER COLUMN owner_user_id DROP NOT NULL,
  ADD COLUMN owner_team_id uuid REFERENCES teams(id) ON DELETE RESTRICT,
  ADD CONSTRAINT skill_release_provenance_exactly_one_owner_check CHECK (num_nonnulls(owner_user_id, owner_team_id) = 1);
