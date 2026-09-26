-- Libraries first release (1A-1C). Additive only.
-- Private self-review starts disabled; only an MFA admin session can enable it.
INSERT INTO instance_settings (key, value)
VALUES ('library', '{"privateSelfReviewEnabled": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION library_reject_immutable_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

-- Public provider identity. Only unauthenticated public GitHub metadata is
-- stored; there is no credential column in this release.
CREATE TABLE library_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider = 'github'),
  repository_id text NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,19}$'),
  connection_id text NOT NULL DEFAULT 'public-unauthenticated' CHECK (connection_id = 'public-unauthenticated'),
  full_name text NOT NULL CHECK (length(full_name) BETWEEN 3 AND 141),
  html_url text NOT NULL CHECK (html_url ~ '^https://github\.com/'),
  default_branch text CHECK (default_branch IS NULL OR length(default_branch) <= 255),
  license_spdx text CHECK (license_spdx IS NULL OR length(license_spdx) <= 80),
  archived boolean NOT NULL DEFAULT false,
  url_history jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(url_history) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_sources_identity_unique UNIQUE (provider, repository_id, connection_id)
);

CREATE TABLE libraries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  owner_team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  client_mutation_id text CHECK (client_mutation_id IS NULL OR client_mutation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  client_mutation_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT libraries_exactly_one_owner_check CHECK ((owner_user_id IS NULL) <> (owner_team_id IS NULL)),
  CONSTRAINT libraries_deleted_check CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE UNIQUE INDEX libraries_client_mutation_idx ON libraries (created_by_user_id, client_mutation_id)
  WHERE client_mutation_id IS NOT NULL;
CREATE INDEX libraries_owner_user_idx ON libraries (owner_user_id, created_at DESC, id DESC)
  WHERE owner_user_id IS NOT NULL AND status = 'active';
CREATE INDEX libraries_owner_team_idx ON libraries (owner_team_id, created_at DESC, id DESC)
  WHERE owner_team_id IS NOT NULL AND status = 'active';

-- One import lineage per owner, source, skill root and release line. The
-- lineage authenticates the registry slug; ownership is never inferred from
-- a matching slug or a null registry owner.
CREATE TABLE library_import_lineages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES library_sources(id) ON DELETE RESTRICT,
  source_path text NOT NULL CHECK (length(source_path) <= 1024),
  ref_kind text NOT NULL CHECK (ref_kind IN ('default-branch', 'branch', 'tag', 'commit', 'latest-release', 'tag-prefix')),
  ref_value text NOT NULL DEFAULT '' CHECK (length(ref_value) <= 255),
  native_name text CHECK (native_name IS NULL OR length(native_name) <= 200),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' AND position('--' in slug) = 0 AND length(slug) <= 64),
  revision_counter integer NOT NULL DEFAULT 0 CHECK (revision_counter >= 0),
  -- Source order of the last accepted import. Older observations cannot
  -- become a newer registry revision.
  head_snapshot_id uuid,
  head_observed_at timestamptz,
  head_candidate_id uuid,
  head_source_digest text,
  head_files jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(head_files) = 'array'),
  mapping_overrides jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(mapping_overrides) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_import_lineages_slug_unique UNIQUE (slug),
  CONSTRAINT library_import_lineages_identity_unique UNIQUE (owner_user_id, source_id, source_path, ref_kind, ref_value)
);

