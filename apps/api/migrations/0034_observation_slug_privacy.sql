-- The old whole-document scan also matched valid skill names such as
-- codex-config-sync. Exempt only bounded skills[].slug identifiers, after
-- checking the complete observation shape. Keep the existing text guard for
-- every other value, and reject free-form/nested metadata at the DB boundary.
-- Match the shared printable-text exclusions and raw-string path heuristic.
-- A slash alone does not make a printable label such as "CI/CD, nightly" a
-- path. The existing whole-record guards below still reject private content.
CREATE FUNCTION architecture_observation_printable_value_safe(value text, maximum integer) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  -- JavaScript \s has an explicit Unicode set; POSIX space varies by locale.
  -- Normalize only the string used for path matching, preserving its bytes.
  WITH normalized AS (
    SELECT regexp_replace(value, U&'[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]', ' ', 'g') AS text_value
  )
  SELECT length(value) BETWEEN 1 AND maximum
    AND value !~ U&'[\0001-\001f\007f-\009f\2028\2029]'
    AND text_value !~* '(^|[ (])(//|\\\\|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|/([A-Za-z0-9._-]+[\\/])|/(Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)([\\/]|$))'
    AND text_value !~* '(^|[ (])([A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+($|[ )])'
    AND text_value !~* '(^|[ (])(localhost|127\.0\.0\.1)(:[0-9]+)?([\\/]|$)'
  FROM normalized;
$$;

