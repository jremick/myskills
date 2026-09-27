-- Discovery collections. Skill identity, releases, grants and adoptions stay canonical.
CREATE TABLE skill_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('curated','source')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 2000),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  owner_team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  visibility text NOT NULL CHECK (visibility IN ('public','authenticated','team','private')),
  source_entry_id uuid REFERENCES library_entries(id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_user_id IS NULL) <> (owner_team_id IS NULL)),
  CHECK (visibility <> 'team' OR owner_team_id IS NOT NULL),
  CHECK ((kind = 'source') = (source_entry_id IS NOT NULL))
);
CREATE INDEX skill_bundles_owner_user_idx ON skill_bundles(owner_user_id);
CREATE INDEX skill_bundles_owner_team_idx ON skill_bundles(owner_team_id);
CREATE UNIQUE INDEX skill_bundles_source_idx ON skill_bundles(source_entry_id) WHERE kind = 'source';
CREATE TABLE skill_bundle_members (
  bundle_id uuid NOT NULL REFERENCES skill_bundles(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0 AND position < 200),
  PRIMARY KEY (bundle_id,skill_id),
  UNIQUE(bundle_id,position)
);
CREATE INDEX skill_bundle_members_skill_idx ON skill_bundle_members(skill_id);
ALTER TABLE library_entries DROP CONSTRAINT library_entries_kind_check;
ALTER TABLE library_entries ADD CONSTRAINT library_entries_kind_check CHECK (kind IN ('source','skill','bundle'));
ALTER TABLE library_entries ADD COLUMN bundle_id uuid REFERENCES skill_bundles(id) ON DELETE SET NULL;
ALTER TABLE library_entries ADD COLUMN bundle_revision_saved integer CHECK (bundle_revision_saved > 0);
ALTER TABLE library_entries ADD CONSTRAINT library_entries_bundle_shape_check CHECK (
  kind <> 'bundle' OR (bundle_revision_saved IS NOT NULL AND skill_slug IS NULL AND source_id IS NULL AND lineage_id IS NULL AND current_adoption_id IS NULL AND tracking_mode = 'off')
);
CREATE UNIQUE INDEX library_entries_bundle_unique ON library_entries(library_id,bundle_id) WHERE kind = 'bundle' AND status = 'active';
