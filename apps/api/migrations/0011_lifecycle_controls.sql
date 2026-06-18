ALTER TYPE skill_lifecycle_status ADD VALUE IF NOT EXISTS 'unpublished';

ALTER TABLE skill_versions
  ADD COLUMN IF NOT EXISTS lifecycle_status skill_lifecycle_status NOT NULL DEFAULT 'submitted',
  ADD COLUMN IF NOT EXISTS lifecycle_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS lifecycle_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

UPDATE skill_versions
SET
  lifecycle_status = CASE
    WHEN published_at IS NOT NULL THEN 'approved'::skill_lifecycle_status
    WHEN review_status = 'approved' THEN 'review'::skill_lifecycle_status
    ELSE 'submitted'::skill_lifecycle_status
  END,
  lifecycle_updated_at = COALESCE(published_at, created_at)
WHERE lifecycle_updated_at IS NULL;

CREATE INDEX IF NOT EXISTS skill_versions_lifecycle_idx ON skill_versions (lifecycle_status);
