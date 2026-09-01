CREATE TABLE skill_architectures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  pattern_id text NOT NULL CHECK (pattern_id IN ('flat', 'domain-router', 'multi-level-router')),
  current_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX skill_architectures_owner_idx
  ON skill_architectures (owner_user_id, updated_at DESC);

CREATE TABLE skill_architecture_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  architecture_id uuid NOT NULL REFERENCES skill_architectures(id) ON DELETE CASCADE,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  message text NOT NULL DEFAULT '' CHECK (length(message) <= 500),
  spec jsonb NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (architecture_id, revision_number)
);

CREATE INDEX skill_architecture_revisions_architecture_idx
  ON skill_architecture_revisions (architecture_id, revision_number DESC);

ALTER TABLE skill_architectures
  ADD CONSTRAINT skill_architectures_current_revision_fk
  FOREIGN KEY (current_revision_id)
  REFERENCES skill_architecture_revisions(id)
  ON DELETE SET NULL;
