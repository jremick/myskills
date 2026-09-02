CREATE TABLE target_skill_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1,
  target_id uuid NOT NULL,
  target_generation integer NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  skill_slug text NOT NULL,
  from_version text,
  to_version text NOT NULL,
  platform text NOT NULL,
  artifact_sha256 text NOT NULL,
  artifact_byte_size bigint NOT NULL,
  artifact_content_type text NOT NULL,
  plan_digest text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  fencing_token integer NOT NULL DEFAULT 0,
  holder_id text,
  claim_token_hash text,
  lease_expires_at timestamptz,
  result jsonb,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT target_skill_operations_target_generation_fk
    FOREIGN KEY (target_id, target_generation)
    REFERENCES skill_architecture_targets (id, generation)
    ON DELETE RESTRICT,
  CONSTRAINT target_skill_operations_schema_version_check CHECK (schema_version = 1),
  CONSTRAINT target_skill_operations_generation_check CHECK (target_generation BETWEEN 1 AND 1000000000),
  CONSTRAINT target_skill_operations_action_check CHECK (action IN ('install', 'update', 'rollback')),
  CONSTRAINT target_skill_operations_slug_check CHECK (skill_slug ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'),
  CONSTRAINT target_skill_operations_state_check CHECK (state IN ('queued', 'claimed', 'applying', 'verifying', 'succeeded', 'failed', 'cancelled', 'expired')),
  CONSTRAINT target_skill_operations_digest_check CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$' AND plan_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT target_skill_operations_version_check CHECK (to_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' AND (from_version IS NULL OR from_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')),
  CONSTRAINT target_skill_operations_artifact_check CHECK (artifact_byte_size BETWEEN 1 AND 14680064 AND length(artifact_content_type) BETWEEN 1 AND 120 AND artifact_content_type !~ '[[:cntrl:]]'),
  CONSTRAINT target_skill_operations_platform_check CHECK (platform ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT target_skill_operations_fencing_check CHECK (fencing_token BETWEEN 0 AND 1000000000),
  CONSTRAINT target_skill_operations_idempotency_check CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT target_skill_operations_claim_pair_check CHECK ((holder_id IS NULL) = (claim_token_hash IS NULL) AND (claim_token_hash IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT target_skill_operations_claim_state_check CHECK ((state IN ('claimed', 'applying', 'verifying')) = (holder_id IS NOT NULL)),
  CONSTRAINT target_skill_operations_holder_check CHECK (holder_id IS NULL OR holder_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT target_skill_operations_claim_hash_check CHECK (claim_token_hash IS NULL OR claim_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT target_skill_operations_result_state_check CHECK ((state IN ('succeeded', 'failed')) = (result IS NOT NULL)),
  CONSTRAINT target_skill_operations_result_check CHECK (result IS NULL OR (
    jsonb_typeof(result) = 'object'
    AND result - ARRAY['status', 'code', 'recordedAt', 'installedVersion', 'artifactSha256', 'contentDigest'] = '{}'::jsonb
    AND result->>'status' = state
    AND result->>'code' ~ '^[a-z][a-z0-9._:-]{0,95}$'
    AND result->>'recordedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    AND (NOT result ? 'installedVersion' OR result->>'installedVersion' ~ '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')
    AND (NOT result ? 'artifactSha256' OR result->>'artifactSha256' ~ '^[0-9a-f]{64}$')
    AND (NOT result ? 'contentDigest' OR result->>'contentDigest' ~ '^[0-9a-f]{64}$')
  )),
  CONSTRAINT target_skill_operations_timestamp_check CHECK (updated_at >= created_at),
  CONSTRAINT target_skill_operations_target_idempotency_unique UNIQUE (target_id, idempotency_key)
);

CREATE INDEX target_skill_operations_target_history_idx
  ON target_skill_operations (target_id, created_at DESC, id DESC);

CREATE INDEX target_skill_operations_queue_idx
  ON target_skill_operations (target_id, created_at, id)
  WHERE state = 'queued';