CREATE TABLE library_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('source', 'skill')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  source_id uuid REFERENCES library_sources(id) ON DELETE RESTRICT,
  source_path text NOT NULL DEFAULT '' CHECK (length(source_path) <= 1024),
  ref_kind text CHECK (ref_kind IS NULL OR ref_kind IN ('default-branch', 'branch', 'tag', 'commit', 'latest-release', 'tag-prefix')),
  ref_value text NOT NULL DEFAULT '' CHECK (length(ref_value) <= 255),
  -- Repository identity per entry. The shared source row is metadata only;
  -- a rename or transfer waits in pending_full_name until this entry's owner
  -- acknowledges it.
  acknowledged_full_name text CHECK (acknowledged_full_name IS NULL OR length(acknowledged_full_name) BETWEEN 3 AND 141),
  pending_full_name text CHECK (pending_full_name IS NULL OR length(pending_full_name) BETWEEN 3 AND 141),
  tracking_mode text NOT NULL DEFAULT 'off' CHECK (tracking_mode IN ('off', 'manual', 'daily', 'weekly')),
  health text NOT NULL DEFAULT 'not-tracked' CHECK (health IN ('not-tracked', 'healthy', 'checking', 'rate-limited', 'access-lost', 'unavailable', 'archived', 'identity-change-review', 'paused')),
  next_check_at timestamptz,
  last_attempt_at timestamptz,
  last_successful_check_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9-]{0,63}$'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 100),
  lease_id uuid,
  lease_expires_at timestamptz,
  last_good_snapshot_id uuid,
  skill_slug text CHECK (skill_slug IS NULL OR length(skill_slug) <= 64),
  lineage_id uuid REFERENCES library_import_lineages(id) ON DELETE SET NULL,
  source_entry_id uuid REFERENCES library_entries(id) ON DELETE SET NULL,
  current_adoption_id uuid,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  client_mutation_id text CHECK (client_mutation_id IS NULL OR client_mutation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  client_mutation_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CONSTRAINT library_entries_removed_check CHECK ((status = 'removed') = (removed_at IS NOT NULL)),
  CONSTRAINT library_entries_source_shape_check CHECK (kind <> 'source' OR (source_id IS NOT NULL AND ref_kind IS NOT NULL AND skill_slug IS NULL AND acknowledged_full_name IS NOT NULL)),
  CONSTRAINT library_entries_skill_shape_check CHECK (kind <> 'skill' OR (skill_slug IS NOT NULL AND source_id IS NULL AND tracking_mode = 'off')),
  CONSTRAINT library_entries_lease_check CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX library_entries_source_unique ON library_entries (library_id, source_id, source_path, ref_kind, ref_value)
  WHERE kind = 'source' AND status = 'active';
CREATE UNIQUE INDEX library_entries_skill_unique ON library_entries (library_id, skill_slug)
  WHERE kind = 'skill' AND status = 'active';
CREATE UNIQUE INDEX library_entries_client_mutation_idx ON library_entries (created_by_user_id, client_mutation_id)
  WHERE client_mutation_id IS NOT NULL;
CREATE INDEX library_entries_library_idx ON library_entries (library_id, created_at DESC, id DESC) WHERE status = 'active';
CREATE INDEX library_entries_due_idx ON library_entries (next_check_at)
  WHERE kind = 'source' AND status = 'active' AND tracking_mode IN ('daily', 'weekly');
CREATE INDEX library_entries_source_entry_idx ON library_entries (source_entry_id) WHERE source_entry_id IS NOT NULL;
CREATE INDEX library_entries_skill_slug_idx ON library_entries (skill_slug) WHERE kind = 'skill' AND status = 'active';

-- Immutable resolved commit plus a bounded inventory. Bytes are never
-- stored here; held bytes live on candidates until expiry.
CREATE TABLE library_source_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES library_entries(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES library_sources(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence > 0),
  ref_kind text NOT NULL,
  ref_value text NOT NULL DEFAULT '',
  resolved_ref text,
  upstream_label text CHECK (upstream_label IS NULL OR length(upstream_label) <= 255),
  release_id text,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  tree_sha text NOT NULL CHECK (tree_sha ~ '^[0-9a-f]{40}$'),
  complete boolean NOT NULL,
  order_status text NOT NULL CHECK (order_status IN ('initial', 'ahead', 'identical', 'unverified')),
  inventory jsonb NOT NULL CHECK (jsonb_typeof(inventory) = 'array'),
  inventory_digest text NOT NULL CHECK (inventory_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_source_snapshots_sequence_unique UNIQUE (entry_id, sequence)
);
CREATE TRIGGER library_source_snapshots_immutable
  BEFORE UPDATE ON library_source_snapshots
  FOR EACH ROW EXECUTE FUNCTION library_reject_immutable_update();
ALTER TABLE library_entries ADD CONSTRAINT library_entries_last_good_snapshot_fk
  FOREIGN KEY (last_good_snapshot_id) REFERENCES library_source_snapshots(id) ON DELETE SET NULL;

-- One candidate per lineage, snapshot and import profile while active.
CREATE TABLE library_import_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entry_id uuid NOT NULL REFERENCES library_entries(id) ON DELETE CASCADE,
  skill_entry_id uuid REFERENCES library_entries(id) ON DELETE SET NULL,
  lineage_id uuid NOT NULL REFERENCES library_import_lineages(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES library_source_snapshots(id) ON DELETE CASCADE,
  snapshot_sequence bigint NOT NULL,
  preview_id uuid,
  origin text NOT NULL CHECK (origin IN ('preview', 'tracking')),
  state text NOT NULL CHECK (state IN ('ready-for-review', 'blocked', 'accepted', 'ignored', 'superseded', 'expired')),
  source_path text NOT NULL,
  native_name text,
  profile_digest text NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
  expected_prior_revision integer NOT NULL CHECK (expected_prior_revision >= 0),
  expected_version text NOT NULL,
  -- Order of the snapshot commit against the lineage's last imported commit.
  order_status text NOT NULL CHECK (order_status IN ('initial', 'ahead', 'identical', 'unverified')),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  package_digest text CHECK (package_digest IS NULL OR package_digest ~ '^[0-9a-f]{64}$'),
  files jsonb CHECK (files IS NULL OR jsonb_typeof(files) = 'array'),
  file_digests jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(file_digests) = 'array'),
  mapping jsonb NOT NULL CHECK (jsonb_typeof(mapping) = 'object'),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  changes jsonb,
  submission_id uuid REFERENCES skill_versions(id) ON DELETE SET NULL,
  accept_client_mutation_id text,
  order_acknowledgement text CHECK (order_acknowledgement IS NULL OR length(order_acknowledgement) <= 500),
  expires_at timestamptz NOT NULL,
  decided_by_user_id uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_import_candidates_blocked_digest_check CHECK (state <> 'blocked' OR package_digest IS NULL),
  CONSTRAINT library_import_candidates_ready_digest_check CHECK (state NOT IN ('ready-for-review', 'accepted') OR package_digest IS NOT NULL)
);
CREATE UNIQUE INDEX library_import_candidates_active_unique
  ON library_import_candidates (lineage_id, snapshot_id, profile_digest)
  WHERE state IN ('ready-for-review', 'blocked', 'accepted');
CREATE INDEX library_import_candidates_entry_idx ON library_import_candidates (source_entry_id, created_at DESC, id DESC);
CREATE INDEX library_import_candidates_lineage_idx ON library_import_candidates (lineage_id, state);
CREATE INDEX library_import_candidates_held_expiry_idx ON library_import_candidates (expires_at) WHERE files IS NOT NULL;
CREATE UNIQUE INDEX library_import_candidates_submission_idx ON library_import_candidates (submission_id) WHERE submission_id IS NOT NULL;

-- Immutable provenance bound to exactly one registry version.
CREATE TABLE skill_release_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  lineage_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  imported_by_user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'github'),
  repository_id text NOT NULL,
  repository_full_name text NOT NULL,
  repository_url text NOT NULL,
  ref_kind text NOT NULL,
  ref_value text NOT NULL DEFAULT '',
  upstream_label text,
  release_id text,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  tree_sha text NOT NULL CHECK (tree_sha ~ '^[0-9a-f]{40}$'),
  source_path text NOT NULL,
  native_name text,
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  package_digest text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
  files jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  notices jsonb NOT NULL CHECK (jsonb_typeof(notices) = 'array'),
  transforms jsonb NOT NULL CHECK (jsonb_typeof(transforms) = 'array'),
  importer_version text NOT NULL,
  import_profile_digest text NOT NULL CHECK (import_profile_digest ~ '^[0-9a-f]{64}$'),
  release_classification text NOT NULL CHECK (release_classification IN ('unclassified', 'reviewed')),
  order_acknowledgement text,
  retrieved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_release_provenance_version_unique UNIQUE (skill_version_id)
);
CREATE INDEX skill_release_provenance_lineage_idx ON skill_release_provenance (lineage_id);
CREATE TRIGGER skill_release_provenance_immutable
  BEFORE UPDATE ON skill_release_provenance
  FOR EACH ROW EXECUTE FUNCTION library_reject_immutable_update();

