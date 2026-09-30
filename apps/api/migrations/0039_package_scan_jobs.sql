-- Existing completed legacy scans stay unchanged. New background evidence binds exact bytes.
ALTER TABLE jobs ADD COLUMN dedupe_key text;
ALTER TABLE jobs ADD COLUMN lease_id uuid;
ALTER TABLE jobs ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE jobs ADD COLUMN failure_code text;
CREATE UNIQUE INDEX jobs_dedupe_key_idx ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX jobs_package_scan_due_idx ON jobs (available_at, created_at, id) WHERE type = 'package-scan' AND status IN ('queued', 'running');

ALTER TABLE scan_runs ADD COLUMN artifact_sha256 text;
ALTER TABLE scan_runs ADD COLUMN runner_version text;
ALTER TABLE scan_runs ADD COLUMN job_id uuid REFERENCES jobs(id);
ALTER TABLE scan_runs ADD COLUMN attempt integer;
ALTER TABLE scan_runs ADD COLUMN failure_code text;
ALTER TABLE scan_runs ADD CONSTRAINT scan_runs_binding CHECK (
  job_id IS NULL OR (skill_version_id IS NOT NULL AND artifact_sha256 IS NOT NULL
    AND artifact_sha256 ~ '^[a-f0-9]{64}$' AND runner_version IS NOT NULL AND attempt IS NOT NULL AND attempt >= 1)
);
CREATE UNIQUE INDEX scan_runs_job_attempt_idx ON scan_runs (job_id, attempt) WHERE job_id IS NOT NULL;

CREATE FUNCTION preserve_completed_scan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed') AND OLD.job_id IS NOT NULL THEN
    IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM skill_versions WHERE id = OLD.skill_version_id) THEN
      RAISE EXCEPTION 'Completed package scan evidence is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_completed_scan BEFORE UPDATE OR DELETE ON scan_runs FOR EACH ROW EXECUTE FUNCTION preserve_completed_scan();

CREATE FUNCTION preserve_bound_scan_findings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM scan_runs WHERE id = OLD.scan_run_id AND job_id IS NOT NULL AND status IN ('succeeded', 'failed')) THEN
    RAISE EXCEPTION 'Completed package scan findings are immutable';
  END IF;
  IF TG_OP <> 'DELETE' AND EXISTS (SELECT 1 FROM scan_runs WHERE id = NEW.scan_run_id AND job_id IS NOT NULL AND status IN ('succeeded', 'failed')) THEN
    RAISE EXCEPTION 'Completed package scan findings are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_bound_scan_findings BEFORE INSERT OR UPDATE OR DELETE ON scan_findings FOR EACH ROW EXECUTE FUNCTION preserve_bound_scan_findings();
