-- Phase 2 fixture-only sync journal.
--
-- These tables record a bounded, metadata-only reconciliation plan and its
-- recovery evidence. They do not contain specifications, package bytes,
-- credentials, paths, URLs, prompts, configuration contents, or raw target
-- observations. A future adapter must perform its own authorization and
-- capability checks before any target write; these records do not authorize a
-- write by themselves.

-- The original migration used a globally valid revision id as the pointer
-- target. Keep all existing rows, but make the pointer tenant/architecture
-- scoped so a revision from another architecture can never be selected.
ALTER TABLE skill_architecture_revisions
  ADD CONSTRAINT skill_architecture_revisions_architecture_id_id_unique
  UNIQUE (architecture_id, id);

ALTER TABLE skill_architectures
  DROP CONSTRAINT skill_architectures_current_revision_fk;

ALTER TABLE skill_architectures
  ADD CONSTRAINT skill_architectures_current_revision_fk
  FOREIGN KEY (id, current_revision_id)
  REFERENCES skill_architecture_revisions (architecture_id, id)
  ON DELETE SET NULL (current_revision_id)
  DEFERRABLE INITIALLY DEFERRED;

-- Composite references below make the logical architecture and physical
-- snapshot bindings part of the database contract, even though each
-- referenced table already has a globally unique primary key. Run and lease
-- generations are historical evidence, so they deliberately reference the
-- target by id only. The target's mutable current generation must be able to
-- advance without invalidating retained sync history.
ALTER TABLE skill_architecture_targets
  ADD CONSTRAINT skill_architecture_targets_id_architecture_id_unique
  UNIQUE (id, architecture_id);

ALTER TABLE skill_architecture_targets
  ADD CONSTRAINT skill_architecture_targets_id_generation_unique
  UNIQUE (id, generation);

ALTER TABLE skill_architecture_observations
  ADD CONSTRAINT skill_architecture_observations_target_id_id_generation_unique
  UNIQUE (target_id, id, generation);

CREATE TYPE architecture_sync_run_kind AS ENUM ('preview', 'sync', 'recovery', 'rollback');
CREATE TYPE architecture_sync_run_status AS ENUM (
  'drafted',
  'awaiting_approval',
  'approved',
  'queued',
  'lease_acquiring',
  'revalidating',
  'preparing',
  'applying',
  'verifying',
  'succeeded',
  'blocked',
  'failed',
  'rollback_required',
  'rolling_back',
  'rolled_back',
  'rollback_failed',
  'cancelled',
  'expired'
);
CREATE TYPE architecture_sync_step_action AS ENUM (
  'noop',
  'install',
  'update',
  'downgrade',
  'enable',
  'disable',
  'remove',
  'conflict',
  'unsupported',
  'configure-router'
);
CREATE TYPE architecture_sync_step_status AS ENUM (
  'planned',
  'prepared',
  'started',
  'succeeded',
  'verify_failed',
  'compensating',
  'compensated',
  'failed',
  'skipped'
);
CREATE TYPE architecture_sync_failure_class AS ENUM (
  'validation',
  'authorization',
  'consent',
  'stale-target',
  'digest-mismatch',
  'conflict',
  'unsupported',
  'lease-lost',
  'transient',
  'verification',
  'mutation',
  'rollback',
  'ambiguous-readback',
  'irreversible',
  'unrecoverable'
);
CREATE TYPE architecture_sync_lease_status AS ENUM ('active', 'released', 'expired');
CREATE TYPE architecture_sync_receipt_kind AS ENUM (
  'run',
  'step',
  'lease',
  'approval',
  'baseline',
  'apply',
  'verify',
  'rollback',
  'recovery'
);
CREATE TYPE architecture_sync_receipt_status AS ENUM (
  'accepted',
  'started',
  'succeeded',
  'failed',
  'skipped',
  'unknown'
);
CREATE TYPE architecture_sync_recovery_condition AS ENUM (
  'no-mutation',
  'desired-readback',
  'restorable-partial-state',
  'ambiguous-readback',
  'irreversible-unrecoverable'
);
CREATE TYPE architecture_sync_recovery_decision AS ENUM (
  'retry',
  'succeed',
  'rollback',
  'block',
  'manual-intervention'
);

