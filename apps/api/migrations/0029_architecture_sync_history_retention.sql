-- Runs and steps retain the journal that existing immutable receipts,
-- baselines, recovery evidence, and lease fencing history describe. State
-- updates continue through the existing integrity triggers; history cannot
-- be removed through direct deletion, cascades, or truncation.
CREATE FUNCTION prevent_skill_architecture_sync_history_removal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'skill architecture sync runs and steps are retained history'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER skill_architecture_sync_runs_no_delete
  BEFORE DELETE ON skill_architecture_sync_runs
  FOR EACH ROW EXECUTE FUNCTION prevent_skill_architecture_sync_history_removal();

CREATE TRIGGER skill_architecture_sync_runs_no_truncate
  BEFORE TRUNCATE ON skill_architecture_sync_runs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_skill_architecture_sync_history_removal();

CREATE TRIGGER skill_architecture_sync_steps_no_delete
  BEFORE DELETE ON skill_architecture_sync_steps
  FOR EACH ROW EXECUTE FUNCTION prevent_skill_architecture_sync_history_removal();

CREATE TRIGGER skill_architecture_sync_steps_no_truncate
  BEFORE TRUNCATE ON skill_architecture_sync_steps
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_skill_architecture_sync_history_removal();
