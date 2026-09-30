-- Carry consent's actual session MFA provenance without upgrading old grants.
-- Refresh rotates credentials; it never renews the 15-minute assurance window.
ALTER TABLE oauth_authorization_codes
  ADD COLUMN mfa_verified_at timestamptz,
  ADD COLUMN assurance_expires_at timestamptz,
  ADD CONSTRAINT oauth_codes_assurance_consistent CHECK (
    (mfa_verified_at IS NULL AND assurance_expires_at IS NULL) OR
    (mfa_verified_at IS NOT NULL AND assurance_expires_at IS NOT NULL
      AND mfa_verified_at <= created_at
      AND assurance_expires_at = mfa_verified_at + interval '15 minutes')
  );

ALTER TABLE oauth_grants
  ADD COLUMN mfa_verified_at timestamptz,
  ADD COLUMN assurance_expires_at timestamptz,
  ADD CONSTRAINT oauth_grants_assurance_consistent CHECK (
    (mfa_verified_at IS NULL AND assurance_expires_at IS NULL) OR
    (mfa_verified_at IS NOT NULL AND assurance_expires_at IS NOT NULL
      AND mfa_verified_at <= created_at
      AND assurance_expires_at = mfa_verified_at + interval '15 minutes')
  );
