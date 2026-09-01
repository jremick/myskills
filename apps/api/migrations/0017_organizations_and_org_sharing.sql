CREATE TYPE organization_status AS ENUM ('provisioning', 'active', 'suspended', 'archived');
CREATE TYPE organization_membership_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE organization_invitation_status AS ENUM ('pending', 'accepted', 'revoked', 'expired');

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status organization_status NOT NULL DEFAULT 'provisioning',
  current_policy_revision_id uuid,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_active_requires_policy_check
    CHECK (status <> 'active' OR current_policy_revision_id IS NOT NULL)
);

CREATE TABLE organization_policy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  policy jsonb NOT NULL CHECK (
    jsonb_typeof(policy) = 'object'
    AND policy @> '{"schemaVersion": 1}'::jsonb
  ),
  policy_sha256 text NOT NULL CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, revision_number),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, policy_sha256)
);

CREATE INDEX organization_policy_revisions_org_idx
  ON organization_policy_revisions (organization_id, revision_number DESC);

ALTER TABLE organizations
  ADD CONSTRAINT organizations_current_policy_revision_fk
  FOREIGN KEY (id, current_policy_revision_id)
  REFERENCES organization_policy_revisions (organization_id, id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX organizations_status_idx ON organizations (status, updated_at DESC);

CREATE TABLE organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role organization_membership_role NOT NULL DEFAULT 'member',
  invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX organization_memberships_active_user_idx
  ON organization_memberships (user_id, organization_id)
  WHERE removed_at IS NULL;

CREATE INDEX organization_memberships_active_org_idx
  ON organization_memberships (organization_id, user_id)
  WHERE removed_at IS NULL;

CREATE TABLE organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  email text NOT NULL,
  normalized_email text NOT NULL,
  role organization_membership_role NOT NULL DEFAULT 'member',
  status organization_invitation_status NOT NULL DEFAULT 'pending',
  invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX organization_invitations_recipient_idx
  ON organization_invitations (normalized_email, status);

CREATE INDEX organization_invitations_org_idx
  ON organization_invitations (organization_id, status, created_at DESC);

CREATE UNIQUE INDEX organization_invitations_pending_unique_idx
  ON organization_invitations (organization_id, normalized_email)
  WHERE status = 'pending';

ALTER TABLE teams
  ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT;

CREATE INDEX teams_organization_idx
  ON teams (organization_id)
  WHERE organization_id IS NOT NULL;

CREATE TABLE skill_organization_grants (
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_under_policy_revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, organization_id),
  CONSTRAINT skill_organization_grants_policy_revision_fk
    FOREIGN KEY (organization_id, created_under_policy_revision_id)
    REFERENCES organization_policy_revisions (organization_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX skill_organization_grants_org_idx
  ON skill_organization_grants (organization_id, skill_id);

CREATE TABLE skill_architecture_organization_grants (
  architecture_id uuid NOT NULL REFERENCES skill_architectures(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  access_level text NOT NULL DEFAULT 'read',
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_under_policy_revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (architecture_id, organization_id),
  CONSTRAINT skill_architecture_organization_grants_access_level_check
    CHECK (access_level = 'read'),
  CONSTRAINT skill_architecture_organization_grants_policy_revision_fk
    FOREIGN KEY (organization_id, created_under_policy_revision_id)
    REFERENCES organization_policy_revisions (organization_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX skill_architecture_organization_grants_org_idx
  ON skill_architecture_organization_grants (organization_id, architecture_id);

CREATE FUNCTION prevent_organization_policy_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'organization policy revisions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER organization_policy_revisions_immutable
  BEFORE UPDATE OR DELETE ON organization_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION prevent_organization_policy_revision_mutation();
