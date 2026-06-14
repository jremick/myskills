CREATE TYPE team_membership_role AS ENUM ('owner', 'member');
CREATE TYPE team_invitation_status AS ENUM ('pending', 'accepted', 'revoked');

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX teams_created_by_idx ON teams (created_by_user_id);

CREATE TABLE team_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role team_membership_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);

CREATE INDEX team_memberships_user_idx ON team_memberships (user_id);

CREATE TABLE team_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email text NOT NULL,
  normalized_email text NOT NULL,
  invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status team_invitation_status NOT NULL DEFAULT 'pending',
  accepted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, normalized_email)
);

CREATE INDEX team_invitations_recipient_idx ON team_invitations (normalized_email, status);

CREATE TABLE skill_team_grants (
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, team_id)
);

CREATE INDEX skill_team_grants_team_idx ON skill_team_grants (team_id);

CREATE TABLE skill_user_grants (
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, user_id)
);

CREATE INDEX skill_user_grants_user_idx ON skill_user_grants (user_id);

INSERT INTO instance_settings (key, value)
VALUES (
  'sharing',
  '{
    "publicVisibilityEnabled": true,
    "authenticatedVisibilityEnabled": true,
    "teamsEnabled": true,
    "teamVisibilityEnabled": true,
    "userVisibilityEnabled": true
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;
