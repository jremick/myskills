-- Skill improvement (OPT-1): release declarations, reviewer policies, target profiles and suites,
-- server-bound plans, run records with append-only events, and accepted evidence.
-- Additive only. Artifact bytes and existing release columns are unchanged.

CREATE FUNCTION prevent_improvement_record_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'improvement records are immutable';
END;
$$;

CREATE TABLE improvement_declaration_revisions (
  id uuid PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  skill_slug text NOT NULL,
  version text NOT NULL,
  revision_number integer NOT NULL,
  kind text NOT NULL,
  declaration jsonb NOT NULL,
  declaration_sha256 text NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  CONSTRAINT improvement_declaration_revisions_revision_check CHECK (revision_number BETWEEN 1 AND 1000000),
  CONSTRAINT improvement_declaration_revisions_kind_check CHECK (kind IN ('declaration', 'attestation')),
  CONSTRAINT improvement_declaration_revisions_body_check CHECK (
    jsonb_typeof(declaration) = 'object' AND declaration->>'schemaVersion' = '1' AND pg_column_size(declaration) <= 65536
  ),
  CONSTRAINT improvement_declaration_revisions_digest_check CHECK (declaration_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT improvement_declaration_revisions_reason_check CHECK (length(reason) <= 500 AND reason !~ '[[:cntrl:]]'),
  UNIQUE (release_id, revision_number)
);

CREATE TABLE improvement_declaration_reviews (
  revision_id uuid PRIMARY KEY REFERENCES improvement_declaration_revisions(id) ON DELETE RESTRICT,
  decision text NOT NULL,
  binding_sha256 text NOT NULL,
  artifact_sha256 text NOT NULL,
  reviewer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  CONSTRAINT improvement_declaration_reviews_decision_check CHECK (decision IN ('approve', 'reject')),
  CONSTRAINT improvement_declaration_reviews_digest_check CHECK (binding_sha256 ~ '^[0-9a-f]{64}$' AND artifact_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT improvement_declaration_reviews_reason_check CHECK (length(reason) <= 500 AND reason !~ '[[:cntrl:]]')
);

CREATE TABLE improvement_policy_revisions (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL,
  scope_id uuid NOT NULL,
  revision_number integer NOT NULL,
  policy jsonb NOT NULL,
  policy_sha256 text NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  CONSTRAINT improvement_policy_revisions_scope_check CHECK (scope_type IN ('user', 'team', 'organization')),
  CONSTRAINT improvement_policy_revisions_revision_check CHECK (revision_number BETWEEN 1 AND 1000000000),
  CONSTRAINT improvement_policy_revisions_body_check CHECK (
    jsonb_typeof(policy) = 'object' AND policy->>'schemaVersion' = '1' AND pg_column_size(policy) <= 65536
  ),
  CONSTRAINT improvement_policy_revisions_digest_check CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT improvement_policy_revisions_reason_check CHECK (length(reason) <= 500 AND reason !~ '[[:cntrl:]]'),
  UNIQUE (scope_type, scope_id, revision_number)
);

CREATE TABLE improvement_documents (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  CONSTRAINT improvement_documents_kind_check CHECK (kind IN ('profile', 'suite')),
  CONSTRAINT improvement_documents_owner_check CHECK (owner_type IN ('user', 'team', 'organization'))
);

CREATE INDEX improvement_documents_owner_idx ON improvement_documents (kind, owner_type, owner_id, created_at);

CREATE TABLE improvement_document_revisions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES improvement_documents(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL,
  body jsonb NOT NULL,
  body_sha256 text NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  CONSTRAINT improvement_document_revisions_revision_check CHECK (revision_number BETWEEN 1 AND 1000000),
  CONSTRAINT improvement_document_revisions_body_check CHECK (
    jsonb_typeof(body) = 'object' AND body->>'schemaVersion' = '1' AND pg_column_size(body) <= 65536
  ),
  CONSTRAINT improvement_document_revisions_digest_check CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT improvement_document_revisions_reason_check CHECK (length(reason) <= 500 AND reason !~ '[[:cntrl:]]'),
  UNIQUE (document_id, revision_number)
);

CREATE TABLE improvement_plans (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL,
  request jsonb NOT NULL,
  plan_sha256 text NOT NULL,
  plan jsonb NOT NULL,
  effective_policy jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT improvement_plans_key_check CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT improvement_plans_digest_check CHECK (request_sha256 ~ '^[0-9a-f]{64}$' AND plan_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT improvement_plans_body_check CHECK (
    jsonb_typeof(plan) = 'object' AND jsonb_typeof(request) = 'object' AND jsonb_typeof(effective_policy) = 'object'
    AND pg_column_size(plan) <= 262144 AND pg_column_size(request) <= 131072 AND pg_column_size(effective_policy) <= 131072
  ),
  CONSTRAINT improvement_plans_expiry_check CHECK (expires_at > created_at),
  UNIQUE (actor_user_id, idempotency_key)
);

CREATE TABLE improvement_runs (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES improvement_plans(id) ON DELETE RESTRICT,
  plan_sha256 text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attempt integer NOT NULL,
  idempotency_key text NOT NULL,
  runner_sha256 text NOT NULL,
  runner jsonb NOT NULL,
  state text NOT NULL,
  progress jsonb NOT NULL,
  last_sequence integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  cancellation text NOT NULL DEFAULT 'not-requested',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT improvement_runs_attempt_check CHECK (attempt BETWEEN 1 AND 5),
  CONSTRAINT improvement_runs_state_check CHECK (state IN ('running', 'completed', 'failed', 'cancelled', 'expired')),
  CONSTRAINT improvement_runs_progress_check CHECK (jsonb_typeof(progress) = 'object' AND progress->>'state' = state AND pg_column_size(progress) <= 262144),
  CONSTRAINT improvement_runs_runner_check CHECK (jsonb_typeof(runner) = 'object' AND runner->>'adapter' IN ('codex', 'claude-code')),
  CONSTRAINT improvement_runs_cancellation_check CHECK (cancellation IN ('not-requested', 'requested-unconfirmed', 'requested')),
  CONSTRAINT improvement_runs_sequence_check CHECK (last_sequence BETWEEN 0 AND 100000 AND version >= 1),
  CONSTRAINT improvement_runs_terminal_check CHECK ((state = 'running') = (completed_at IS NULL)),
  UNIQUE (plan_id, attempt),
  UNIQUE (plan_id, idempotency_key)
);

-- One non-terminal attempt per plan.
CREATE UNIQUE INDEX improvement_runs_one_active_idx ON improvement_runs (plan_id) WHERE state = 'running';

CREATE FUNCTION guard_improvement_run_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'improvement records are immutable';
  END IF;
  IF OLD.state <> 'running' THEN
    RAISE EXCEPTION 'terminal improvement runs are immutable';
  END IF;
  IF NEW.id <> OLD.id OR NEW.plan_id <> OLD.plan_id OR NEW.plan_sha256 <> OLD.plan_sha256
    OR NEW.actor_user_id <> OLD.actor_user_id OR NEW.attempt <> OLD.attempt
    OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.runner_sha256 <> OLD.runner_sha256
    OR NEW.runner <> OLD.runner OR NEW.created_at <> OLD.created_at
    OR NEW.version <> OLD.version + 1 OR NEW.last_sequence < OLD.last_sequence
  THEN
    RAISE EXCEPTION 'improvement run identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER improvement_runs_guard
  BEFORE UPDATE OR DELETE ON improvement_runs
  FOR EACH ROW EXECUTE FUNCTION guard_improvement_run_update();

CREATE TABLE improvement_run_events (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES improvement_runs(id) ON DELETE RESTRICT,
  sequence integer NOT NULL,
  type text NOT NULL,
  event jsonb NOT NULL,
  event_sha256 text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT improvement_run_events_sequence_check CHECK (sequence BETWEEN 1 AND 100000),
  CONSTRAINT improvement_run_events_type_check CHECK (
    type IN ('stage.started', 'stage.completed', 'candidate.frozen', 'evaluation.recorded', 'run.completed', 'run.failed')
    AND event->>'type' = type
  ),
  CONSTRAINT improvement_run_events_body_check CHECK (jsonb_typeof(event) = 'object' AND pg_column_size(event) <= 131072),
  CONSTRAINT improvement_run_events_digest_check CHECK (event_sha256 ~ '^[0-9a-f]{64}$'),
  UNIQUE (run_id, sequence)
);

CREATE TABLE improvement_evidence (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES improvement_runs(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES improvement_plans(id) ON DELETE RESTRICT,
  reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  context jsonb NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL,
  disclosure text NOT NULL,
  provenance text NOT NULL,
  summary jsonb NOT NULL,
  evidence_sha256 text NOT NULL,
  proposals jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  CONSTRAINT improvement_evidence_disclosure_check CHECK (disclosure IN ('summary', 'selected-evidence')),
  -- No API path can attest execution yet; stronger provenance needs trusted runner enrollment.
  CONSTRAINT improvement_evidence_provenance_check CHECK (provenance = 'local-report'),
  CONSTRAINT improvement_evidence_body_check CHECK (
    jsonb_typeof(summary) = 'object' AND jsonb_typeof(proposals) = 'array' AND jsonb_array_length(proposals) <= 4
    AND pg_column_size(summary) <= 131072
  ),
  CONSTRAINT improvement_evidence_digest_check CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$' AND request_sha256 ~ '^[0-9a-f]{64}$'),
  UNIQUE (reporter_user_id, idempotency_key)
);

CREATE INDEX improvement_evidence_proposals_idx ON improvement_evidence USING gin (proposals jsonb_path_ops);

CREATE TABLE improvement_evidence_acceptances (
  id uuid PRIMARY KEY,
  evidence_id uuid NOT NULL REFERENCES improvement_evidence(id) ON DELETE RESTRICT,
  release_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  subject text NOT NULL,
  evidence_sha256 text NOT NULL,
  decision text NOT NULL,
  provenance text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  CONSTRAINT improvement_evidence_acceptances_subject_check CHECK (subject IN ('baseline', 'candidate')),
  CONSTRAINT improvement_evidence_acceptances_decision_check CHECK (decision IN ('accept', 'reject')),
  CONSTRAINT improvement_evidence_acceptances_provenance_check CHECK (provenance = 'local-report'),
  CONSTRAINT improvement_evidence_acceptances_digest_check CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT improvement_evidence_acceptances_reason_check CHECK (length(reason) <= 500 AND reason !~ '[[:cntrl:]]'),
  UNIQUE (evidence_id, release_id, subject)
);

CREATE INDEX improvement_evidence_acceptances_release_idx ON improvement_evidence_acceptances (release_id, created_at);

CREATE TRIGGER improvement_declaration_revisions_immutable
  BEFORE UPDATE OR DELETE ON improvement_declaration_revisions
  FOR EACH ROW EXECUTE FUNCTION prevent_improvement_record_mutation();
CREATE TRIGGER improvement_declaration_reviews_immutable
  BEFORE UPDATE OR DELETE ON improvement_declaration_reviews
  FOR EACH ROW EXECUTE FUNCTION prevent_improvement_record_mutation();
CREATE TRIGGER improvement_policy_revisions_immutable
  BEFORE UPDATE OR DELETE ON improvement_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION prevent_improvement_record_mutation();
CREATE TRIGGER improvement_documents_immutable
  BEFORE UPDATE OR DELETE ON improvement_documents
  FOR EACH ROW EXECUTE FUNCTION prevent_improvement_record_mutation();
CREATE TRIGGER improvement_document_revisions_immutable
  BEFORE UPDATE OR DELETE ON improvement_document_revisions
  FOR EACH ROW EXECUTE FUNCTION prevent_improvement_record_mutation();
CREATE TRIGGER improvement_plans_immutable
  BEFORE UPDATE OR DELETE ON improvement_plans
  FOR EACH ROW EXECUTE FUNCTION prevent_improvement_record_mutation();
CREATE TRIGGER improvement_run_events_immutable
  BEFORE UPDATE OR DELETE ON improvement_run_events
  FOR EACH ROW EXECUTE FUNCTION prevent_improvement_record_mutation();
CREATE TRIGGER improvement_evidence_immutable
  BEFORE UPDATE OR DELETE ON improvement_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_improvement_record_mutation();
CREATE TRIGGER improvement_evidence_acceptances_immutable
  BEFORE UPDATE OR DELETE ON improvement_evidence_acceptances
  FOR EACH ROW EXECUTE FUNCTION prevent_improvement_record_mutation();

-- Publication backstop for every writer: a release with an author declaration cannot become
-- published unless its latest declaration revision is approved for the approved artifact. The API
-- additionally rechecks the exact approval digest; declaration writes lock the same release row.
CREATE FUNCTION guard_improvement_declaration_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  latest_decision text;
  latest_artifact_sha256 text;
BEGIN
  SELECT v.decision, v.artifact_sha256 INTO latest_decision, latest_artifact_sha256
  FROM improvement_declaration_revisions r
  LEFT JOIN improvement_declaration_reviews v ON v.revision_id = r.id
  WHERE r.release_id = NEW.id AND r.kind = 'declaration'
  ORDER BY r.revision_number DESC
  LIMIT 1;
  IF FOUND AND (latest_decision IS DISTINCT FROM 'approve' OR latest_artifact_sha256 IS DISTINCT FROM NEW.approved_artifact_sha256) THEN
    RAISE EXCEPTION 'release declaration is not approved for the published artifact';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER skill_versions_improvement_declaration_publication
  BEFORE UPDATE OF published_at ON skill_versions
  FOR EACH ROW WHEN (OLD.published_at IS NULL AND NEW.published_at IS NOT NULL)
  EXECUTE FUNCTION guard_improvement_declaration_publication();
