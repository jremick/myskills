-- Identity belongs to the registry, not its hostname or current deployment.
-- Preserve this setting when restoring the same registry from a backup.
INSERT INTO instance_settings (key, value)
VALUES ('instance_id', to_jsonb(gen_random_uuid()::text))
ON CONFLICT (key) DO NOTHING;
