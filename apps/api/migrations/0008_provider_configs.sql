CREATE TYPE provider_type AS ENUM ('oidc', 'saml', 'cloudflare_access', 'github', 'google');

CREATE TABLE provider_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  type provider_type NOT NULL,
  display_name text NOT NULL,
  issuer text,
  client_id text,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX provider_configs_key_idx ON provider_configs (key);

CREATE TABLE provider_role_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_config_id uuid NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
  claim text NOT NULL,
  value text NOT NULL,
  role role_name NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_config_id, claim, value, role)
);

CREATE INDEX provider_role_mappings_provider_idx ON provider_role_mappings (provider_config_id);
