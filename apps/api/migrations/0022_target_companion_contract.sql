ALTER TABLE skill_architecture_targets
  DROP CONSTRAINT skill_architecture_targets_adapter_contract_version_check,
  DROP CONSTRAINT skill_architecture_targets_capabilities_mutation_disabled_check;

ALTER TABLE skill_architecture_targets
  ADD CONSTRAINT skill_architecture_targets_adapter_contract_version_check
    CHECK (adapter_contract_version IN (1, 2)),
  ADD CONSTRAINT skill_architecture_targets_capabilities_mutation_disabled_check
    CHECK (
      (
        adapter_contract_version = 1
        AND (NOT capabilities ? 'apply' OR capabilities -> 'apply' = 'false'::jsonb)
        AND (NOT capabilities ? 'rollback' OR capabilities -> 'rollback' = 'false'::jsonb)
        AND (NOT capabilities ? 'sync.write' OR capabilities -> 'sync.write' = 'false'::jsonb)
      )
      OR (
        adapter_contract_version = 2
        AND (
          (
            COALESCE((capabilities ->> 'apply')::boolean, false) = false
            AND COALESCE((capabilities ->> 'rollback')::boolean, false) = false
          )
          OR capabilities -> 'sync.write' = 'true'::jsonb
        )
      )
    );

ALTER TABLE skill_architecture_observations
  DROP CONSTRAINT skill_architecture_observations_adapter_contract_version_check;

ALTER TABLE skill_architecture_observations
  ADD CONSTRAINT skill_architecture_observations_adapter_contract_version_check
    CHECK (adapter_contract_version IN (1, 2));
