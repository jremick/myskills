CREATE TYPE architecture_target_status AS ENUM ('connected', 'degraded', 'revoked');
CREATE TYPE architecture_target_consent_status AS ENUM ('pending', 'granted', 'denied', 'revoked');

-- A connected target is mutable operational metadata. It is deliberately kept
-- separate from the logical environments embedded in an architecture revision.
-- Owner columns are explicit so database-level tenancy cannot depend on a
-- caller-provided label or on a profile subject.
CREATE TABLE skill_architecture_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1,
  architecture_id uuid NOT NULL REFERENCES skill_architectures(id) ON DELETE RESTRICT,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  owner_team_id uuid REFERENCES teams(id) ON DELETE RESTRICT,
  owner_organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  adapter_kind text NOT NULL CHECK (adapter_kind ~ '^[a-z][a-z0-9._-]{0,63}$'),
  adapter_contract_version integer NOT NULL DEFAULT 1 CHECK (adapter_contract_version = 1),
  adapter_version text NOT NULL CHECK (
    length(adapter_version) BETWEEN 1 AND 64
    AND adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  environment_id text NOT NULL CHECK (
    environment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  profile_id text NOT NULL CHECK (
    profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  status architecture_target_status NOT NULL DEFAULT 'degraded',
  consent_status architecture_target_consent_status NOT NULL DEFAULT 'pending',
  consent_requested_at timestamptz NOT NULL DEFAULT now(),
  consent_granted_at timestamptz,
  consent_denied_at timestamptz,
  consent_revoked_at timestamptz,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities_digest text NOT NULL CHECK (capabilities_digest ~ '^[0-9a-f]{64}$'),
  identity_digest text NOT NULL CHECK (identity_digest ~ '^[0-9a-f]{64}$'),
  generation integer NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 1000000000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  health_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_reference text,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_architecture_targets_schema_version_check
    CHECK (schema_version = 1),
  CONSTRAINT skill_architecture_targets_exactly_one_owner_check
    CHECK (num_nonnulls(owner_user_id, owner_team_id, owner_organization_id) = 1),
  CONSTRAINT skill_architecture_targets_capabilities_object_check
    CHECK (jsonb_typeof(capabilities) = 'object'),
  CONSTRAINT skill_architecture_targets_capabilities_keys_check
    CHECK (
      (capabilities - ARRAY['inventory.read', 'health.read', 'plan.read', 'apply', 'rollback', 'sync.write']::text[])
      = '{}'::jsonb
    ),
  CONSTRAINT skill_architecture_targets_capabilities_boolean_values_check
    CHECK (
      (NOT capabilities ? 'inventory.read' OR jsonb_typeof(capabilities -> 'inventory.read') = 'boolean')
      AND (NOT capabilities ? 'health.read' OR jsonb_typeof(capabilities -> 'health.read') = 'boolean')
      AND (NOT capabilities ? 'plan.read' OR jsonb_typeof(capabilities -> 'plan.read') = 'boolean')
      AND (NOT capabilities ? 'apply' OR jsonb_typeof(capabilities -> 'apply') = 'boolean')
      AND (NOT capabilities ? 'rollback' OR jsonb_typeof(capabilities -> 'rollback') = 'boolean')
      AND (NOT capabilities ? 'sync.write' OR jsonb_typeof(capabilities -> 'sync.write') = 'boolean')
    ),
  CONSTRAINT skill_architecture_targets_capabilities_mutation_disabled_check
    CHECK (
      (NOT capabilities ? 'apply' OR capabilities -> 'apply' = 'false'::jsonb)
      AND (NOT capabilities ? 'rollback' OR capabilities -> 'rollback' = 'false'::jsonb)
      AND (NOT capabilities ? 'sync.write' OR capabilities -> 'sync.write' = 'false'::jsonb)
    ),
  CONSTRAINT skill_architecture_targets_capabilities_safe_check
    CHECK (
      capabilities::text !~* '(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key)([^a-z]|$)'
      AND capabilities::text !~* '(https?://|ftp://|file://)'
    ),
  CONSTRAINT skill_architecture_targets_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT skill_architecture_targets_metadata_safe_check
    CHECK (
      metadata::text !~* '(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key|prompt|path|endpoint|url|package|content|config|root|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)([^a-z]|$)'
      AND metadata::text !~* '(https?://|ftp://|file://)'
      AND metadata::text !~* '(^|[^a-z0-9])/(Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)(/|[^a-z0-9]|$)'
      AND metadata::text !~* '(^|[^a-z0-9])(\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|localhost(:[0-9]+)?[\\/]|127\.0\.0\.1(:[0-9]+)?[\\/])'
    ),
  CONSTRAINT skill_architecture_targets_health_summary_object_check
    CHECK (jsonb_typeof(health_summary) = 'object'),
  CONSTRAINT skill_architecture_targets_health_summary_safe_check
    CHECK (
      health_summary::text !~* '(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key|prompt|path|endpoint|url|package|content|config|root|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)([^a-z]|$)'
      AND health_summary::text !~* '(https?://|ftp://|file://)'
      AND health_summary::text !~* '(^|[^a-z0-9])/(Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)(/|[^a-z0-9]|$)'
      AND health_summary::text !~* '(^|[^a-z0-9])(\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|localhost(:[0-9]+)?[\\/]|127\.0\.0\.1(:[0-9]+)?[\\/])'
    ),
  CONSTRAINT skill_architecture_targets_consent_granted_at_check
    CHECK (consent_status <> 'granted' OR consent_granted_at IS NOT NULL),
  CONSTRAINT skill_architecture_targets_consent_denied_at_check
    CHECK (consent_status <> 'denied' OR consent_denied_at IS NOT NULL),
  CONSTRAINT skill_architecture_targets_consent_revoked_at_check
    CHECK (consent_status <> 'revoked' OR consent_revoked_at IS NOT NULL),
  CONSTRAINT skill_architecture_targets_consent_revoked_state_check
    CHECK (consent_revoked_at IS NULL OR consent_status = 'revoked'),
  CONSTRAINT skill_architecture_targets_connected_consent_check
    CHECK (status <> 'connected' OR consent_status = 'granted'),
  CONSTRAINT skill_architecture_targets_revoked_consent_check
    CHECK (status <> 'revoked' OR consent_status = 'revoked'),
  CONSTRAINT skill_architecture_targets_consent_revoked_status_check
    CHECK (consent_status <> 'revoked' OR status = 'revoked'),
  CONSTRAINT skill_architecture_targets_credential_reference_check
    CHECK (
      credential_reference IS NULL
      OR credential_reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
    )
);

CREATE INDEX skill_architecture_targets_owner_user_idx
  ON skill_architecture_targets (owner_user_id, updated_at DESC)
  WHERE owner_user_id IS NOT NULL;

CREATE INDEX skill_architecture_targets_owner_team_idx
  ON skill_architecture_targets (owner_team_id, updated_at DESC)
  WHERE owner_team_id IS NOT NULL;

CREATE INDEX skill_architecture_targets_owner_organization_idx
  ON skill_architecture_targets (owner_organization_id, updated_at DESC)
  WHERE owner_organization_id IS NOT NULL;

CREATE INDEX skill_architecture_targets_status_idx
  ON skill_architecture_targets (status, updated_at DESC);

CREATE INDEX skill_architecture_targets_architecture_binding_idx
  ON skill_architecture_targets (architecture_id, environment_id, profile_id, updated_at DESC);

-- Observations are evidence, not writable target state. The target generation
-- lets a reconnect invalidate stale observations without mutating their record.
CREATE TABLE skill_architecture_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1,
  target_id uuid NOT NULL REFERENCES skill_architecture_targets(id) ON DELETE RESTRICT,
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 1000000000),
  adapter_kind text NOT NULL CHECK (adapter_kind ~ '^[a-z][a-z0-9._-]{0,63}$'),
  adapter_contract_version integer NOT NULL CHECK (adapter_contract_version = 1),
  adapter_version text NOT NULL CHECK (
    length(adapter_version) BETWEEN 1 AND 64
    AND adapter_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  adapter_digest text NOT NULL CHECK (adapter_digest ~ '^[0-9a-f]{64}$'),
  capabilities_digest text NOT NULL CHECK (capabilities_digest ~ '^[0-9a-f]{64}$'),
  observed_digest text NOT NULL CHECK (observed_digest ~ '^[0-9a-f]{64}$'),
  observed_state jsonb NOT NULL,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  health_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_architecture_observations_schema_version_check
    CHECK (schema_version = 1),
  CONSTRAINT skill_architecture_observations_observed_state_object_check
    CHECK (jsonb_typeof(observed_state) = 'object'),
  CONSTRAINT skill_architecture_observations_observed_state_safe_check
    CHECK (
      observed_state::text !~* '(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key|prompt|path|endpoint|url|package|content|config|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)([^a-z]|$)'
      AND observed_state::text !~* '"root"[[:space:]]*:'
      AND observed_state::text !~* '(https?://|ftp://|file://)'
      AND observed_state::text !~* '(^|[^a-z0-9])/(Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)(/|[^a-z0-9]|$)'
      AND observed_state::text !~* '(^|[^a-z0-9])(\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|localhost(:[0-9]+)?[\\/]|127\.0\.0\.1(:[0-9]+)?[\\/])'
    ),
  CONSTRAINT skill_architecture_observations_counts_object_check
    CHECK (jsonb_typeof(counts) = 'object'),
  CONSTRAINT skill_architecture_observations_counts_safe_check
    CHECK (
      counts::text !~* '(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key|prompt|path|endpoint|url|package|content|config|root|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)([^a-z]|$)'
      AND counts::text !~* '(https?://|ftp://|file://)'
      AND counts::text !~* '(^|[^a-z0-9])/(Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)(/|[^a-z0-9]|$)'
      AND counts::text !~* '(^|[^a-z0-9])(\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|localhost(:[0-9]+)?[\\/]|127\.0\.0\.1(:[0-9]+)?[\\/])'
    ),
  CONSTRAINT skill_architecture_observations_health_summary_object_check
    CHECK (jsonb_typeof(health_summary) = 'object'),
  CONSTRAINT skill_architecture_observations_health_summary_safe_check
    CHECK (
      health_summary::text !~* '(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key|prompt|path|endpoint|url|package|content|config|root|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)([^a-z]|$)'
      AND health_summary::text !~* '(https?://|ftp://|file://)'
      AND health_summary::text !~* '(^|[^a-z0-9])/(Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)(/|[^a-z0-9]|$)'
      AND health_summary::text !~* '(^|[^a-z0-9])(\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|localhost(:[0-9]+)?[\\/]|127\.0\.0\.1(:[0-9]+)?[\\/])'
    )
);

-- The target/captured_at ordering supports bounded latest-observation and
-- retention queries without requiring an unbounded table scan.
CREATE INDEX skill_architecture_observations_target_captured_idx
  ON skill_architecture_observations (target_id, captured_at DESC, id DESC);

CREATE FUNCTION prevent_skill_architecture_observation_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'skill architecture observations are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER skill_architecture_observations_append_only
  BEFORE UPDATE OR DELETE ON skill_architecture_observations
  FOR EACH ROW EXECUTE FUNCTION prevent_skill_architecture_observation_mutation();

CREATE TRIGGER skill_architecture_observations_no_truncate
  BEFORE TRUNCATE ON skill_architecture_observations
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_skill_architecture_observation_mutation();
