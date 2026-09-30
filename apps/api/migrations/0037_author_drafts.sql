-- Personal workspaces retain every explicit save. Registry artifacts stay immutable.
CREATE TABLE author_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision BETWEEN 1 AND 100),
  source jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source IS NULL OR jsonb_typeof(source) = 'object')
);
CREATE INDEX author_drafts_owner_updated ON author_drafts(owner_user_id, updated_at DESC, id);

CREATE TABLE author_draft_revisions (
  draft_id uuid NOT NULL REFERENCES author_drafts(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 100),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  files jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  file_count integer NOT NULL CHECK (file_count BETWEEN 0 AND 500),
  text_bytes integer NOT NULL CHECK (text_bytes BETWEEN 0 AND 1048576),
  package_digest text NOT NULL CHECK (package_digest ~ '^[a-f0-9]{64}$'),
  submission_id uuid REFERENCES skill_versions(id) ON DELETE RESTRICT,
  submission_slug text,
  submission_version text,
  submission_artifact_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, revision),
  UNIQUE (submission_id),
  CHECK ((submission_id IS NULL AND submission_slug IS NULL AND submission_version IS NULL AND submission_artifact_sha256 IS NULL)
    OR (submission_id IS NOT NULL AND submission_slug IS NOT NULL AND submission_version IS NOT NULL AND submission_artifact_sha256 ~ '^[a-f0-9]{64}$'))
);

-- Only the first atomic registry binding may update a snapshot. Saved text never changes.
CREATE FUNCTION protect_author_draft_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Saved draft revisions cannot be deleted'; END IF;
  IF (NEW.draft_id, NEW.revision, NEW.title, NEW.files, NEW.file_count, NEW.text_bytes, NEW.package_digest, NEW.created_at)
    IS DISTINCT FROM
    (OLD.draft_id, OLD.revision, OLD.title, OLD.files, OLD.file_count, OLD.text_bytes, OLD.package_digest, OLD.created_at)
    OR OLD.submission_id IS NOT NULL OR NEW.submission_id IS NULL THEN
    RAISE EXCEPTION 'Saved draft revisions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_author_draft_revision BEFORE UPDATE OR DELETE ON author_draft_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_author_draft_revision();
