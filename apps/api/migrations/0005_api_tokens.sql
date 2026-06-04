CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);
CREATE INDEX api_tokens_active_idx ON api_tokens (token_hash, expires_at) WHERE revoked_at IS NULL;
