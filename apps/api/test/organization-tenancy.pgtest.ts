import assert from "node:assert/strict";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createDb, createPgPool } from "../src/db/client.js";
import { users } from "../src/db/schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const ownerId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const teamId = "33333333-3333-4333-8333-333333333333";
const skillId = "44444444-4444-4444-8444-444444444444";
const architectureId = "55555555-5555-4555-8555-555555555555";
const organizationOneId = "66666666-6666-4666-8666-666666666666";
const organizationTwoId = "77777777-7777-4777-8777-777777777777";
const policyOneId = "88888888-8888-4888-8888-888888888888";
const policyTwoId = "99999999-9999-4999-8999-999999999999";
const policyThreeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("migration 0017 preserves standalone teams and existing team grants", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "org-migration-owner@example.com");
  await pool.query(
    `INSERT INTO teams (id, name, slug, created_by_user_id)
     VALUES ($1, $2, $3, $4)`,
    [teamId, "Legacy standalone team", "legacy-standalone-team", ownerId],
  );
  await pool.query(
    `INSERT INTO skills (id, slug, title, summary, lifecycle_status, visibility, owner_user_id)
     VALUES ($1, $2, $3, $4, 'private', 'private', $5)`,
    [skillId, "legacy-standalone-skill", "Legacy skill", "Existing team grant.", ownerId],
  );
  await pool.query(
    `INSERT INTO skill_team_grants (skill_id, team_id) VALUES ($1, $2)`,
    [skillId, teamId],
  );

  await applyMigration(pool, "0017_organizations_and_org_sharing");

  const team = (await pool.query(
    "SELECT organization_id FROM teams WHERE id = $1",
    [teamId],
  )).rows[0] as { organization_id: string | null };
  assert.equal(team.organization_id, null);
  assert.deepEqual(
    (await pool.query(
      "SELECT skill_id, team_id FROM skill_team_grants WHERE team_id = $1",
      [teamId],
    )).rows,
    [{ skill_id: skillId, team_id: teamId }],
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('organizations', 'organization_policy_revisions', 'organization_memberships',
                            'organization_invitations', 'skill_organization_grants',
                            'skill_architecture_organization_grants')
       ORDER BY table_name`,
    )).rows.map((row) => row.table_name),
    [
      "organization_invitations",
      "organization_memberships",
      "organization_policy_revisions",
      "organizations",
      "skill_architecture_organization_grants",
      "skill_organization_grants",
    ],
  );
});

test("organization current policy pointers cannot cross organization boundaries", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await applyMigration(pool, "0017_organizations_and_org_sharing");
  await insertUser(pool, ownerId, "org-policy-owner@example.com");
  await insertOrganization(pool, organizationOneId, "Organization One", "organization-one");
  await insertOrganization(pool, organizationTwoId, "Organization Two", "organization-two");
  await insertPolicy(pool, organizationOneId, policyOneId, 1, "a".repeat(64));
  await insertPolicy(pool, organizationTwoId, policyTwoId, 1, "b".repeat(64));

  await pool.query(
    "UPDATE organizations SET current_policy_revision_id = $1, status = 'active' WHERE id = $2",
    [policyOneId, organizationOneId],
  );
  const current = (await pool.query(
    "SELECT current_policy_revision_id, status FROM organizations WHERE id = $1",
    [organizationOneId],
  )).rows[0] as { current_policy_revision_id: string; status: string };
  assert.deepEqual(current, { current_policy_revision_id: policyOneId, status: "active" });

  await assert.rejects(
    pool.query(
      "UPDATE organizations SET current_policy_revision_id = $1 WHERE id = $2",
      [policyTwoId, organizationOneId],
    ),
    (error) => isConstraintError(error, "organizations_current_policy_revision_fk"),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO organizations (id, name, slug, status)
       VALUES ($1, $2, $3, 'active')`,
      ["abababab-abab-4bab-8bab-abababababab", "No policy", "no-policy"],
    ),
    (error) => isConstraintError(error, "organizations_active_requires_policy_check"),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO organization_policy_revisions
         (organization_id, revision_number, schema_version, policy, policy_sha256, created_by_user_id)
       VALUES ($1, 1, 1, $2::jsonb, $3, $4)`,
      ["cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd", JSON.stringify({ schemaVersion: 1 }), "c".repeat(64), ownerId],
    ),
    (error) => isConstraintError(error, "organization_policy_revisions_organization_id_fkey"),
  );

  const fk = (await pool.query(
    `SELECT condeferrable, condeferred
     FROM pg_constraint
     WHERE conname = 'organizations_current_policy_revision_fk'`,
  )).rows[0] as { condeferrable: boolean; condeferred: boolean };
  assert.deepEqual(fk, { condeferrable: true, condeferred: true });
});

test("organization policy and grant constraints reject invalid or cross-org records", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await applyMigration(pool, "0017_organizations_and_org_sharing");
  await insertUser(pool, ownerId, "org-grant-owner@example.com");
  await insertUser(pool, memberId, "org-grant-member@example.com");
  await insertOrganization(pool, organizationOneId, "Grant Organization One", "grant-organization-one");
  await insertOrganization(pool, organizationTwoId, "Grant Organization Two", "grant-organization-two");
  await insertPolicy(pool, organizationOneId, policyOneId, 1, "d".repeat(64));
  await insertPolicy(pool, organizationTwoId, policyTwoId, 1, "e".repeat(64));
  await pool.query(
    `INSERT INTO skills (id, slug, title, summary, lifecycle_status, visibility, owner_user_id)
     VALUES ($1, $2, $3, $4, 'private', 'private', $5)`,
    [skillId, "organization-grant-skill", "Organization grant skill", "Grant constraint fixture.", ownerId],
  );
  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
     VALUES ($1, $2, $3, $4, 'flat')`,
    [architectureId, ownerId, "Organization grant architecture", "Grant constraint fixture."],
  );

  await assert.rejects(
    insertPolicy(pool, organizationOneId, "abababab-abab-4bab-8bab-abababababab", 2, "d".repeat(64), { schemaVersion: 2 }),
    (error) => isConstraintError(error, "organization_policy_revisions_policy_check"),
  );
  await assert.rejects(
    insertPolicy(pool, organizationOneId, "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc", 2, "not-a-digest"),
    (error) => isConstraintError(error, "organization_policy_revisions_policy_sha256_check"),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO skill_organization_grants
         (skill_id, organization_id, created_by_user_id, created_under_policy_revision_id)
       VALUES ($1, $2, $3, $4)`,
      [skillId, organizationOneId, ownerId, policyTwoId],
    ),
    (error) => isConstraintError(error, "skill_organization_grants_policy_revision_fk"),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO skill_architecture_organization_grants
         (architecture_id, organization_id, access_level, created_by_user_id, created_under_policy_revision_id)
       VALUES ($1, $2, 'write', $3, $4)`,
      [architectureId, organizationOneId, ownerId, policyOneId],
    ),
    (error) => isConstraintError(error, "skill_architecture_organization_grants_access_level_check"),
  );

  await pool.query(
    `INSERT INTO skill_organization_grants
       (skill_id, organization_id, created_by_user_id, created_under_policy_revision_id)
     VALUES ($1, $2, $3, $4)`,
    [skillId, organizationOneId, ownerId, policyOneId],
  );
  await pool.query(
    `INSERT INTO skill_architecture_organization_grants
       (architecture_id, organization_id, access_level, created_by_user_id, created_under_policy_revision_id)
     VALUES ($1, $2, 'read', $3, $4)`,
    [architectureId, organizationOneId, ownerId, policyOneId],
  );

  await insertPolicy(pool, organizationOneId, policyThreeId, 2, "f".repeat(64));
  await assert.rejects(
    pool.query(
      "UPDATE organization_policy_revisions SET reason = $1 WHERE id = $2",
      ["mutated", policyThreeId],
    ),
    (error) => isImmutablePolicyError(error),
  );
  await assert.rejects(
    pool.query("DELETE FROM organization_policy_revisions WHERE id = $1", [policyThreeId]),
    (error) => isImmutablePolicyError(error),
  );

  await pool.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role)
     VALUES ($1, $2, 'member')`,
    [organizationOneId, memberId],
  );
  await pool.query(
    `UPDATE organization_memberships SET removed_at = now()
     WHERE organization_id = $1 AND user_id = $2`,
    [organizationOneId, memberId],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [organizationOneId, memberId],
    ),
    (error) => isUniqueViolation(error),
  );

  await pool.query(
    `INSERT INTO organization_invitations (organization_id, email, normalized_email)
     VALUES ($1, $2, $3)`,
    [organizationOneId, "invite@example.com", "invite@example.com"],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO organization_invitations (organization_id, email, normalized_email)
       VALUES ($1, $2, $3)`,
      [organizationOneId, "invite@example.com", "invite@example.com"],
    ),
    (error) => isUniqueViolation(error),
  );
  await pool.query(
    `UPDATE organization_invitations SET status = 'revoked'
     WHERE organization_id = $1 AND normalized_email = $2`,
    [organizationOneId, "invite@example.com"],
  );
  await pool.query(
    `INSERT INTO organization_invitations (organization_id, email, normalized_email)
     VALUES ($1, $2, $3)`,
    [organizationOneId, "invite@example.com", "invite@example.com"],
  );
});

