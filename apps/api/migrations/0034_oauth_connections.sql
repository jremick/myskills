-- Opt-in remote MCP connections (OAuth authorization code + PKCE).
-- Secret-bearing values are stored only as SHA-256 hex digests. Additive only:
-- no existing table changes, and the feature stays off unless configured.

CREATE TABLE oauth_clients (
  client_id text PRIMARY KEY CHECK (client_id ~ '^msc_[A-Za-z0-9_-]{20,64}$'),
  client_name text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 100),
  redirect_uris jsonb NOT NULL CHECK (jsonb_typeof(redirect_uris) = 'array' AND jsonb_array_length(redirect_uris) BETWEEN 1 AND 5),
  token_endpoint_auth_method text NOT NULL CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  client_secret_hash text CHECK (client_secret_hash IS NULL OR client_secret_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((token_endpoint_auth_method = 'none') = (client_secret_hash IS NULL))
);
CREATE INDEX oauth_clients_created_idx ON oauth_clients (created_at);

CREATE TABLE oauth_authorization_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle_hash text NOT NULL UNIQUE CHECK (handle_hash ~ '^[a-f0-9]{64}$'),
  client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 160),
  redirect_uri text NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 512),
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  resource text NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 2048),
  state text CHECK (state IS NULL OR char_length(state) <= 1024),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'pending') = (user_id IS NULL))
);
CREATE INDEX oauth_authorization_requests_expiry_idx ON oauth_authorization_requests (expires_at);

CREATE TABLE oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 160),
  client_name text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 100),
  client_registration text NOT NULL CHECK (client_registration IN ('dynamic', 'configured')),
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  resource text NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 2048),
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('user', 'client', 'refresh_reuse', 'code_replay', 'account')),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX oauth_grants_user_active_idx ON oauth_grants (user_id) WHERE revoked_at IS NULL;
CREATE INDEX oauth_grants_client_idx ON oauth_grants (client_id);
CREATE INDEX oauth_grants_retention_idx ON oauth_grants (expires_at);

CREATE TABLE oauth_authorization_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 160),
  redirect_uri text NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 512),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource text NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 2048),
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  replayed_at timestamptz,
  revoked_at timestamptz,
  grant_id uuid REFERENCES oauth_grants(id) ON DELETE SET NULL
);
CREATE INDEX oauth_authorization_codes_user_open_idx ON oauth_authorization_codes (user_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX oauth_authorization_codes_expiry_idx ON oauth_authorization_codes (expires_at);

CREATE TABLE oauth_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX oauth_access_tokens_grant_idx ON oauth_access_tokens (grant_id);
CREATE INDEX oauth_access_tokens_expiry_idx ON oauth_access_tokens (expires_at);

CREATE TABLE oauth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX oauth_refresh_tokens_grant_idx ON oauth_refresh_tokens (grant_id);
CREATE INDEX oauth_refresh_tokens_expiry_idx ON oauth_refresh_tokens (expires_at);
