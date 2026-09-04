ALTER TABLE skill_versions
  ADD COLUMN change_kind text NOT NULL DEFAULT 'maintenance',
  ADD COLUMN requires_user_action boolean NOT NULL DEFAULT false,
  ADD COLUMN compatibility jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE skill_versions
  ADD CONSTRAINT skill_versions_release_notes_check
    CHECK (
      length(release_notes) <= 20000
      AND translate(release_notes, E'\n\r\t', '') !~ '[[:cntrl:]]'
    ),
  ADD CONSTRAINT skill_versions_change_kind_check
    CHECK (change_kind IN ('fix', 'feature', 'breaking', 'security', 'maintenance')),
  ADD CONSTRAINT skill_versions_compatibility_check
    CHECK (
      jsonb_typeof(compatibility) = 'object'
      AND compatibility - ARRAY[
        'minimumMyskillsVersion',
        'minimumAdapterContractVersion',
        'minimumSourceVersion'
      ]::text[] = '{}'::jsonb
      AND (
        NOT compatibility ? 'minimumMyskillsVersion'
        OR (
          jsonb_typeof(compatibility -> 'minimumMyskillsVersion') = 'string'
          AND compatibility ->> 'minimumMyskillsVersion' ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
        )
      )
      AND (
        NOT compatibility ? 'minimumSourceVersion'
        OR (
          jsonb_typeof(compatibility -> 'minimumSourceVersion') = 'string'
          AND compatibility ->> 'minimumSourceVersion' ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
        )
      )
      AND (
        NOT compatibility ? 'minimumAdapterContractVersion'
        OR (
          jsonb_typeof(compatibility -> 'minimumAdapterContractVersion') = 'number'
          AND (compatibility ->> 'minimumAdapterContractVersion') ~ '^[0-9]+$'
          AND (compatibility ->> 'minimumAdapterContractVersion')::integer BETWEEN 1 AND 1000
        )
      )
    );
