import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createFlatArchitecture,
  defaultOrganizationPolicyV1,
  type OrganizationPolicyV1,
} from "@myskills-app/core";
import { PostgresArchitectureStore } from "../src/architectures/postgres-store.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { users } from "../src/db/schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const ownerId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const teamMemberId = "33333333-3333-4333-8333-333333333333";
const teamId = "44444444-4444-4444-8444-444444444444";
const architectureId = "55555555-5555-4555-8555-555555555555";
const teamArchitectureId = "66666666-6666-4666-8666-666666666666";
const organizationOneId = "77777777-7777-4777-8777-777777777777";
const organizationTwoId = "88888888-8888-4888-8888-888888888888";
const policyOneId = "99999999-9999-4999-8999-999999999999";
const policyTwoId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const policyDisabledId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const revisionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const privateArchitectureId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const privateRevisionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const organizationReferenceArchitectureId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const organizationReferenceRevisionId = "12121212-1212-4121-8121-121212121212";

test("postgres organization architecture grants enforce current contexts and immediate revocation", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const store = new PostgresArchitectureStore(db);

  await insertUser(db, ownerId, "architecture-org-owner@example.com");
  await insertUser(db, memberId, "architecture-org-member@example.com");
  await insertUser(db, teamMemberId, "architecture-org-team-member@example.com");
  await insertOrganization(pool, organizationOneId, "Organization One", "architecture-org-one");
  await insertOrganization(pool, organizationTwoId, "Organization Two", "architecture-org-two");
  await insertPolicy(pool, organizationOneId, policyOneId, 1, "a".repeat(64));
  await insertPolicy(pool, organizationTwoId, policyTwoId, 1, "b".repeat(64));
  await activateOrganization(pool, organizationOneId, policyOneId);
  await activateOrganization(pool, organizationTwoId, policyTwoId);
  await setOrganizationVisibility(pool, true);

  await pool.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role)
     VALUES ($1, $2, 'member'), ($3, $2, 'admin')`,
    [organizationOneId, memberId, organizationTwoId],
  );
  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
     VALUES ($1, $2, $3, $4, 'flat')`,
    [architectureId, ownerId, "Organization-granted architecture", "Current organization access."],
  );
  await insertArchitectureRevision(pool, architectureId, revisionId, createFlatArchitecture({
    id: architectureId,
    name: "Organization-granted architecture",
    skills: [{
      id: "public-skill",
      slug: "public-skill",
      version: "1.0.0",
      digest: "f".repeat(64),
      packageVisibility: "public",
    }],
  }));
  // Insert grants in reverse order. The store/evaluator must expose a stable
  // organization ordering rather than the database insertion order.
  await insertGrant(pool, architectureId, organizationTwoId, policyTwoId);
  await insertGrant(pool, architectureId, organizationOneId, policyOneId);

  const visible = await store.getArchitecture(memberId, architectureId);
  assert.ok(visible);
  assert.deepEqual(visible.access.allowedOrganizationIds, [organizationOneId, organizationTwoId]);
  assert.deepEqual(visible.access.reasons, ["organization"]);
  assert.equal(visible.access.canRead, true);
  assert.equal(visible.access.canPreview, true);
  assert.equal(visible.access.canCreate, false);
  assert.equal(visible.access.canAppend, false);
  assert.equal(visible.access.canManage, false);
  const listed = await store.listArchitectures(memberId);
  assert.equal(listed.some((row) => row.id === architectureId), true);
  // Both organizations grant the same architecture. The summary count must
  // count immutable revisions, not rows introduced by the grant join.
  assert.equal(listed.find((row) => row.id === architectureId)?.revisionCount, 1);
  assert.equal((await store.listRevisions(memberId, architectureId))?.length, 1);
  // The list path is used for summaries; raw latest/specific revision reads
  // remain unavailable to organization readers.
  assert.equal(await store.getRevision(memberId, architectureId, revisionId), null);
  assert.equal(
    (await store.getRevisionForPreview(memberId, architectureId, revisionId, organizationOneId))?.id,
    revisionId,
  );
  assert.equal(
    (await store.getRevisionForPreview(memberId, architectureId, revisionId, organizationTwoId))?.id,
    revisionId,
  );
  assert.equal(await store.getRevisionForPreview(memberId, architectureId, revisionId), null);
  assert.equal(await store.getRevisionForPreview(memberId, architectureId, revisionId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"), null);

  const owner = await store.getArchitecture(ownerId, architectureId);
  assert.ok(owner);
  assert.equal(owner.access.canAppend, true);
  assert.deepEqual(owner.access.allowedOrganizationIds, []);

  const tokenActor = await store.getArchitecture({ id: memberId, roles: ["owner"] }, architectureId);
  assert.deepEqual(tokenActor?.access, visible.access);
  const revision = await store.createRevision(memberId, {
    architectureId,
    expectedCurrentRevisionId: null,
    message: "Organization grants cannot append.",
    spec: createFlatArchitecture({
      id: architectureId,
      name: "Organization-granted architecture",
      skills: [{ id: "unresolved-skill", slug: "unresolved-skill", version: "1.0.0", digest: "e".repeat(64) }],
    }),
  });
  assert.equal(revision, null);

  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
     VALUES ($1, $2, $3, $4, 'flat')`,
    [privateArchitectureId, ownerId, "Private-reference architecture", "Organization access must fail closed."],
  );
  const privateSpec = createFlatArchitecture({
    id: privateArchitectureId,
    name: "Private-reference architecture",
    skills: [{
      id: "private-skill",
      slug: "private-skill",
      version: "1.0.0",
      digest: "0".repeat(64),
      packageVisibility: "private",
    }],
  });
  await insertArchitectureRevision(pool, privateArchitectureId, privateRevisionId, privateSpec);
  await insertGrant(pool, privateArchitectureId, organizationOneId, policyOneId);
  assert.equal(await store.getArchitecture(memberId, privateArchitectureId), null);
  assert.equal(await store.getRevision(memberId, privateArchitectureId, privateRevisionId), null);
  assert.equal(
    await store.getRevisionForPreview(memberId, privateArchitectureId, privateRevisionId, organizationOneId),
    null,
  );

  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
     VALUES ($1, $2, $3, $4, 'flat')`,
    [organizationReferenceArchitectureId, ownerId, "Organization-reference architecture", "Preview resolves organization references separately."],
  );
  await insertArchitectureRevision(pool, organizationReferenceArchitectureId, organizationReferenceRevisionId, createFlatArchitecture({
    id: organizationReferenceArchitectureId,
    name: "Organization-reference architecture",
    skills: [{
      id: "organization-skill",
      slug: "organization-skill",
      version: "1.0.0",
      digest: "1".repeat(64),
      packageVisibility: "organization",
    }],
  }));
  await insertGrant(pool, organizationReferenceArchitectureId, organizationOneId, policyOneId);
  assert.ok(await store.getArchitecture(memberId, organizationReferenceArchitectureId));
  assert.equal(await store.getRevision(memberId, organizationReferenceArchitectureId, organizationReferenceRevisionId), null);

  await pool.query(
    `UPDATE organization_memberships SET removed_at = now()
     WHERE organization_id = $1 AND user_id = $2`,
    [organizationTwoId, memberId],
  );
  assert.deepEqual((await store.getArchitecture(memberId, architectureId))?.access.allowedOrganizationIds, [organizationOneId]);

  const disabledPolicy: OrganizationPolicyV1 = {
    ...defaultOrganizationPolicyV1,
    sharing: {
      ...defaultOrganizationPolicyV1.sharing,
      organizationArchitectureSharingEnabled: false,
    },
  };
  await insertPolicy(pool, organizationOneId, policyDisabledId, 2, "c".repeat(64), disabledPolicy);
  await activateOrganization(pool, organizationOneId, policyDisabledId);
  assert.equal(await store.getArchitecture(memberId, architectureId), null);

  await activateOrganization(pool, organizationOneId, policyOneId);
  await pool.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [organizationOneId]);
  assert.equal(await store.getArchitecture(memberId, architectureId), null);

  await pool.query("UPDATE organizations SET status = 'active' WHERE id = $1", [organizationOneId]);
  await pool.query(
    "DELETE FROM skill_architecture_organization_grants WHERE architecture_id = $1 AND organization_id = $2",
    [architectureId, organizationOneId],
  );
  assert.equal(await store.getArchitecture(memberId, architectureId), null);

  await insertGrant(pool, architectureId, organizationOneId, policyOneId);
  await setOrganizationVisibility(pool, false);
  assert.equal(await store.getArchitecture(memberId, architectureId), null);

  await setOrganizationVisibility(pool, true);
  await pool.query("DELETE FROM instance_settings WHERE key = 'sharing'");
  assert.equal(await store.getArchitecture(memberId, architectureId), null);
});

