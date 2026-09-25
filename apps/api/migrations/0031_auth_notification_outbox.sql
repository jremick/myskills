CREATE TABLE auth_notification_outbox (
  id uuid PRIMARY KEY,
  action_token_id uuid NOT NULL UNIQUE REFERENCES auth_action_tokens(id) ON DELETE CASCADE,
  payload_ciphertext text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'delivered', 'invalid', 'expired', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('pending', 'leased')) = (payload_ciphertext IS NOT NULL)),
  CHECK ((status = 'leased') = (lease_id IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX auth_notification_outbox_due_idx ON auth_notification_outbox (available_at)
  WHERE status IN ('pending', 'leased');
CREATE INDEX auth_notification_outbox_retention_idx ON auth_notification_outbox (updated_at)
  WHERE payload_ciphertext IS NULL;
