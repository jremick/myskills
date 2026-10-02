-- Immutable metadata-only deployment intent. Approval and receipt histories
-- retain the existing sync journal; the target lease/fencing table is shared.
ALTER TABLE skill_architecture_sync_runs ADD COLUMN artifact_intent jsonb;
ALTER TABLE skill_architecture_sync_runs ADD CONSTRAINT architecture_artifact_intent_bound
CHECK (artifact_intent IS NULL OR (jsonb_typeof(artifact_intent)='object'
  AND octet_length(artifact_intent::text)<=262144
  AND (metadata->>'source'='architecture-artifact') IS TRUE
  AND (metadata->'reviewOnly'='false'::jsonb) IS TRUE
  AND (artifact_intent->'projection'->>'contract'='codex-workspace-architecture/v1') IS TRUE));
CREATE FUNCTION preserve_architecture_artifact_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.artifact_intent IS NOT NULL AND NEW.artifact_intent IS DISTINCT FROM OLD.artifact_intent THEN
    RAISE EXCEPTION 'architecture artifact intent is immutable';
  END IF;
  IF OLD.metadata->>'source' = 'architecture-artifact' OR NEW.metadata->>'source' = 'architecture-artifact' THEN
    IF OLD.metadata->'source' IS DISTINCT FROM NEW.metadata->'source'
       OR OLD.metadata->'reviewOnly' IS DISTINCT FROM NEW.metadata->'reviewOnly'
       OR OLD.metadata->'artifactDigest' IS DISTINCT FROM NEW.metadata->'artifactDigest' THEN
      RAISE EXCEPTION 'architecture artifact purpose and intent binding are immutable';
    END IF;
  END IF;
  IF NEW.artifact_intent IS NOT NULL AND (NEW.metadata->>'source'='architecture-plan' OR NEW.metadata->'reviewOnly'='true'::jsonb) THEN
    RAISE EXCEPTION 'review plans cannot receive executable artifact intent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER architecture_artifact_intent_immutable BEFORE UPDATE ON skill_architecture_sync_runs
FOR EACH ROW EXECUTE FUNCTION preserve_architecture_artifact_intent();

-- Ordinary sync transitions remain unchanged. Only the composed purpose can
-- enter an explicit rollback after aggregate success. API approval/lease gates
-- precede this transition; append-only rollback approval is persisted with it.
CREATE OR REPLACE FUNCTION enforce_skill_architecture_sync_run_update() RETURNS trigger
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
  IF NOT (OLD.status='succeeded' AND NEW.status='rollback_required'
           AND (OLD.metadata->>'source'='architecture-artifact') IS TRUE
           AND OLD.artifact_intent IS NOT NULL)
     AND NOT architecture_sync_run_transition_allowed(OLD.status, NEW.status)
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
