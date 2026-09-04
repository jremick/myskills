CREATE TYPE skill_upgrade_policy_scope AS ENUM ('target', 'organization');

CREATE FUNCTION skill_upgrade_policy_is_safe(candidate jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  item text;
  pin record;
  window_value jsonb;
BEGIN
  IF jsonb_typeof(candidate) <> 'object'
    OR candidate - ARRAY['schemaVersion', 'mode', 'includePrerelease', 'allowedChangeKinds', 'pins', 'maintenanceWindow'] <> '{}'::jsonb
    OR candidate->>'schemaVersion' <> '1'
    OR candidate->>'mode' NOT IN ('manual', 'maintenance-window')
    OR jsonb_typeof(candidate->'includePrerelease') <> 'boolean'
    OR jsonb_typeof(candidate->'allowedChangeKinds') <> 'array'
    OR jsonb_array_length(candidate->'allowedChangeKinds') NOT BETWEEN 1 AND 5
    OR jsonb_typeof(candidate->'pins') <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(candidate->'pins')) > 500
  THEN RETURN false;
  END IF;
  FOR item IN SELECT jsonb_array_elements_text(candidate->'allowedChangeKinds') LOOP
    IF item NOT IN ('fix', 'feature', 'breaking', 'security', 'maintenance') THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements_text(candidate->'allowedChangeKinds')) <>
     (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(candidate->'allowedChangeKinds') value)
  THEN RETURN false;
  END IF;
  FOR pin IN SELECT key, value FROM jsonb_each_text(candidate->'pins') LOOP
    IF pin.key !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'
      OR pin.value !~ '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$'
    THEN RETURN false;
    END IF;
  END LOOP;
  window_value := candidate->'maintenanceWindow';
  IF candidate->>'mode' = 'maintenance-window' AND window_value IS NULL THEN RETURN false; END IF;
  IF window_value IS NOT NULL THEN
    IF jsonb_typeof(window_value) <> 'object'
      OR window_value - ARRAY['timeZone', 'daysOfWeek', 'startMinute', 'durationMinutes'] <> '{}'::jsonb
      OR jsonb_typeof(window_value->'timeZone') <> 'string'
      OR window_value->>'timeZone' !~ '^[A-Za-z0-9_+/-]{1,64}$'
      OR jsonb_typeof(window_value->'daysOfWeek') <> 'array'
      OR jsonb_array_length(window_value->'daysOfWeek') NOT BETWEEN 1 AND 7
      OR jsonb_typeof(window_value->'startMinute') <> 'number'
      OR jsonb_typeof(window_value->'durationMinutes') <> 'number'
      OR (window_value->>'startMinute')::integer NOT BETWEEN 0 AND 1439
      OR (window_value->>'durationMinutes')::integer NOT BETWEEN 15 AND 1440
      OR (window_value->>'startMinute')::integer + (window_value->>'durationMinutes')::integer > 1440
    THEN RETURN false;
    END IF;
    FOR item IN SELECT jsonb_array_elements_text(window_value->'daysOfWeek') LOOP
      IF item !~ '^[0-6]$' THEN RETURN false; END IF;
    END LOOP;
  END IF;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$;

CREATE TABLE skill_upgrade_policy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1,
  scope_type skill_upgrade_policy_scope NOT NULL,
  scope_id uuid NOT NULL,
  revision_number integer NOT NULL,
  policy jsonb NOT NULL,
  policy_sha256 text NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_upgrade_policy_revisions_schema_check CHECK (schema_version = 1),
  CONSTRAINT skill_upgrade_policy_revisions_revision_check CHECK (revision_number BETWEEN 1 AND 1000000000),
  CONSTRAINT skill_upgrade_policy_revisions_digest_check CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT skill_upgrade_policy_revisions_reason_check CHECK (length(reason) <= 500 AND reason !~ '[[:cntrl:]]'),
  CONSTRAINT skill_upgrade_policy_revisions_policy_check CHECK (skill_upgrade_policy_is_safe(policy) AND pg_column_size(policy) <= 65536),
  UNIQUE (scope_type, scope_id, revision_number),
  UNIQUE (scope_type, scope_id, policy_sha256)
);

CREATE INDEX skill_upgrade_policy_revisions_scope_idx
  ON skill_upgrade_policy_revisions (scope_type, scope_id, revision_number DESC);

CREATE FUNCTION prevent_skill_upgrade_policy_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'skill upgrade policy revisions are immutable';
END;
$$;

CREATE TRIGGER skill_upgrade_policy_revisions_immutable
  BEFORE UPDATE OR DELETE ON skill_upgrade_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION prevent_skill_upgrade_policy_revision_mutation();