-- Core's sync contract accepts only scalar metadata. Keep the same boundary
-- at the database edge so future callers cannot bypass the shared validator.
CREATE FUNCTION architecture_sync_metadata_is_safe(p_metadata jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry record;
  kind text;
  scalar text;
BEGIN
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' THEN
    RETURN false;
  END IF;
  IF (SELECT count(*) FROM jsonb_each(p_metadata)) > 32 THEN
    RETURN false;
  END IF;

  FOR entry IN SELECT metadata_entry.key, metadata_entry.value FROM jsonb_each(p_metadata) AS metadata_entry LOOP
    IF entry.key !~ '^[A-Za-z][A-Za-z0-9._:-]{0,63}$'
       OR entry.key ~* '(api[_-]?key|authorization|bearer|certificate|ciphertext|cookie|credential|directory|endpoint|file|filesystem|header|host|password|path|private[-_ ]?key|prompt|package|secret|token|url|username|config|content)' THEN
      RETURN false;
    END IF;

    kind := jsonb_typeof(entry.value);
    IF kind NOT IN ('string', 'number', 'boolean', 'null') THEN
      RETURN false;
    END IF;
    IF kind = 'string' THEN
      scalar := entry.value #>> '{}';
      IF scalar IS NULL OR length(scalar) < 1 OR length(scalar) > 256
         OR scalar ~ '[[:cntrl:]]'
         OR scalar ~* '(https?://|ftp://|file://|-----BEGIN [A-Z ]+-----|(^|[[:space:] (])[A-Za-z]:[/\\]|(^|[[:space:] (])/(Users|home|root|private|var|tmp|etc|opt|workspace)([/[:space:] )]|$)|(^|[[:space:]])(bearer|basic)[[:space:]]+[A-Za-z0-9._~+/-]{8,}|(api[_-]?key|authorization|credential|password|private[-_ ]?key|secret|token)[[:space:]]*[:=])' THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE skill_architecture_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1,
  architecture_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  target_id uuid NOT NULL,
  target_generation integer NOT NULL,
  observed_snapshot_id uuid NOT NULL,
  profile_id text NOT NULL,
  environment_id text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  run_kind architecture_sync_run_kind NOT NULL,
  status architecture_sync_run_status NOT NULL DEFAULT 'drafted',
  request_key text NOT NULL,
  idempotency_key text NOT NULL,
  desired_digest text NOT NULL,
  compiled_digest text NOT NULL,
  observed_digest text NOT NULL,
  plan_digest text NOT NULL,
  approval_digest text,
  baseline_digest text,
  failure_class architecture_sync_failure_class,
  failure_code text,
  failure_retryable boolean,
  step_count integer NOT NULL DEFAULT 0,
  receipt_count integer NOT NULL DEFAULT 0,
  recovery_evidence_count integer NOT NULL DEFAULT 0,
  status_updated_at timestamptz NOT NULL DEFAULT now(),
  awaiting_approval_at timestamptz,
  approved_at timestamptz,
  queued_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  rollback_required_at timestamptz,
  rolled_back_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_architecture_sync_runs_schema_version_check
    CHECK (schema_version = 1),
  CONSTRAINT skill_architecture_sync_runs_architecture_revision_fk
    FOREIGN KEY (architecture_id, revision_id)
    REFERENCES skill_architecture_revisions (architecture_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT skill_architecture_sync_runs_target_architecture_fk
    FOREIGN KEY (target_id, architecture_id)
    REFERENCES skill_architecture_targets (id, architecture_id)
    ON DELETE RESTRICT,
  CONSTRAINT skill_architecture_sync_runs_observed_snapshot_fk
    FOREIGN KEY (target_id, observed_snapshot_id, target_generation)
    REFERENCES skill_architecture_observations (target_id, id, generation)
    ON DELETE RESTRICT,
  CONSTRAINT skill_architecture_sync_runs_profile_id_check
    CHECK (profile_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT skill_architecture_sync_runs_environment_id_check
    CHECK (environment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT skill_architecture_sync_runs_generation_check
    CHECK (target_generation BETWEEN 1 AND 1000000000),
  CONSTRAINT skill_architecture_sync_runs_request_key_check
    CHECK (request_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT skill_architecture_sync_runs_idempotency_key_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT skill_architecture_sync_runs_digest_check
    CHECK (
      desired_digest ~ '^[0-9a-f]{64}$'
      AND compiled_digest ~ '^[0-9a-f]{64}$'
      AND observed_digest ~ '^[0-9a-f]{64}$'
      AND plan_digest ~ '^[0-9a-f]{64}$'
      AND (approval_digest IS NULL OR approval_digest ~ '^[0-9a-f]{64}$')
      AND (baseline_digest IS NULL OR baseline_digest ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT skill_architecture_sync_runs_failure_pair_check
    CHECK ((failure_class IS NULL) = (failure_code IS NULL)),
  CONSTRAINT skill_architecture_sync_runs_failure_code_check
    CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9._:-]{0,95}$'),
  CONSTRAINT skill_architecture_sync_runs_count_check
    CHECK (
      step_count BETWEEN 0 AND 1000000
      AND receipt_count BETWEEN 0 AND 1000000
      AND recovery_evidence_count BETWEEN 0 AND 1000000
    ),
  CONSTRAINT skill_architecture_sync_runs_metadata_check
    CHECK (architecture_sync_metadata_is_safe(metadata)),
  CONSTRAINT skill_architecture_sync_runs_timestamps_check
    CHECK (
      status_updated_at >= created_at
      AND updated_at >= created_at
      AND (awaiting_approval_at IS NULL OR awaiting_approval_at >= created_at)
      AND (approved_at IS NULL OR approved_at >= created_at)
      AND (queued_at IS NULL OR queued_at >= created_at)
      AND (started_at IS NULL OR started_at >= created_at)
      AND (completed_at IS NULL OR completed_at >= created_at)
      AND (failed_at IS NULL OR failed_at >= created_at)
      AND (rollback_required_at IS NULL OR rollback_required_at >= created_at)
      AND (rolled_back_at IS NULL OR rolled_back_at >= created_at)
      AND (cancelled_at IS NULL OR cancelled_at >= created_at)
      AND (expired_at IS NULL OR expired_at >= created_at)
    ),
  CONSTRAINT skill_architecture_sync_runs_id_target_generation_unique
    UNIQUE (id, target_id, target_generation),
  CONSTRAINT skill_architecture_sync_runs_id_generation_unique
    UNIQUE (id, target_generation),
  CONSTRAINT skill_architecture_sync_runs_actor_request_unique
    UNIQUE (actor_user_id, request_key),
  CONSTRAINT skill_architecture_sync_runs_target_idempotency_unique
    UNIQUE (target_id, idempotency_key)
);

CREATE INDEX skill_architecture_sync_runs_nonterminal_idx
  ON skill_architecture_sync_runs (status, status_updated_at, updated_at, id)
  WHERE status NOT IN ('succeeded', 'rolled_back', 'cancelled', 'expired');

CREATE INDEX skill_architecture_sync_runs_target_history_idx
  ON skill_architecture_sync_runs (target_id, created_at DESC, id DESC);

CREATE INDEX skill_architecture_sync_runs_architecture_history_idx
  ON skill_architecture_sync_runs (architecture_id, created_at DESC, id DESC);

CREATE INDEX skill_architecture_sync_runs_revision_history_idx
  ON skill_architecture_sync_runs (revision_id, created_at DESC, id DESC);

CREATE FUNCTION architecture_sync_run_transition_allowed(
  from_status architecture_sync_run_status,
  to_status architecture_sync_run_status
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF from_status = to_status THEN
    RETURN true;
  END IF;
  RETURN CASE from_status
    WHEN 'drafted' THEN to_status IN ('awaiting_approval', 'blocked', 'cancelled', 'expired')
    WHEN 'awaiting_approval' THEN to_status IN ('approved', 'blocked', 'cancelled', 'expired')
    WHEN 'approved' THEN to_status IN ('queued', 'blocked', 'cancelled', 'expired')
    WHEN 'queued' THEN to_status IN ('lease_acquiring', 'blocked', 'cancelled', 'expired')
    WHEN 'lease_acquiring' THEN to_status IN ('revalidating', 'blocked', 'failed', 'expired')
    WHEN 'revalidating' THEN to_status IN ('preparing', 'blocked', 'failed', 'expired')
    WHEN 'preparing' THEN to_status IN ('applying', 'blocked', 'failed', 'expired')
    WHEN 'applying' THEN to_status IN ('verifying', 'rollback_required', 'failed', 'blocked')
    WHEN 'verifying' THEN to_status IN ('succeeded', 'rollback_required', 'failed', 'blocked')
    WHEN 'failed' THEN to_status IN ('rollback_required')
    WHEN 'rollback_required' THEN to_status IN ('rolling_back', 'rollback_failed', 'blocked')
    WHEN 'rolling_back' THEN to_status IN ('rolled_back', 'rollback_failed', 'blocked')
    ELSE false
  END;
END;
$$;

CREATE FUNCTION enforce_skill_architecture_sync_run_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.architecture_id IS DISTINCT FROM OLD.architecture_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.target_generation IS DISTINCT FROM OLD.target_generation
     OR NEW.observed_snapshot_id IS DISTINCT FROM OLD.observed_snapshot_id
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.environment_id IS DISTINCT FROM OLD.environment_id
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
     OR NEW.run_kind IS DISTINCT FROM OLD.run_kind
     OR NEW.request_key IS DISTINCT FROM OLD.request_key
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.desired_digest IS DISTINCT FROM OLD.desired_digest
     OR NEW.compiled_digest IS DISTINCT FROM OLD.compiled_digest
     OR NEW.observed_digest IS DISTINCT FROM OLD.observed_digest
     OR NEW.plan_digest IS DISTINCT FROM OLD.plan_digest
     OR (OLD.approval_digest IS NOT NULL AND NEW.approval_digest IS DISTINCT FROM OLD.approval_digest)
     OR (OLD.baseline_digest IS NOT NULL AND NEW.baseline_digest IS DISTINCT FROM OLD.baseline_digest) THEN
    RAISE EXCEPTION 'skill architecture sync run identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status_updated_at < OLD.status_updated_at
     OR NEW.updated_at < OLD.updated_at
     OR (OLD.awaiting_approval_at IS NOT NULL AND (NEW.awaiting_approval_at IS NULL OR NEW.awaiting_approval_at < OLD.awaiting_approval_at))
     OR (OLD.approved_at IS NOT NULL AND (NEW.approved_at IS NULL OR NEW.approved_at < OLD.approved_at))
     OR (OLD.queued_at IS NOT NULL AND (NEW.queued_at IS NULL OR NEW.queued_at < OLD.queued_at))
     OR (OLD.started_at IS NOT NULL AND (NEW.started_at IS NULL OR NEW.started_at < OLD.started_at))
     OR (OLD.completed_at IS NOT NULL AND (NEW.completed_at IS NULL OR NEW.completed_at < OLD.completed_at))
     OR (OLD.failed_at IS NOT NULL AND (NEW.failed_at IS NULL OR NEW.failed_at < OLD.failed_at))
     OR (OLD.rollback_required_at IS NOT NULL AND (NEW.rollback_required_at IS NULL OR NEW.rollback_required_at < OLD.rollback_required_at))
     OR (OLD.rolled_back_at IS NOT NULL AND (NEW.rolled_back_at IS NULL OR NEW.rolled_back_at < OLD.rolled_back_at))
     OR (OLD.cancelled_at IS NOT NULL AND (NEW.cancelled_at IS NULL OR NEW.cancelled_at < OLD.cancelled_at))
     OR (OLD.expired_at IS NOT NULL AND (NEW.expired_at IS NULL OR NEW.expired_at < OLD.expired_at)) THEN
    RAISE EXCEPTION 'skill architecture sync run timestamps must be forward-only'
      USING ERRCODE = '55000';
  END IF;
  IF NOT architecture_sync_run_transition_allowed(OLD.status, NEW.status)
     AND NOT (
       NEW.metadata->>'syncRecoverySourceState' = OLD.status::text
       AND NEW.metadata->>'syncRecoveryNextRunState' = NEW.status::text
       AND (
         (NEW.metadata->>'syncRecoveryCondition' = 'no-mutation' AND NEW.metadata->>'syncRecoveryDecision' = 'retry' AND NEW.status = 'queued')
         OR (NEW.metadata->>'syncRecoveryCondition' = 'desired-readback' AND NEW.metadata->>'syncRecoveryDecision' = 'succeed' AND NEW.status = 'succeeded')
         OR (NEW.metadata->>'syncRecoveryCondition' = 'restorable-partial-state' AND NEW.metadata->>'syncRecoveryDecision' = 'rollback' AND NEW.status = 'rollback_required')
         OR (NEW.metadata->>'syncRecoveryCondition' = 'ambiguous-readback' AND NEW.metadata->>'syncRecoveryDecision' = 'block' AND NEW.status = 'blocked')
         OR (NEW.metadata->>'syncRecoveryCondition' = 'irreversible-unrecoverable' AND NEW.metadata->>'syncRecoveryDecision' = 'manual-intervention' AND NEW.status = 'rollback_failed')
       )
     ) THEN
    RAISE EXCEPTION 'skill architecture sync run status transition is not permitted'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER skill_architecture_sync_runs_integrity
  BEFORE UPDATE ON skill_architecture_sync_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_skill_architecture_sync_run_update();

CREATE TABLE skill_architecture_sync_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1,
  run_id uuid NOT NULL,
  ordinal integer NOT NULL,
  action architecture_sync_step_action NOT NULL,
  node_id text NOT NULL,
  target_generation integer NOT NULL,
  status architecture_sync_step_status NOT NULL DEFAULT 'planned',
  idempotency_key text NOT NULL,
  desired_digest text NOT NULL,
  compiled_digest text NOT NULL,
  observed_digest text NOT NULL,
  plan_digest text NOT NULL,
  step_digest text NOT NULL,
  result_digest text,
  failure_class architecture_sync_failure_class,
  failure_code text,
  status_updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_architecture_sync_steps_schema_version_check
    CHECK (schema_version = 1),
  CONSTRAINT skill_architecture_sync_steps_run_fk
    FOREIGN KEY (run_id)
    REFERENCES skill_architecture_sync_runs (id)
    ON DELETE CASCADE,
  CONSTRAINT skill_architecture_sync_steps_run_generation_fk
    FOREIGN KEY (run_id, target_generation)
    REFERENCES skill_architecture_sync_runs (id, target_generation)
    ON DELETE CASCADE,
  CONSTRAINT skill_architecture_sync_steps_ordinal_check
    CHECK (ordinal BETWEEN 1 AND 1000000),
  CONSTRAINT skill_architecture_sync_steps_node_id_check
    CHECK (node_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT skill_architecture_sync_steps_generation_check
    CHECK (target_generation BETWEEN 1 AND 1000000000),
  CONSTRAINT skill_architecture_sync_steps_idempotency_key_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT skill_architecture_sync_steps_digest_check
    CHECK (
      desired_digest ~ '^[0-9a-f]{64}$'
      AND compiled_digest ~ '^[0-9a-f]{64}$'
      AND observed_digest ~ '^[0-9a-f]{64}$'
      AND plan_digest ~ '^[0-9a-f]{64}$'
      AND step_digest ~ '^[0-9a-f]{64}$'
      AND (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT skill_architecture_sync_steps_failure_pair_check
    CHECK ((failure_class IS NULL) = (failure_code IS NULL)),
  CONSTRAINT skill_architecture_sync_steps_failure_code_check
    CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9._:-]{0,95}$'),
  CONSTRAINT skill_architecture_sync_steps_metadata_check
    CHECK (architecture_sync_metadata_is_safe(metadata)),
  CONSTRAINT skill_architecture_sync_steps_timestamps_check
    CHECK (
      status_updated_at >= created_at
      AND (started_at IS NULL OR started_at >= created_at)
      AND (completed_at IS NULL OR completed_at >= created_at)
      AND updated_at >= created_at
    ),
  CONSTRAINT skill_architecture_sync_steps_run_id_unique
    UNIQUE (run_id, id),
  CONSTRAINT skill_architecture_sync_steps_run_ordinal_unique
    UNIQUE (run_id, ordinal),
  CONSTRAINT skill_architecture_sync_steps_run_idempotency_unique
    UNIQUE (run_id, idempotency_key)
);

CREATE INDEX skill_architecture_sync_steps_nonterminal_idx
  ON skill_architecture_sync_steps (run_id, status, status_updated_at, ordinal)
  WHERE status NOT IN ('succeeded', 'compensated', 'failed', 'skipped');

CREATE INDEX skill_architecture_sync_steps_run_order_idx
  ON skill_architecture_sync_steps (run_id, ordinal);

CREATE FUNCTION enforce_skill_architecture_sync_step_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  recovery_allowed boolean;
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.node_id IS DISTINCT FROM OLD.node_id
     OR NEW.target_generation IS DISTINCT FROM OLD.target_generation
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.desired_digest IS DISTINCT FROM OLD.desired_digest
     OR NEW.compiled_digest IS DISTINCT FROM OLD.compiled_digest
     OR NEW.observed_digest IS DISTINCT FROM OLD.observed_digest
     OR NEW.plan_digest IS DISTINCT FROM OLD.plan_digest
     OR NEW.step_digest IS DISTINCT FROM OLD.step_digest THEN
    RAISE EXCEPTION 'skill architecture sync step identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status_updated_at < OLD.status_updated_at
     OR NEW.updated_at < OLD.updated_at
     OR (OLD.started_at IS NOT NULL AND (NEW.started_at IS NULL OR NEW.started_at < OLD.started_at))
     OR (OLD.completed_at IS NOT NULL AND (NEW.completed_at IS NULL OR NEW.completed_at < OLD.completed_at)) THEN
    RAISE EXCEPTION 'skill architecture sync step timestamps must be forward-only'
      USING ERRCODE = '55000';
  END IF;
  recovery_allowed := COALESCE(NEW.metadata->>'syncRecoveryStepSourceState' = OLD.status::text
    AND NEW.metadata->>'syncRecoveryStepNextState' = NEW.status::text
    AND (
      (NEW.metadata->>'syncRecoveryCondition' = 'no-mutation'
        AND NEW.metadata->>'syncRecoveryDecision' = 'retry'
        AND OLD.status IN ('started', 'verify_failed')
        AND NEW.status = 'prepared')
      OR (NEW.metadata->>'syncRecoveryCondition' = 'desired-readback'
        AND NEW.metadata->>'syncRecoveryDecision' = 'succeed'
        AND OLD.status IN ('planned', 'prepared', 'started', 'verify_failed')
        AND NEW.status = 'succeeded')
    ), false);
  IF NOT recovery_allowed AND (
       OLD.status = 'planned' AND NEW.status NOT IN ('planned', 'prepared', 'skipped', 'failed')
       OR OLD.status = 'prepared' AND NEW.status NOT IN ('prepared', 'started', 'skipped', 'failed')
       OR OLD.status = 'started' AND NEW.status NOT IN ('started', 'succeeded', 'verify_failed', 'failed')
       OR OLD.status = 'verify_failed' AND NEW.status NOT IN ('verify_failed', 'compensating', 'failed')
       OR OLD.status = 'compensating' AND NEW.status NOT IN ('compensating', 'compensated', 'failed')
       OR OLD.status = 'succeeded' AND NEW.status NOT IN ('succeeded', 'compensated')
       OR OLD.status IN ('compensated', 'failed', 'skipped') AND NEW.status IS DISTINCT FROM OLD.status
     ) THEN
    RAISE EXCEPTION 'skill architecture sync step status transition is not permitted'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER skill_architecture_sync_steps_integrity
  BEFORE UPDATE ON skill_architecture_sync_steps
  FOR EACH ROW EXECUTE FUNCTION enforce_skill_architecture_sync_step_update();

CREATE TABLE skill_architecture_sync_target_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1,
  target_id uuid NOT NULL,
  run_id uuid NOT NULL,
  target_generation integer NOT NULL,
  holder_id text NOT NULL,
  fencing_token bigint NOT NULL,
  status architecture_sync_lease_status NOT NULL DEFAULT 'active',
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_architecture_sync_target_leases_schema_version_check
    CHECK (schema_version = 1),
  CONSTRAINT skill_architecture_sync_target_leases_target_fk
    FOREIGN KEY (target_id)
    REFERENCES skill_architecture_targets (id)
    ON DELETE RESTRICT,
  CONSTRAINT skill_architecture_sync_target_leases_run_fk
    FOREIGN KEY (run_id, target_id, target_generation)
    REFERENCES skill_architecture_sync_runs (id, target_id, target_generation)
    ON DELETE RESTRICT,
  CONSTRAINT skill_architecture_sync_target_leases_holder_id_check
    CHECK (holder_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT skill_architecture_sync_target_leases_generation_check
    CHECK (target_generation BETWEEN 1 AND 1000000000),
  CONSTRAINT skill_architecture_sync_target_leases_fencing_token_check
    CHECK (fencing_token BETWEEN 1 AND 1000000000000),
  CONSTRAINT skill_architecture_sync_target_leases_expiry_check
    CHECK (expires_at > acquired_at),
  CONSTRAINT skill_architecture_sync_target_leases_released_at_check
    CHECK (status = 'active' OR released_at IS NOT NULL),
  CONSTRAINT skill_architecture_sync_target_leases_metadata_check
    CHECK (architecture_sync_metadata_is_safe(metadata)),
  CONSTRAINT skill_architecture_sync_target_leases_timestamps_check
    CHECK (updated_at >= created_at AND acquired_at >= created_at),
  UNIQUE (target_id)
);

CREATE INDEX skill_architecture_sync_target_leases_expiry_idx
  ON skill_architecture_sync_target_leases (status, expires_at, target_id);

CREATE INDEX skill_architecture_sync_target_leases_run_idx
  ON skill_architecture_sync_target_leases (run_id, fencing_token DESC);

CREATE FUNCTION enforce_skill_architecture_sync_lease_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_id IS DISTINCT FROM OLD.target_id THEN
    RAISE EXCEPTION 'skill architecture sync target lease target is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.fencing_token < OLD.fencing_token THEN
    RAISE EXCEPTION 'skill architecture sync fencing token is stale'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.fencing_token = OLD.fencing_token
     AND (NEW.id IS DISTINCT FROM OLD.id
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.target_generation IS DISTINCT FROM OLD.target_generation
       OR NEW.holder_id IS DISTINCT FROM OLD.holder_id
       OR NEW.acquired_at IS DISTINCT FROM OLD.acquired_at) THEN
    RAISE EXCEPTION 'skill architecture sync lease replacement requires a newer fencing token'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.fencing_token > OLD.fencing_token AND NEW.acquired_at < OLD.acquired_at THEN
    RAISE EXCEPTION 'skill architecture sync lease acquisition must move forward in time'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'skill architecture sync lease timestamps must be forward-only'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER skill_architecture_sync_target_leases_integrity
  BEFORE UPDATE ON skill_architecture_sync_target_leases
  FOR EACH ROW EXECUTE FUNCTION enforce_skill_architecture_sync_lease_update();

CREATE FUNCTION prevent_skill_architecture_sync_lease_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'skill architecture sync target leases are retained for fencing history'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER skill_architecture_sync_target_leases_no_delete
  BEFORE DELETE ON skill_architecture_sync_target_leases
  FOR EACH ROW EXECUTE FUNCTION prevent_skill_architecture_sync_lease_mutation();

CREATE TRIGGER skill_architecture_sync_target_leases_no_truncate
  BEFORE TRUNCATE ON skill_architecture_sync_target_leases
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_skill_architecture_sync_lease_mutation();

CREATE TABLE skill_architecture_sync_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1,
  run_id uuid NOT NULL,
  target_id uuid NOT NULL,
  target_generation integer NOT NULL,
  observed_digest text NOT NULL,
  baseline_digest text NOT NULL,
  restorable boolean NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_architecture_sync_baselines_schema_version_check
    CHECK (schema_version = 1),
  CONSTRAINT skill_architecture_sync_baselines_run_fk
    FOREIGN KEY (run_id, target_id, target_generation)
    REFERENCES skill_architecture_sync_runs (id, target_id, target_generation)
    ON DELETE RESTRICT,
  CONSTRAINT skill_architecture_sync_baselines_generation_check
    CHECK (target_generation BETWEEN 1 AND 1000000000),
  CONSTRAINT skill_architecture_sync_baselines_digest_check
    CHECK (observed_digest ~ '^[0-9a-f]{64}$' AND baseline_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT skill_architecture_sync_baselines_metadata_check
    CHECK (architecture_sync_metadata_is_safe(metadata)),
  CONSTRAINT skill_architecture_sync_baselines_captured_at_check
    CHECK (captured_at >= created_at),
  UNIQUE (run_id),
  UNIQUE (run_id, id)
);

CREATE INDEX skill_architecture_sync_baselines_target_history_idx
  ON skill_architecture_sync_baselines (target_id, captured_at DESC, id DESC);

CREATE FUNCTION prevent_skill_architecture_sync_baseline_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'skill architecture sync baselines are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER skill_architecture_sync_baselines_append_only
  BEFORE UPDATE OR DELETE ON skill_architecture_sync_baselines
  FOR EACH ROW EXECUTE FUNCTION prevent_skill_architecture_sync_baseline_mutation();

CREATE TRIGGER skill_architecture_sync_baselines_no_truncate
  BEFORE TRUNCATE ON skill_architecture_sync_baselines
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_skill_architecture_sync_baseline_mutation();

CREATE TABLE skill_architecture_sync_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1,
  run_id uuid NOT NULL,
  step_id uuid,
  target_id uuid NOT NULL,
  target_generation integer NOT NULL,
  fencing_token bigint,
  kind architecture_sync_receipt_kind NOT NULL,
  status architecture_sync_receipt_status NOT NULL,
  code text NOT NULL,
  evidence_digest text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT skill_architecture_sync_receipts_schema_version_check
    CHECK (schema_version = 1),
  CONSTRAINT skill_architecture_sync_receipts_run_fk
    FOREIGN KEY (run_id, target_id, target_generation)
    REFERENCES skill_architecture_sync_runs (id, target_id, target_generation)
    ON DELETE RESTRICT,
  CONSTRAINT skill_architecture_sync_receipts_step_fk
    FOREIGN KEY (run_id, step_id)
    REFERENCES skill_architecture_sync_steps (run_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT skill_architecture_sync_receipts_generation_check
    CHECK (target_generation BETWEEN 1 AND 1000000000),
  CONSTRAINT skill_architecture_sync_receipts_fencing_token_check
    CHECK (fencing_token IS NULL OR fencing_token BETWEEN 1 AND 1000000000000),
  CONSTRAINT skill_architecture_sync_receipts_fencing_requirement_check
    CHECK (kind IN ('run', 'step', 'approval', 'baseline') OR fencing_token IS NOT NULL),
  CONSTRAINT skill_architecture_sync_receipts_recovery_code_check
    CHECK (kind <> 'recovery' OR code IN ('recovery.retry', 'recovery.succeed', 'recovery.rollback', 'recovery.block', 'recovery.manual')),
  CONSTRAINT skill_architecture_sync_receipts_code_check
    CHECK (code ~ '^[a-z][a-z0-9._:-]{0,95}$'),
  CONSTRAINT skill_architecture_sync_receipts_digest_check
    CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT skill_architecture_sync_receipts_recovery_digest_check
    CHECK (kind <> 'recovery' OR evidence_digest IS NOT NULL),
  CONSTRAINT skill_architecture_sync_receipts_message_check
    CHECK (
      message IS NULL
      OR (
        length(message) BETWEEN 1 AND 512
        AND message !~ '[[:cntrl:]]'
        AND message !~* '(https?://|ftp://|file://|-----BEGIN [A-Z ]+-----|(^|[[:space:] (])/(Users|home|root|private|var|tmp|etc|opt|workspace)([/[:space:] )]|$)|(^|[[:space:]])(bearer|basic)[[:space:]]+[A-Za-z0-9._~+/-]{8,}|(api[_-]?key|authorization|credential|password|private[-_ ]?key|secret|token)[[:space:]]*[:=])'
      )
    ),
  CONSTRAINT skill_architecture_sync_receipts_metadata_check
    CHECK (architecture_sync_metadata_is_safe(metadata))
);

CREATE INDEX skill_architecture_sync_receipts_run_history_idx
  ON skill_architecture_sync_receipts (run_id, recorded_at DESC, id DESC);

CREATE INDEX skill_architecture_sync_receipts_target_history_idx
  ON skill_architecture_sync_receipts (target_id, recorded_at DESC, id DESC);

CREATE FUNCTION enforce_skill_architecture_sync_fencing_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lease record;
BEGIN
  IF TG_TABLE_NAME = 'skill_architecture_sync_recovery_evidence'
     AND NEW.fencing_token IS NULL THEN
    RAISE EXCEPTION 'recovery evidence requires a fencing token'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.fencing_token IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT target_id, run_id, target_generation, fencing_token, status, expires_at
    INTO lease
    FROM skill_architecture_sync_target_leases
   WHERE target_id = NEW.target_id;
  IF NOT FOUND
     OR lease.run_id IS DISTINCT FROM NEW.run_id
     OR lease.target_generation IS DISTINCT FROM NEW.target_generation
     OR lease.fencing_token IS DISTINCT FROM NEW.fencing_token
     OR lease.status <> 'active'
     OR lease.expires_at <= NEW.recorded_at THEN
    RAISE EXCEPTION 'stale skill architecture sync fencing evidence'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_skill_architecture_sync_receipt_fencing_requirement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IN ('lease', 'apply', 'verify', 'rollback', 'recovery')
     AND NEW.fencing_token IS NULL THEN
    RAISE EXCEPTION 'mutation evidence requires a fencing token'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION prevent_skill_architecture_sync_receipt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'skill architecture sync receipts are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER skill_architecture_sync_receipts_fencing
  BEFORE INSERT ON skill_architecture_sync_receipts
  FOR EACH ROW EXECUTE FUNCTION enforce_skill_architecture_sync_fencing_evidence();

CREATE TRIGGER skill_architecture_sync_receipts_fencing_requirement
  BEFORE INSERT ON skill_architecture_sync_receipts
  FOR EACH ROW EXECUTE FUNCTION enforce_skill_architecture_sync_receipt_fencing_requirement();

CREATE TRIGGER skill_architecture_sync_receipts_append_only
  BEFORE UPDATE OR DELETE ON skill_architecture_sync_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_skill_architecture_sync_receipt_mutation();

CREATE TRIGGER skill_architecture_sync_receipts_no_truncate
  BEFORE TRUNCATE ON skill_architecture_sync_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_skill_architecture_sync_receipt_mutation();

CREATE TABLE skill_architecture_sync_recovery_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1,
  run_id uuid NOT NULL,
  target_id uuid NOT NULL,
  target_generation integer NOT NULL,
  fencing_token bigint,
  condition architecture_sync_recovery_condition NOT NULL,
  decision architecture_sync_recovery_decision NOT NULL,
  next_run_state architecture_sync_run_status NOT NULL,
  safe_to_retry boolean NOT NULL,
  requires_manual_review boolean NOT NULL,
  code text NOT NULL,
  evidence_digest text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT skill_architecture_sync_recovery_evidence_schema_version_check
    CHECK (schema_version = 1),
  CONSTRAINT skill_architecture_sync_recovery_evidence_run_fk
    FOREIGN KEY (run_id, target_id, target_generation)
    REFERENCES skill_architecture_sync_runs (id, target_id, target_generation)
    ON DELETE RESTRICT,
  CONSTRAINT skill_architecture_sync_recovery_evidence_generation_check
    CHECK (target_generation BETWEEN 1 AND 1000000000),
  CONSTRAINT skill_architecture_sync_recovery_evidence_fencing_token_check
    CHECK (fencing_token IS NULL OR fencing_token BETWEEN 1 AND 1000000000000),
  CONSTRAINT skill_architecture_sync_recovery_evidence_fencing_requirement_check
    CHECK (fencing_token IS NOT NULL),
  CONSTRAINT skill_architecture_sync_recovery_evidence_transition_code_check
    CHECK (
      (condition = 'no-mutation' AND decision = 'retry' AND next_run_state = 'queued' AND code = 'recovery.retry')
      OR (condition = 'desired-readback' AND decision = 'succeed' AND next_run_state = 'succeeded' AND code = 'recovery.succeed')
      OR (condition = 'restorable-partial-state' AND decision = 'rollback' AND next_run_state = 'rollback_required' AND code = 'recovery.rollback')
      OR (condition = 'ambiguous-readback' AND decision = 'block' AND next_run_state = 'blocked' AND code = 'recovery.block')
      OR (condition = 'irreversible-unrecoverable' AND decision = 'manual-intervention' AND next_run_state = 'rollback_failed' AND code = 'recovery.manual')
    ),
  CONSTRAINT skill_architecture_sync_recovery_evidence_code_check
    CHECK (code ~ '^[a-z][a-z0-9._:-]{0,95}$'),
  CONSTRAINT skill_architecture_sync_recovery_evidence_digest_check
    CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT skill_architecture_sync_recovery_evidence_metadata_check
    CHECK (architecture_sync_metadata_is_safe(metadata))
);

CREATE INDEX skill_architecture_sync_recovery_evidence_run_history_idx
  ON skill_architecture_sync_recovery_evidence (run_id, recorded_at DESC, id DESC);

CREATE INDEX skill_architecture_sync_recovery_evidence_target_history_idx
  ON skill_architecture_sync_recovery_evidence (target_id, recorded_at DESC, id DESC);

CREATE TRIGGER skill_architecture_sync_recovery_evidence_fencing
  BEFORE INSERT ON skill_architecture_sync_recovery_evidence
  FOR EACH ROW EXECUTE FUNCTION enforce_skill_architecture_sync_fencing_evidence();

CREATE TRIGGER skill_architecture_sync_recovery_evidence_append_only
  BEFORE UPDATE OR DELETE ON skill_architecture_sync_recovery_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_skill_architecture_sync_receipt_mutation();

CREATE TRIGGER skill_architecture_sync_recovery_evidence_no_truncate
  BEFORE TRUNCATE ON skill_architecture_sync_recovery_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_skill_architecture_sync_receipt_mutation();
