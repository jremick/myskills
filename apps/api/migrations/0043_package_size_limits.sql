-- Raise retained draft text to the same 5 MiB budget as package intake.
ALTER TABLE author_draft_revisions
  DROP CONSTRAINT author_draft_revisions_text_bytes_check,
  ADD CONSTRAINT author_draft_revisions_text_bytes_check
    CHECK (text_bytes BETWEEN 0 AND 5242880);

-- JSON can expand text sixfold and images add base64 overhead.
ALTER TABLE target_skill_operations
  DROP CONSTRAINT target_skill_operations_artifact_check,
  ADD CONSTRAINT target_skill_operations_artifact_check
    CHECK (artifact_byte_size BETWEEN 1 AND 41943040
      AND length(artifact_content_type) BETWEEN 1 AND 120
      AND artifact_content_type !~ '[[:cntrl:]]');