-- Review attestations beyond the ordinary maintainer review. A private
-- self-review never appears as a maintainer approval.
CREATE TABLE skill_version_review_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('private-self-review', 'instance-elevation')),
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid NOT NULL,
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_version_review_attestations_kind_unique UNIQUE (skill_version_id, kind)
);
CREATE TRIGGER skill_version_review_attestations_immutable
  BEFORE UPDATE ON skill_version_review_attestations
  FOR EACH ROW EXECUTE FUNCTION library_reject_immutable_update();

CREATE TABLE skill_version_elevation_requests (
  skill_version_id uuid PRIMARY KEY REFERENCES skill_versions(id) ON DELETE CASCADE,
  requested_by_user_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only adoption history. The entry pointer moves; rows never change.
CREATE TABLE library_adoptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES library_entries(id) ON DELETE CASCADE,
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  skill_slug text NOT NULL,
  version text NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  attestation text NOT NULL CHECK (attestation IN ('private-self-reviewed', 'instance-reviewed')),
  predecessor_adoption_id uuid,
  actor_user_id uuid NOT NULL,
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX library_adoptions_entry_idx ON library_adoptions (entry_id, created_at DESC, id DESC);
CREATE TRIGGER library_adoptions_immutable
  BEFORE UPDATE ON library_adoptions
  FOR EACH ROW EXECUTE FUNCTION library_reject_immutable_update();
ALTER TABLE library_entries ADD CONSTRAINT library_entries_current_adoption_fk
  FOREIGN KEY (current_adoption_id) REFERENCES library_adoptions(id) ON DELETE SET NULL;

-- Explicit opt-in constraint from a library entry to a connected target
-- install key. Removal keeps the last adopted pin until explicit detach.
CREATE TABLE library_target_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES library_entries(id) ON DELETE CASCADE,
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES skill_architecture_targets(id) ON DELETE CASCADE,
  skill_slug text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'curation-unavailable', 'detached')),
  pinned_version text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  detached_at timestamptz,
  CONSTRAINT library_target_bindings_detached_check CHECK ((status = 'detached') = (detached_at IS NOT NULL))
);
CREATE UNIQUE INDEX library_target_bindings_entry_target_unique ON library_target_bindings (entry_id, target_id)
  WHERE status <> 'detached';
