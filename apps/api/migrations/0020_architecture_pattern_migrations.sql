-- Pattern changes derive a new immutable architecture shell.  This lineage
-- records the exact source and target revisions without rebinding a target or
-- copying any grants.  The API owns authorization and computes all digests;
-- these constraints prevent an unsafe or cross-architecture record from
-- being persisted by a lower-level caller.

CREATE FUNCTION architecture_pattern_migration_scalar_is_safe(p_value text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_value IS NOT NULL
    AND length(p_value) BETWEEN 1 AND 160
    AND p_value !~ '[[:cntrl:]]'
    AND p_value !~* '(https?://|ftp://|file://|-----BEGIN [A-Z ]+-----|(^|[[:space:] (])/(Users|home|root|private|var|tmp|etc|opt|workspace)([/[:space:] )]|$)|(^|[[:space:]])(bearer|basic)[[:space:]]+[A-Za-z0-9._~+/-]{8,}|(api[_-]?key|authorization|credential|password|private[-_ ]?key|secret|token)[[:space:]]*[:=])';
$$;

CREATE FUNCTION architecture_pattern_migration_mapping_is_safe(p_mapping jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry record;
  group_entry jsonb;
  group_field record;
  leaf_entry jsonb;
  group_id text;
  parent_id text;
  leaf_id text;
  seen_group_ids text[] := ARRAY[]::text[];
  seen_leaf_ids text[] := ARRAY[]::text[];
BEGIN
  IF p_mapping IS NULL
     OR jsonb_typeof(p_mapping) <> 'object'
     OR octet_length(p_mapping::text) > 32768 THEN
    RETURN false;
  END IF;

  FOR entry IN SELECT key, value FROM jsonb_each(p_mapping) LOOP
    IF entry.key NOT IN ('rootRouterId', 'rootLabel', 'routerGroups', 'allowUnassignedLeafFallback') THEN
      RETURN false;
    END IF;
  END LOOP;

  IF p_mapping ? 'rootRouterId' THEN
    IF jsonb_typeof(p_mapping -> 'rootRouterId') <> 'string'
       OR (p_mapping ->> 'rootRouterId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
      RETURN false;
    END IF;
  END IF;
  IF p_mapping ? 'rootLabel' THEN
    IF jsonb_typeof(p_mapping -> 'rootLabel') <> 'string'
       OR NOT architecture_pattern_migration_scalar_is_safe(p_mapping ->> 'rootLabel') THEN
      RETURN false;
    END IF;
  END IF;
  IF p_mapping ? 'allowUnassignedLeafFallback'
     AND jsonb_typeof(p_mapping -> 'allowUnassignedLeafFallback') <> 'boolean' THEN
    RETURN false;
  END IF;

  IF p_mapping ? 'routerGroups' THEN
    IF jsonb_typeof(p_mapping -> 'routerGroups') <> 'array'
       OR jsonb_array_length(p_mapping -> 'routerGroups') > 500 THEN
      RETURN false;
    END IF;

    FOR group_entry IN SELECT value FROM jsonb_array_elements(p_mapping -> 'routerGroups') LOOP
      IF jsonb_typeof(group_entry) <> 'object' THEN
        RETURN false;
      END IF;
      FOR group_field IN SELECT key, value FROM jsonb_each(group_entry) LOOP
        IF group_field.key NOT IN ('id', 'label', 'parentRouterId', 'leafNodeIds') THEN
          RETURN false;
        END IF;
      END LOOP;
      IF NOT (group_entry ? 'id') OR jsonb_typeof(group_entry -> 'id') <> 'string'
         OR (group_entry ->> 'id') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
        RETURN false;
      END IF;
      group_id := group_entry ->> 'id';
      IF group_id = ANY(seen_group_ids) THEN
        RETURN false;
      END IF;
      seen_group_ids := array_append(seen_group_ids, group_id);

      IF NOT (group_entry ? 'label') OR jsonb_typeof(group_entry -> 'label') <> 'string'
         OR NOT architecture_pattern_migration_scalar_is_safe(group_entry ->> 'label') THEN
        RETURN false;
      END IF;
      IF group_entry ? 'parentRouterId' THEN
        IF jsonb_typeof(group_entry -> 'parentRouterId') = 'null' THEN
          parent_id := NULL;
        ELSIF jsonb_typeof(group_entry -> 'parentRouterId') = 'string'
              AND (group_entry ->> 'parentRouterId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
          parent_id := group_entry ->> 'parentRouterId';
        ELSE
          RETURN false;
        END IF;
      END IF;
      IF NOT (group_entry ? 'leafNodeIds')
         OR jsonb_typeof(group_entry -> 'leafNodeIds') <> 'array'
         OR jsonb_array_length(group_entry -> 'leafNodeIds') = 0
         OR jsonb_array_length(group_entry -> 'leafNodeIds') > 500 THEN
        RETURN false;
      END IF;
      FOR leaf_entry IN SELECT value FROM jsonb_array_elements(group_entry -> 'leafNodeIds') LOOP
        IF jsonb_typeof(leaf_entry) <> 'string' THEN
          RETURN false;
        END IF;
        leaf_id := leaf_entry #>> '{}';
        IF leaf_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
           OR leaf_id = ANY(seen_leaf_ids) THEN
          RETURN false;
        END IF;
        seen_leaf_ids := array_append(seen_leaf_ids, leaf_id);
      END LOOP;
    END LOOP;
  END IF;

  RETURN true;
END;
$$;

CREATE FUNCTION architecture_pattern_migration_diff_is_safe(p_diff jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_diff IS NOT NULL
    AND jsonb_typeof(p_diff) = 'object'
    AND octet_length(p_diff::text) <= 32768
    AND p_diff::text !~* '(https?://|ftp://|file://|-----BEGIN [A-Z ]+-----|(^|[[:space:] (])/(Users|home|root|private|var|tmp|etc|opt|workspace)([/[:space:] )]|$)|(^|[[:space:]])(bearer|basic)[[:space:]]+[A-Za-z0-9._~+/-]{8,}|(api[_-]?key|authorization|credential|password|private[-_ ]?key|secret|token)[[:space:]]*[:=])';
$$;

CREATE TABLE skill_architecture_pattern_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1,
  mode text NOT NULL DEFAULT 'derive-shell',
  source_architecture_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  source_pattern_id text NOT NULL,
  source_revision_digest text NOT NULL,
  target_architecture_id uuid NOT NULL,
  target_revision_id uuid NOT NULL,
  target_pattern_id text NOT NULL,
  target_revision_digest text NOT NULL,
  mapping_status text NOT NULL,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  migration_digest text NOT NULL,
  diff_digest text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_architecture_pattern_migrations_schema_version_check
    CHECK (schema_version = 1),
  CONSTRAINT skill_architecture_pattern_migrations_mode_check
    CHECK (mode = 'derive-shell'),
  CONSTRAINT skill_architecture_pattern_migrations_source_revision_fk
    FOREIGN KEY (source_architecture_id, source_revision_id)
    REFERENCES skill_architecture_revisions (architecture_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT skill_architecture_pattern_migrations_target_revision_fk
    FOREIGN KEY (target_architecture_id, target_revision_id)
    REFERENCES skill_architecture_revisions (architecture_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT skill_architecture_pattern_migrations_distinct_arch_check
    CHECK (source_architecture_id <> target_architecture_id),
  CONSTRAINT skill_architecture_pattern_migrations_source_pattern_check
    CHECK (source_pattern_id IN ('flat', 'domain-router', 'multi-level-router')),
  CONSTRAINT skill_architecture_pattern_migrations_target_pattern_check
    CHECK (target_pattern_id IN ('flat', 'domain-router', 'multi-level-router')),
  CONSTRAINT skill_architecture_pattern_migrations_mapping_status_check
    CHECK (mapping_status IN ('deterministic', 'fallback', 'provided')),
  CONSTRAINT skill_architecture_pattern_migrations_mapping_check
    CHECK (architecture_pattern_migration_mapping_is_safe(mapping)),
  CONSTRAINT skill_architecture_pattern_migrations_diff_check
    CHECK (architecture_pattern_migration_diff_is_safe(diff)),
  CONSTRAINT skill_architecture_pattern_migrations_source_digest_check
    CHECK (source_revision_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT skill_architecture_pattern_migrations_target_digest_check
    CHECK (target_revision_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT skill_architecture_pattern_migrations_migration_digest_check
    CHECK (migration_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT skill_architecture_pattern_migrations_diff_digest_check
    CHECK (diff_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT skill_architecture_pattern_migrations_idempotency_key_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT skill_architecture_pattern_migrations_actor_idempotency_unique
    UNIQUE (actor_user_id, idempotency_key),
  CONSTRAINT skill_architecture_pattern_migrations_target_arch_unique
    UNIQUE (target_architecture_id),
  CONSTRAINT skill_architecture_pattern_migrations_target_revision_unique
    UNIQUE (target_revision_id)
);

CREATE INDEX skill_architecture_pattern_migrations_source_history_idx
  ON skill_architecture_pattern_migrations (source_architecture_id, source_revision_id, created_at DESC, id DESC);

CREATE INDEX skill_architecture_pattern_migrations_actor_history_idx
  ON skill_architecture_pattern_migrations (actor_user_id, created_at DESC, id DESC);

CREATE FUNCTION prevent_skill_architecture_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'skill architecture revisions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER skill_architecture_revisions_append_only
  BEFORE UPDATE OR DELETE ON skill_architecture_revisions
  FOR EACH ROW EXECUTE FUNCTION prevent_skill_architecture_revision_mutation();

CREATE TRIGGER skill_architecture_revisions_no_truncate
  BEFORE TRUNCATE ON skill_architecture_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_skill_architecture_revision_mutation();

CREATE FUNCTION prevent_skill_architecture_pattern_migration_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'skill architecture pattern migrations are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER skill_architecture_pattern_migrations_append_only
  BEFORE UPDATE OR DELETE ON skill_architecture_pattern_migrations
  FOR EACH ROW EXECUTE FUNCTION prevent_skill_architecture_pattern_migration_mutation();

CREATE TRIGGER skill_architecture_pattern_migrations_no_truncate
  BEFORE TRUNCATE ON skill_architecture_pattern_migrations
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_skill_architecture_pattern_migration_mutation();