test("postgres architecture grants are invalidated when an organization rotates policy", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const store = new PostgresArchitectureStore(db);

  await insertUser(db, ownerId, "architecture-rotate-owner@example.com");
  await insertUser(db, memberId, "architecture-rotate-member@example.com");
  await insertOrganization(pool, organizationOneId, "Rotating Organization", "architecture-rotating-org");
  await insertPolicy(pool, organizationOneId, policyOneId, 1, "a".repeat(64));
  await activateOrganization(pool, organizationOneId, policyOneId);
  await pool.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role)
     VALUES ($1, $2, 'member')`,
    [organizationOneId, memberId],
  );
  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
     VALUES ($1, $2, $3, $4, 'flat')`,
    [architectureId, ownerId, "Rotating architecture", "Grant invalidation."],
  );
  await insertArchitectureRevision(pool, architectureId, revisionId, createFlatArchitecture({
    id: architectureId,
    name: "Rotating architecture",
    skills: [{
      id: "public-skill",
      slug: "public-skill",
      version: "1.0.0",
      digest: "a".repeat(64),
      packageVisibility: "public",
    }],
  }));
  await insertGrant(pool, architectureId, organizationOneId, policyOneId);
  await setOrganizationVisibility(pool, true);

  assert.equal((await store.getArchitecture(memberId, architectureId))?.access.canRead, true);

  await insertPolicy(pool, organizationOneId, policyTwoId, 2, "b".repeat(64));
  await activateOrganization(pool, organizationOneId, policyTwoId);
  assert.equal(await store.getArchitecture(memberId, architectureId), null);
});

