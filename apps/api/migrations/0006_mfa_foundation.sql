CREATE TYPE mfa_factor_type AS ENUM ('totp');
CREATE TYPE mfa_factor_status AS ENUM ('pending', 'enabled', 'disabled');

ALTER TABLE auth_sessions
  ADD COLUMN mfa_verified_at timestamptz;

ALTER TABLE api_tokens
  ADD COLUMN mfa_verified_at timestamptz;

CREATE TABLE mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type mfa_factor_type NOT NULL DEFAULT 'totp',
  status mfa_factor_status NOT NULL DEFAULT 'pending',
  label text NOT NULL DEFAULT 'Authenticator app',
  secret_ciphertext text NOT NULL,
  enabled_at timestamptz,
  disabled_at timestamptz,
  last_used_counter integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mfa_factors_user_idx ON mfa_factors (user_id);
CREATE INDEX mfa_factors_enabled_idx ON mfa_factors (user_id, status);

CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id);

CREATE TABLE mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mfa_challenges_user_idx ON mfa_challenges (user_id);
CREATE INDEX mfa_challenges_active_idx ON mfa_challenges (token_hash, expires_at) WHERE used_at IS NULL;
