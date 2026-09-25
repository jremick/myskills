-- Match the established application diff reader. Keep the existing safety
-- and size check, and validate every retained row without rewriting lineage.
CREATE FUNCTION architecture_pattern_migration_diff_has_valid_shape(p_diff jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  field text;
  entry jsonb;
  count_value numeric;
BEGIN
  IF p_diff IS NULL OR jsonb_typeof(p_diff) <> 'object'
    OR p_diff - ARRAY['addedEdgeCount', 'addedRouterNodeIds', 'droppedRouterNodeIds',
      'preservedLeafNodeIds', 'preservedSkillRefIds', 'removedEdgeCount', 'rewrittenBindingCount'] <> '{}'::jsonb THEN
    RETURN false;
  END IF;
  FOREACH field IN ARRAY ARRAY['preservedSkillRefIds', 'preservedLeafNodeIds', 'addedRouterNodeIds', 'droppedRouterNodeIds'] LOOP
    IF jsonb_typeof(p_diff->field) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    FOR entry IN SELECT value FROM jsonb_array_elements(p_diff->field) LOOP
      IF jsonb_typeof(entry) <> 'string'
        OR (entry #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['addedEdgeCount', 'removedEdgeCount', 'rewrittenBindingCount'] LOOP
    IF jsonb_typeof(p_diff->field) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    count_value := (p_diff->>field)::numeric;
    IF count_value < 0 OR count_value > 9007199254740991 OR trunc(count_value) <> count_value THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

ALTER TABLE skill_architecture_pattern_migrations
  ADD CONSTRAINT skill_architecture_pattern_migrations_diff_shape_check
  CHECK (architecture_pattern_migration_diff_has_valid_shape(diff)) NOT VALID;

ALTER TABLE skill_architecture_pattern_migrations
  VALIDATE CONSTRAINT skill_architecture_pattern_migrations_diff_shape_check;
