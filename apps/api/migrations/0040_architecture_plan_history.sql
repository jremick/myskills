-- Keep persisted review fences immutable without freezing the journal's
-- internal lease/failure/recovery projection fields in metadata.
CREATE FUNCTION architecture_plan_review_fences_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fence_key text;
BEGIN
  IF OLD.metadata->>'source' = 'architecture-plan'
     OR NEW.metadata->>'source' = 'architecture-plan' THEN
    FOREACH fence_key IN ARRAY ARRAY[
      'source', 'reviewOnly', 'dryRun', 'canApply',
      'observationId', 'observationDigest', 'revisionDigest', 'targetIdentityDigest',
      'adapterDigest', 'capabilitiesDigest', 'consentDigest',
      'policyDigest', 'reviewDigest',
      'syncPublicId', 'syncPublicRunId', 'syncPublicTargetId',
      'syncPublicArchitectureId', 'syncPublicRevisionId',
      'syncIntentDigest', 'syncCapabilities'
    ] LOOP
      IF OLD.metadata->fence_key IS DISTINCT FROM NEW.metadata->fence_key THEN
        RAISE EXCEPTION 'architecture plan review fences are immutable'
          USING ERRCODE = '55000';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER skill_architecture_plan_review_fences_immutable
BEFORE UPDATE ON skill_architecture_sync_runs
FOR EACH ROW EXECUTE FUNCTION architecture_plan_review_fences_immutable();
