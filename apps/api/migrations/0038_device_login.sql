CREATE TABLE device_login_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL UNIQUE,
  user_code_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash text,
  mfa_verified_at timestamptz,
  interval_seconds integer NOT NULL DEFAULT 5 CHECK (interval_seconds BETWEEN 5 AND 60),
  last_polled_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_login_expiry_idx ON device_login_requests (expires_at);