test("postgres team membership and team parentage do not substitute for organization membership", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const store = new PostgresArchitectureStore(db);

  await insertUser(db, ownerId, "architecture-team-owner@example.com");
  await insertUser(db, teamMemberId, "architecture-team-member@example.com");
  await insertOrganization(pool, organizationOneId, "Parent Organization", "architecture-parent-org");
  await insertPolicy(pool, organizationOneId, policyOneId, 1, "d".repeat(64));
  await activateOrganization(pool, organizationOneId, policyOneId);
  await setOrganizationVisibility(pool, true);
  await pool.query(
    `INSERT INTO teams (id, name, slug, created_by_user_id, organization_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [teamId, "Parent team", "architecture-parent-team", ownerId, organizationOneId],
  );
  await pool.query(
    `INSERT INTO team_memberships (team_id, user_id, role)
     VALUES ($1, $2, 'member')`,
    [teamId, teamMemberId],
  );
  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
     VALUES ($1, $2, $3, $4, 'flat')`,
    [architectureId, ownerId, "User-owned architecture", "Team parentage must not grant organization access."],
  );
  await insertGrant(pool, architectureId, organizationOneId, policyOneId);

  const teamParentActor = { id: teamMemberId, roles: ["owner"], teamIds: [teamId] };
  assert.equal(await store.getArchitecture(teamParentActor, architectureId), null);

  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, owner_team_id, name, description, pattern_id)
    VALUES ($1, NULL, $2, $3, $4, 'flat')`,
    [teamArchitectureId, teamId, "Team-owned architecture", "Team access remains compatible."],
  );
  // A raw team_memberships row is not effective while the parent organization
  // membership is absent. This revokes every team capability, not only org
  // grants.
  assert.equal(await store.getArchitecture(teamParentActor, teamArchitectureId), null);
  await pool.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role)
     VALUES ($1, $2, 'member')`,
    [organizationOneId, teamMemberId],
  );
  const teamVisible = await store.getArchitecture(teamParentActor, teamArchitectureId);
  assert.ok(teamVisible);
  assert.equal(teamVisible.access.canRead, true);
  assert.equal(teamVisible.access.canAppend, false);
  await pool.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [organizationOneId]);
  assert.equal(await store.getArchitecture(teamParentActor, teamArchitectureId), null);
});

