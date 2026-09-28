-- Separate source authorization from MySkills sign-in providers.
CREATE TABLE github_app_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT false,
  app_id text NOT NULL DEFAULT '',
  client_id text NOT NULL DEFAULT '',
  client_secret_ciphertext text,
  private_key_ciphertext text,
  installation_id text,
  installation_enabled boolean NOT NULL DEFAULT false,
  generation integer NOT NULL DEFAULT 1,
  installation_ciphertext text,
  installation_expires_at timestamptz,
  installation_invalid boolean NOT NULL DEFAULT false,
  last_checked_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO github_app_config(id) VALUES(true);

CREATE TABLE github_user_connections (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  github_id text NOT NULL,
  login text NOT NULL,
  config_generation integer NOT NULL,
  access_ciphertext text,
  refresh_ciphertext text,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  reconnect_required boolean NOT NULL DEFAULT false,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE github_oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash text NOT NULL,
  config_generation integer NOT NULL,
  verifier_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE(user_id, session_hash)
);
CREATE INDEX github_oauth_states_expiry_idx ON github_oauth_states(expires_at);
