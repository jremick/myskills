ALTER TABLE users ADD COLUMN normalized_email text;
UPDATE users SET normalized_email = lower(trim(email));
ALTER TABLE users ALTER COLUMN normalized_email SET NOT NULL;
CREATE UNIQUE INDEX users_normalized_email_unique ON users (normalized_email);

ALTER TABLE role_assignments DROP CONSTRAINT IF EXISTS role_assignments_user_id_role_scope_type_scope_id_key;
UPDATE role_assignments SET scope_id = '00000000-0000-0000-0000-000000000000'::uuid WHERE scope_id IS NULL;
ALTER TABLE role_assignments ALTER COLUMN scope_id SET DEFAULT '00000000-0000-0000-0000-000000000000'::uuid;
ALTER TABLE role_assignments ALTER COLUMN scope_id SET NOT NULL;
ALTER TABLE role_assignments ADD CONSTRAINT role_assignments_user_role_scope_unique UNIQUE (user_id, role, scope_type, scope_id);