test("postgres preview revisions require one exact current organization context", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const store = new PostgresArchitectureStore(db);

  await insertUser(db, ownerId, "architecture-preview-owner@example.com");
  await insertUser(db, memberId, "architecture-preview-member@example.com");
  await insertOrganization(pool, organizationOneId, "Preview Organization One", "architecture-preview-one");
  await insertOrganization(pool, organizationTwoId, "Preview Organization Two", "architecture-preview-two");
  await insertPolicy(pool, organizationOneId, policyOneId, 1, "e".repeat(64));
  await insertPolicy(pool, organizationTwoId, policyTwoId, 1, "f".repeat(64));
  await activateOrganization(pool, organizationOneId, policyOneId);
  await activateOrganization(pool, organizationTwoId, policyTwoId);
  await insertPolicy(pool, organizationTwoId, policyDisabledId, 2, "0".repeat(64), {
    ...defaultOrganizationPolicyV1,
    sharing: {
      ...defaultOrganizationPolicyV1.sharing,
      organizationArchitectureSharingEnabled: false,
    },
  });
  await activateOrganization(pool, organizationTwoId, policyDisabledId);
  await setOrganizationVisibility(pool, true);
  await pool.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role)
     VALUES ($1, $2, 'member'), ($3, $2, 'member')`,
    [organizationOneId, memberId, organizationTwoId],
  );
  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
     VALUES ($1, $2, $3, $4, 'flat')`,
    [organizationReferenceArchitectureId, ownerId, "Single-context preview architecture", "The selected organization is explicit."],
  );
  await insertArchitectureRevision(pool, organizationReferenceArchitectureId, organizationReferenceRevisionId, createFlatArchitecture({
    id: organizationReferenceArchitectureId,
    name: "Single-context preview architecture",
    skills: [{
      id: "organization-skill",
      slug: "organization-skill",
      version: "1.0.0",
      digest: "1".repeat(64),
      packageVisibility: "organization",
    }],
  }));
  await insertGrant(pool, organizationReferenceArchitectureId, organizationOneId, policyOneId);
  await insertGrant(pool, organizationReferenceArchitectureId, organizationTwoId, policyTwoId);

  const visible = await store.getArchitecture(memberId, organizationReferenceArchitectureId);
  assert.deepEqual(visible?.access.allowedOrganizationIds, [organizationOneId]);
  assert.equal(
    (await store.getRevisionForPreview(
      memberId,
      organizationReferenceArchitectureId,
      organizationReferenceRevisionId,
      organizationOneId,
    ))?.id,
    organizationReferenceRevisionId,
  );
  assert.equal(
    await store.getRevisionForPreview(
      memberId,
      organizationReferenceArchitectureId,
      organizationReferenceRevisionId,
      organizationTwoId,
    ),
    null,
  );
  assert.equal(
    await store.getRevisionForPreview(memberId, organizationReferenceArchitectureId, organizationReferenceRevisionId),
    null,
  );
  assert.equal(
    await store.getRevisionForPreview(
      memberId,
      organizationReferenceArchitectureId,
      organizationReferenceRevisionId,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
    ),
    null,
  );
  assert.equal(await store.getRevision(memberId, organizationReferenceArchitectureId, organizationReferenceRevisionId), null);
  assert.equal(
    (await store.getRevisionForPreview(ownerId, organizationReferenceArchitectureId, organizationReferenceRevisionId))?.id,
    organizationReferenceRevisionId,
  );
});

async function freshPool(t: TestContext): Promise<ReturnType<typeof createPgPool>> {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for Postgres architecture organization access tests.");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "TEST_DATABASE_URL must target a disposable database whose name includes test or ci.");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await applyMigrationsThrough(pool, "0017_organizations_and_org_sharing");
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

async function insertUser(db: ReturnType<typeof createDb>, id: string, email: string): Promise<void> {
  await db.insert(users).values({
    id,
    email,
    normalizedEmail: email,
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
  policy: OrganizationPolicyV1 = defaultOrganizationPolicyV1,
): Promise<void> {
  await pool.query(
    `INSERT INTO organization_policy_revisions
       (id, organization_id, revision_number, schema_version, policy, policy_sha256, reason, created_by_user_id)
     VALUES ($1, $2, $3, 1, $4::jsonb, $5, '', $6)`,
    [id, organizationId, revisionNumber, JSON.stringify(policy), digest, ownerId],
  );
}

async function activateOrganization(
  pool: ReturnType<typeof createPgPool>,
  organizationId: string,
  policyRevisionId: string,
): Promise<void> {
  await pool.query(
    "UPDATE organizations SET current_policy_revision_id = $1, status = 'active' WHERE id = $2",
    [policyRevisionId, organizationId],
  );
}

async function insertGrant(
  pool: ReturnType<typeof createPgPool>,
  architectureId: string,
  organizationId: string,
  policyRevisionId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architecture_organization_grants
       (architecture_id, organization_id, access_level, created_by_user_id, created_under_policy_revision_id)
     VALUES ($1, $2, 'read', $3, $4)`,
    [architectureId, organizationId, ownerId, policyRevisionId],
  );
}

async function insertArchitectureRevision(
  pool: ReturnType<typeof createPgPool>,
  architectureId: string,
  id: string,
  spec: ReturnType<typeof createFlatArchitecture>,
): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architecture_revisions
       (id, architecture_id, revision_number, message, spec, created_by_user_id)
     VALUES ($1, $2, 1, '', $3::jsonb, $4)`,
    [id, architectureId, JSON.stringify(spec), ownerId],
  );
  await pool.query(
    "UPDATE skill_architectures SET current_revision_id = $1 WHERE id = $2",
    [id, architectureId],
  );
}

async function setOrganizationVisibility(
  pool: ReturnType<typeof createPgPool>,
  enabled: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO instance_settings (key, value)
     VALUES ('sharing', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ organizationVisibilityEnabled: enabled })],
  );
}
