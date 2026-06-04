CREATE TYPE user_status AS ENUM ('pending', 'active', 'disabled', 'deleted');
CREATE TYPE role_name AS ENUM ('owner', 'admin', 'maintainer', 'author', 'user');
CREATE TYPE registration_mode AS ENUM ('closed', 'request', 'open');
CREATE TYPE skill_lifecycle_status AS ENUM ('draft', 'private', 'submitted', 'review', 'approved', 'deprecated', 'revoked', 'archived');
CREATE TYPE visibility_scope AS ENUM ('public', 'authenticated', 'organization', 'team', 'private', 'explicit-users');
CREATE TYPE review_status AS ENUM ('unreviewed', 'changes-requested', 'approved', 'rejected');
CREATE TYPE security_status AS ENUM ('not-run', 'passed', 'warning', 'failed');
CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  status user_status NOT NULL DEFAULT 'pending',
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name role_name NOT NULL UNIQUE,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role role_name NOT NULL,
  scope_type text NOT NULL DEFAULT 'instance',
  scope_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role, scope_type, scope_id)
);

CREATE TABLE instance_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  summary text NOT NULL,
  lifecycle_status skill_lifecycle_status NOT NULL DEFAULT 'draft',
  visibility visibility_scope NOT NULL DEFAULT 'private',
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skills_slug_format CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
);

CREATE TABLE skill_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version text NOT NULL,
  release_notes text NOT NULL DEFAULT '',
  review_status review_status NOT NULL DEFAULT 'unreviewed',
  security_status security_status NOT NULL DEFAULT 'not-run',
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);

CREATE TABLE skill_platform_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  name text NOT NULL,
  install_target text NOT NULL,
  status text NOT NULL DEFAULT 'supported',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_version_id, name)
);

CREATE TABLE skill_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  byte_size integer NOT NULL,
  content_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_key)
);

CREATE TABLE skill_tags (
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  tag text NOT NULL,
  PRIMARY KEY (skill_id, tag)
);

CREATE TABLE scan_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_version_id uuid REFERENCES skill_versions(id) ON DELETE CASCADE,
  status job_status NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scan_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id uuid NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  category text NOT NULL,
  severity text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  status job_status NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  decision text NOT NULL,
  resource_type text NOT NULL DEFAULT '',
  resource_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX skills_search_idx ON skills USING gin (to_tsvector('english', title || ' ' || summary || ' ' || slug));
CREATE INDEX skills_lifecycle_visibility_idx ON skills (lifecycle_status, visibility);
CREATE INDEX skill_tags_tag_idx ON skill_tags (tag);
CREATE INDEX audit_events_created_at_idx ON audit_events (created_at);
CREATE INDEX jobs_status_available_idx ON jobs (status, available_at);