CREATE INDEX library_target_bindings_key_idx ON library_target_bindings (target_id, skill_slug)
  WHERE status <> 'detached';

CREATE TABLE library_subscriptions (
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_kinds jsonb NOT NULL CHECK (jsonb_typeof(event_kinds) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (library_id, user_id)
);
CREATE INDEX library_subscriptions_user_idx ON library_subscriptions (user_id);

-- Semantic events. Recipients and content are resolved at read time after
-- authorization; a semantic key yields at most one in-app item.
CREATE TABLE library_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  entry_id uuid REFERENCES library_entries(id) ON DELETE CASCADE,
  candidate_id uuid REFERENCES library_import_candidates(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('candidate-ready', 'candidate-blocked', 'new-skill-discovered', 'skill-removed', 'skill-renamed-suggested', 'source-health-changed', 'adoption-changed')),
  audience text NOT NULL CHECK (audience IN ('curators', 'subscribers')),
  semantic_key text NOT NULL CHECK (length(semantic_key) <= 400),
  version text,
  path text CHECK (path IS NULL OR length(path) <= 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_events_semantic_key_unique UNIQUE (semantic_key)
);
CREATE INDEX library_events_library_idx ON library_events (library_id, created_at DESC, id DESC);

CREATE TABLE library_inbox_reads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES library_events(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);
