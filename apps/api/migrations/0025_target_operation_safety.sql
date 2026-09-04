-- Retain the generation captured by an operation when its target is revoked or
-- re-enrolled. Execution compares generations under the target row lock.
ALTER TABLE target_skill_operations
  DROP CONSTRAINT target_skill_operations_target_generation_fk,
  ADD CONSTRAINT target_skill_operations_target_id_fk
    FOREIGN KEY (target_id) REFERENCES skill_architecture_targets(id) ON DELETE RESTRICT;

-- An operator may restore an earlier policy as a new immutable revision.
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'skill_upgrade_policy_revisions'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (scope_type, scope_id, policy_sha256)'
  LOOP
    EXECUTE format('ALTER TABLE skill_upgrade_policy_revisions DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;

-- Existing beta receipts remain historical evidence. Every newly written
-- success must identify exactly the planned release and verified local bytes.
ALTER TABLE target_skill_operations
  ADD CONSTRAINT target_skill_operations_success_evidence_check CHECK (
    state <> 'succeeded' OR coalesce(
      result->>'installedVersion' = to_version
      AND result->>'artifactSha256' = artifact_sha256
      AND result->>'contentDigest' ~ '^[0-9a-f]{64}$', false)
  ) NOT VALID;

CREATE TABLE target_skill_operation_claim_cursors (
  target_id uuid PRIMARY KEY REFERENCES skill_architecture_targets(id) ON DELETE CASCADE,
  operation_created_at timestamptz NOT NULL,
  operation_id uuid NOT NULL
);
CREATE INDEX target_skill_operations_success_idx ON target_skill_operations
  (target_id, target_generation, skill_slug, updated_at DESC, id DESC) WHERE state = 'succeeded';
