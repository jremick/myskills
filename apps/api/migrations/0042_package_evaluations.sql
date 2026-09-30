-- Explicit legacy exception: only unbound synchronous scans that existed before 0039.
-- Raw fresh-schema fixtures have no historical migration journal and admit no exceptions.
CREATE TABLE legacy_package_scan_allowances (
  scan_run_id uuid PRIMARY KEY REFERENCES scan_runs(id) ON DELETE RESTRICT
);
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    INSERT INTO legacy_package_scan_allowances(scan_run_id)
    SELECT id FROM scan_runs WHERE artifact_sha256 IS NULL AND job_id IS NULL AND status='succeeded'
      AND created_at < (SELECT applied_at FROM schema_migrations WHERE id='0039_package_scan_jobs');
  END IF;
END;
$$;
CREATE TRIGGER legacy_package_scan_allowances_immutable BEFORE INSERT OR UPDATE OR DELETE ON legacy_package_scan_allowances
  FOR EACH ROW EXECUTE FUNCTION prevent_improvement_record_mutation();

-- QUALITY-02: completed exact-version static evidence. Reuse improvement suite revisions.
CREATE TABLE package_evaluation_runs (
  id uuid PRIMARY KEY,
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  suite_revision_id uuid NOT NULL REFERENCES improvement_document_revisions(id) ON DELETE RESTRICT,
  suite_sha256 text NOT NULL CHECK (suite_sha256 ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK ((jsonb_typeof(result)='object' AND pg_column_size(result)<=65536
    AND result->>'schemaVersion'='1' AND result->>'provenance'='api-owned'
    AND result->>'artifactSha256'=artifact_sha256 AND result->>'suiteSha256'=suite_sha256
    AND result->'runner'->>'id'='package-static' AND result->'runner'->>'version'='1'
    AND result->>'status' IN ('pass','fail','warning','skipped','incompatible')
    AND result ?& ARRAY['target','runner','provenance','status','totals','assertions','artifactSha256','suiteSha256']) IS TRUE),
  review_context jsonb NOT NULL CHECK (jsonb_typeof(review_context)='object' AND pg_column_size(review_context)<=4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_user_id,idempotency_key)
);
CREATE INDEX package_evaluation_runs_version_idx ON package_evaluation_runs(skill_version_id,created_at,id);
CREATE TRIGGER package_evaluation_runs_immutable BEFORE UPDATE OR DELETE ON package_evaluation_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_improvement_record_mutation();
-- Final database binding guards protect against implementation mistakes and direct mismatched inserts.
CREATE FUNCTION bind_package_evaluation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM skill_versions WHERE id=NEW.skill_version_id FOR SHARE;
  PERFORM id FROM skill_artifacts WHERE skill_version_id=NEW.skill_version_id ORDER BY id FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM skill_artifacts WHERE skill_version_id=NEW.skill_version_id AND sha256=NEW.artifact_sha256) THEN
    RAISE EXCEPTION 'evaluation artifact binding mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM improvement_document_revisions r JOIN improvement_documents d ON d.id=r.document_id
    WHERE r.id=NEW.suite_revision_id AND d.kind='suite' AND r.body_sha256=NEW.suite_sha256 AND r.body ? 'assertions') THEN
    RAISE EXCEPTION 'evaluation suite binding mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bind_package_evaluation BEFORE INSERT ON package_evaluation_runs FOR EACH ROW EXECUTE FUNCTION bind_package_evaluation();
