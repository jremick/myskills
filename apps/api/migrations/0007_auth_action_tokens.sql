CREATE TYPE auth_action_token_purpose AS ENUM ('email_verification', 'password_reset');

CREATE TABLE auth_action_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose auth_action_token_purpose NOT NULL,
  token_hash text NOT NULL UNIQUE,
  sent_to_normalized_email text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_action_tokens_user_purpose_idx ON auth_action_tokens (user_id, purpose);
CREATE INDEX auth_action_tokens_active_idx ON auth_action_tokens (token_hash, purpose, expires_at) WHERE used_at IS NULL;