CREATE FUNCTION architecture_observation_metadata_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  item record;
  normalized_key text;
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(value)) > 32 THEN RETURN false; END IF;
  FOR item IN SELECT key, val FROM jsonb_each(value) AS entries(key, val) LOOP
    IF item.key !~ '^[A-Za-z][A-Za-z0-9._:-]{0,63}$' THEN RETURN false; END IF;
    normalized_key := lower(regexp_replace(regexp_replace(item.key, '([a-z0-9])([A-Z])', '\1-\2', 'g'), '[[:space:]_]+', '-', 'g'));
    IF normalized_key ~ '(^|[^a-z0-9])(api-key|authorization|credential|cookie|password|private-key|secret|token|prompt|path|endpoint|url|package|content|config|root|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)($|[^a-z0-9])' THEN RETURN false; END IF;
    IF jsonb_typeof(item.val) NOT IN ('null', 'string', 'number', 'boolean') THEN RETURN false; END IF;
    IF jsonb_typeof(item.val) = 'string' AND NOT architecture_observation_printable_value_safe(item.val #>> '{}', 256) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE FUNCTION architecture_observation_state_safe(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  item jsonb;
  field text;
  inspected jsonb;
  inspected_skills jsonb := '[]'::jsonb;
  text_value text;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF value - ARRAY['schemaVersion', 'id', 'targetId', 'targetGeneration', 'adapterDigest', 'capabilitiesDigest', 'observedAt', 'skills', 'configFindings', 'promptAwareness', 'metadata', 'observedDigest']::text[] <> '{}'::jsonb THEN RETURN false; END IF;
  IF value -> 'schemaVersion' IS DISTINCT FROM '1'::jsonb THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['targetId', 'id'] LOOP
    IF field = 'id' AND NOT value ? field THEN CONTINUE; END IF;
    IF jsonb_typeof(value -> field) IS DISTINCT FROM 'string' OR (value ->> field) !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN false; END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['adapterDigest', 'capabilitiesDigest', 'observedDigest'] LOOP
    IF jsonb_typeof(value -> field) IS DISTINCT FROM 'string' OR (value ->> field) !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(value -> 'targetGeneration') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  IF (value ->> 'targetGeneration') !~ '^[0-9]{1,10}$' OR (value ->> 'targetGeneration')::numeric NOT BETWEEN 1 AND 1000000000 THEN RETURN false; END IF;
  IF jsonb_typeof(value -> 'observedAt') IS DISTINCT FROM 'string' OR (value ->> 'observedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$' THEN RETURN false; END IF;
  IF NOT architecture_observation_metadata_valid(value -> 'metadata') THEN RETURN false; END IF;
  IF jsonb_typeof(value -> 'skills') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value -> 'skills') > 500 THEN RETURN false; END IF;
  FOR item IN SELECT element FROM jsonb_array_elements(value -> 'skills') AS skills(element) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF item - ARRAY['skillRefId', 'slug', 'version', 'digest', 'kind', 'enabled', 'runtimeExposure', 'configurationDigest', 'configured', 'managed', 'supported', 'metadata']::text[] <> '{}'::jsonb THEN RETURN false; END IF;
    IF jsonb_typeof(item -> 'slug') IS DISTINCT FROM 'string' OR (item ->> 'slug') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN false; END IF;
    IF item ? 'skillRefId' AND (jsonb_typeof(item -> 'skillRefId') IS DISTINCT FROM 'string' OR (item ->> 'skillRefId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') THEN RETURN false; END IF;
    IF item ? 'version' AND (jsonb_typeof(item -> 'version') IS DISTINCT FROM 'string' OR NOT architecture_observation_printable_value_safe(item ->> 'version', 64)) THEN RETURN false; END IF;
    FOREACH field IN ARRAY ARRAY['digest', 'configurationDigest'] LOOP
      IF item ? field AND (jsonb_typeof(item -> field) IS DISTINCT FROM 'string' OR (item ->> field) !~ '^[0-9a-f]{64}$') THEN RETURN false; END IF;
    END LOOP;
    FOREACH field IN ARRAY ARRAY['enabled', 'configured', 'managed', 'supported'] LOOP
      IF item ? field AND jsonb_typeof(item -> field) IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    END LOOP;
    IF item ? 'kind' AND (jsonb_typeof(item -> 'kind') IS DISTINCT FROM 'string' OR (item ->> 'kind') NOT IN ('router', 'leaf')) THEN RETURN false; END IF;
    IF item ? 'runtimeExposure' AND (jsonb_typeof(item -> 'runtimeExposure') IS DISTINCT FROM 'string' OR (item ->> 'runtimeExposure') NOT IN ('disabled', 'router', 'leaf')) THEN RETURN false; END IF;
    IF NOT architecture_observation_metadata_valid(item -> 'metadata') THEN RETURN false; END IF;
    -- A slug is exempt only at this exact, validated field; it cannot hide
    -- nested objects, unknown fields, paths, or unbounded text.
    inspected_skills := inspected_skills || jsonb_build_array(item - 'slug');
  END LOOP;
  IF jsonb_typeof(value -> 'configFindings') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value -> 'configFindings') > 100 THEN RETURN false; END IF;
  FOR item IN SELECT element FROM jsonb_array_elements(value -> 'configFindings') AS findings(element) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF item - ARRAY['code', 'severity', 'count']::text[] <> '{}'::jsonb THEN RETURN false; END IF;
    IF jsonb_typeof(item -> 'code') IS DISTINCT FROM 'string' OR (item ->> 'code') !~ '^[a-z][a-z0-9._:-]{0,63}$' THEN RETURN false; END IF;
    IF jsonb_typeof(item -> 'severity') IS DISTINCT FROM 'string' OR (item ->> 'severity') NOT IN ('info', 'warning', 'error') THEN RETURN false; END IF;
    IF jsonb_typeof(item -> 'count') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    IF (item ->> 'count') !~ '^[0-9]{1,10}$' OR (item ->> 'count')::numeric > 1000000000 THEN RETURN false; END IF;
  END LOOP;
  item := value -> 'promptAwareness';
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF item - ARRAY['detected', 'count', 'redacted']::text[] <> '{}'::jsonb THEN RETURN false; END IF;
  IF jsonb_typeof(item -> 'detected') IS DISTINCT FROM 'boolean' OR jsonb_typeof(item -> 'count') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  IF (item ->> 'count') !~ '^[0-9]{1,10}$' OR (item ->> 'count')::numeric > 1000000000 THEN RETURN false; END IF;
  IF item ? 'redacted' AND jsonb_typeof(item -> 'redacted') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
  inspected := jsonb_set(value, '{skills}', inspected_skills);
  text_value := inspected::text;
  RETURN text_value !~* '(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key|prompt|path|endpoint|url|package|content|config|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)([^a-z]|$)'
    AND text_value !~* '"root"[[:space:]]*:'
    AND text_value !~* '(https?://|ftp://|file://)'
    AND text_value !~* '(^|[^a-z0-9])/(Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)(/|[^a-z0-9]|$)'
    AND text_value !~* '(^|[^a-z0-9])(\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|localhost(:[0-9]+)?[\\/]|127\.0\.0\.1(:[0-9]+)?[\\/])'
    AND text_value !~* '(bearer|basic)[[:space:]]+[A-Za-z0-9._~+/-]{8,}'
    AND text_value !~ '-----BEGIN [A-Z0-9 ]+-----';
END;
$$;

-- NOT VALID enforces every new write without scanning or rewriting historical
-- append-only evidence, which can contain shapes accepted before this contract.
-- Do not claim historical rows passed the new validator. Targets, observation
-- bytes, digests, identifiers, indexes and append-only triggers are unchanged.
ALTER TABLE skill_architecture_observations
  DROP CONSTRAINT skill_architecture_observations_observed_state_safe_check,
  ADD CONSTRAINT skill_architecture_observations_observed_state_safe_check
    CHECK (architecture_observation_state_safe(observed_state)) NOT VALID;