async function freshPool(t: TestContext) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for organization migration tests.");
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await applyMigrationsThrough(pool, "0016_architecture_owner_tenancy");
  return pool;
}

async function applyMigrationsThrough(pool: ReturnType<typeof createPgPool>, lastMigration: string): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    await applyMigration(pool, id);
    if (id === lastMigration) return;
  }
  throw new Error(`Migration ${lastMigration} was not found.`);
}

async function applyMigration(pool: ReturnType<typeof createPgPool>, id: string): Promise<void> {
  const contents = readFileSync(join(migrationsDir, `${id}.sql`), "utf8");
  await pool.query("BEGIN");
  try {
    await pool.query(contents);
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function insertUser(
  pool: ReturnType<typeof createPgPool>,
  id: string,
  email: string,
): Promise<void> {
  const db = createDb(pool);
  await db.insert(users).values({
    id,
    email,
    normalizedEmail: email.toLowerCase(),
    name: email.split("@")[0] ?? "",
    status: "active",
    emailVerifiedAt: new Date(),
  });
}

async function insertOrganization(
  pool: ReturnType<typeof createPgPool>,
  id: string,
  name: string,
  slug: string,
): Promise<void> {
  await pool.query(
    "INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $3, $4)",
    [id, name, slug, ownerId],
  );
}

async function insertPolicy(
  pool: ReturnType<typeof createPgPool>,
  organizationId: string,
  id: string,
  revisionNumber: number,
  digest: string,
  policy: { schemaVersion: number } = { schemaVersion: 1 },
): Promise<void> {
  await pool.query(
    `INSERT INTO organization_policy_revisions
       (id, organization_id, revision_number, schema_version, policy, policy_sha256, reason, created_by_user_id)
     VALUES ($1, $2, $3, 1, $4::jsonb, $5, '', $6)`,
    [id, organizationId, revisionNumber, JSON.stringify(policy), digest, ownerId],
  );
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "TEST_DATABASE_URL must target a disposable database whose name includes test or ci.");
}

function isConstraintError(error: unknown, constraint: string): boolean {
  return (typeof error === "object" && error !== null && "constraint" in error && error.constraint === constraint)
    || (error instanceof Error && error.message.includes(constraint));
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function isImmutablePolicyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "55000";
}
