import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { eq } from "drizzle-orm";
import {
  defaultOrganizationPolicyV1,
  organizationPolicyDigest,
  type OrganizationPolicyV1,
  type SharingSettings,
} from "@myskills-app/core";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  organizationMemberships,
  organizationPolicyRevisions,
  organizations,
  skillArtifacts,
  skillOrganizationGrants,
  skillTeamGrants,
  skillVersions,
  skills,
  teamMemberships,
  teams,
  users,
} from "../src/db/schema.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const outsiderId = "33333333-3333-4333-8333-333333333333";
const organizationOneId = "44444444-4444-4444-8444-444444444444";
const organizationTwoId = "55555555-5555-4555-8555-555555555555";
const policyOneId = "66666666-6666-4666-8666-666666666666";
const policyTwoId = "77777777-7777-4777-8777-777777777777";
const policyThreeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const skillId = "88888888-8888-4888-8888-888888888888";
const skillVersionId = "99999999-9999-4999-8999-999999999999";
const hiddenTeamId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sharingEnabled: SharingSettings = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
  organizationVisibilityEnabled: true,
};

test("Postgres organization skill sharing enforces membership, policy, and exact org scope", {
  timeout: 60_000,
}, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const repository = new PostgresSkillRepository(db);
  await insertUser(db, ownerId, "skill-owner@example.com");
  await insertUser(db, memberId, "organization-member@example.com");
  await insertUser(db, outsiderId, "organization-outsider@example.com");
  await insertOrganization(db, organizationOneId, "Organization One", "organization-one", policyOneId);
  await insertOrganization(db, organizationTwoId, "Organization Two", "organization-two", policyTwoId);
  await db.insert(organizationMemberships).values([
    { organizationId: organizationOneId, userId: ownerId, role: "owner" },
    { organizationId: organizationOneId, userId: memberId, role: "member" },
  ]);
  await insertReleasedSkill(db);
  await repository.updateSharingSettings({ id: ownerId, roles: ["owner"] }, sharingEnabled);

  const updated = await repository.updateSkillSharing({
    actor: { id: ownerId, roles: ["author"] },
    slug: "organization-shared-skill",
    visibility: "organization",
    teamIds: [],
    userEmails: [],
    organizationIds: [organizationOneId],
  });
  assert.deepEqual(updated.organizationGrants?.map((organization) => organization.id), [organizationOneId]);
  assert.equal(updated.settings.organizationVisibilityEnabled, true);
  assert.equal((await repository.getVisibleSkillBySlug("organization-shared-skill", memberId))?.slug, "organization-shared-skill");
  assert.deepEqual(
    (await repository.getVisibleSkillBySlug("organization-shared-skill", memberId))?.access?.reasons,
    ["organization"],
  );
  assert.equal(await repository.getVisibleSkillBySlug("organization-shared-skill", outsiderId), null);
  assert.equal(await repository.getVisibleSkillBySlug("organization-shared-skill", outsiderId), null);
  assert.equal((await repository.getSkillVisibleToOrganizationBySlug("organization-shared-skill", organizationOneId))?.slug, "organization-shared-skill");
  assert.equal(await repository.getSkillVisibleToOrganizationBySlug("organization-shared-skill", organizationTwoId), null);

  const grant = (await db.select({ organizationId: skillOrganizationGrants.organizationId, policyId: skillOrganizationGrants.createdUnderPolicyRevisionId })
    .from(skillOrganizationGrants)
    .where(eq(skillOrganizationGrants.skillId, skillId)))[0];
  assert.deepEqual(grant, { organizationId: organizationOneId, policyId: policyOneId });

  await db.insert(organizationPolicyRevisions).values({
    id: policyThreeId,
    organizationId: organizationOneId,
    revisionNumber: 2,
    schemaVersion: 1,
    policy: defaultOrganizationPolicyV1,
    policySha256: organizationPolicyDigest(defaultOrganizationPolicyV1),
    createdByUserId: ownerId,
  });
  await db.update(organizations)
    .set({ currentPolicyRevisionId: policyThreeId })
    .where(eq(organizations.id, organizationOneId));
  assert.equal(await repository.getSkillVisibleToOrganizationBySlug("organization-shared-skill", organizationOneId), null);
  assert.equal(await repository.getVisibleSkillBySlug("organization-shared-skill", memberId), null);

  await repository.updateSkillSharing({
    actor: { id: ownerId, roles: ["author"] },
    slug: "organization-shared-skill",
    visibility: "organization",
    teamIds: [],
    userEmails: [],
    organizationIds: [organizationOneId],
  });
  assert.equal((await repository.getSkillVisibleToOrganizationBySlug("organization-shared-skill", organizationOneId))?.slug, "organization-shared-skill");
  assert.equal((await repository.getVisibleSkillBySlug("organization-shared-skill", memberId))?.slug, "organization-shared-skill");

  for (const organizationId of [organizationTwoId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]) {
    await assert.rejects(
      repository.updateSkillSharing({
        actor: { id: ownerId, roles: ["author"] },
        slug: "organization-shared-skill",
        visibility: "organization",
        teamIds: [],
        userEmails: [],
        organizationIds: [organizationId],
      }),
      (error) => isAppError(error, "ORGANIZATION_GRANT_NOT_AVAILABLE"),
    );
  }
  assert.equal((await repository.getSkillVisibleToOrganizationBySlug("organization-shared-skill", organizationOneId))?.slug, "organization-shared-skill");

  await db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, organizationOneId));
  assert.equal(await repository.getSkillVisibleToOrganizationBySlug("organization-shared-skill", organizationOneId), null);
  await assert.rejects(
    repository.updateSkillSharing({
      actor: { id: ownerId, roles: ["author"] },
      slug: "organization-shared-skill",
      visibility: "organization",
      teamIds: [],
      userEmails: [],
      organizationIds: [organizationOneId],
    }),
    (error) => isAppError(error, "ORGANIZATION_GRANT_NOT_AVAILABLE"),
  );

  await db.update(organizations).set({ status: "active" }).where(eq(organizations.id, organizationOneId));
  await repository.updateSkillSharing({
    actor: { id: ownerId, roles: ["author"] },
    slug: "organization-shared-skill",
    visibility: "public",
    teamIds: [],
    userEmails: [],
    organizationIds: [],
  });
  assert.equal((await db.select().from(skillOrganizationGrants).where(eq(skillOrganizationGrants.skillId, skillId))).length, 0);
  assert.equal((await repository.getSkillVisibleToOrganizationBySlug("organization-shared-skill", organizationTwoId))?.slug, "organization-shared-skill");
});

test("Postgres organization sharing defaults off and does not treat organization as authenticated", {
  timeout: 60_000,
}, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const repository = new PostgresSkillRepository(db);
  await insertUser(db, ownerId, "settings-owner@example.com");
  await insertOrganization(db, organizationOneId, "Organization One", "settings-organization-one", policyOneId);
  await insertReleasedSkill(db, "organization-settings-skill", "organization");
  assert.equal((await repository.getSharingSettings()).organizationVisibilityEnabled, false);

  await assert.rejects(
    repository.updateSkillSharing({
      actor: { id: ownerId, roles: ["author"] },
      slug: "organization-settings-skill",
      visibility: "organization",
      teamIds: [],
      userEmails: [],
      organizationIds: [organizationOneId],
    }),
    (error) => isAppError(error, "ORGANIZATION_SHARING_DISABLED"),
  );

  await insertReleasedSkill(db, "public-settings-skill", "public");
  await insertReleasedSkill(db, "authenticated-settings-skill", "authenticated");
  assert.equal((await repository.getSkillVisibleToOrganizationBySlug("public-settings-skill", organizationOneId))?.slug, "public-settings-skill");
  assert.equal((await repository.getSkillVisibleToOrganizationBySlug("authenticated-settings-skill", organizationOneId))?.slug, "authenticated-settings-skill");
});

test("Postgres omitted sharing grants preserve actor-hidden teams and organizations while explicit empty grants revoke", {
  timeout: 60_000,
  concurrency: false,
}, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const repository = new PostgresSkillRepository(db);
  await insertUser(db, ownerId, "omitted-owner@example.com");
  await insertUser(db, memberId, "omitted-member@example.com");
  await insertUser(db, outsiderId, "omitted-outsider@example.com");
  await insertOrganization(db, organizationOneId, "Organization One", "omitted-one", policyOneId);
  await insertOrganization(db, organizationTwoId, "Organization Two", "omitted-two", policyTwoId);
  await db.insert(organizationMemberships).values([
    { organizationId: organizationOneId, userId: ownerId, role: "owner" },
    { organizationId: organizationTwoId, userId: outsiderId, role: "member" },
  ]);
  await db.insert(teams).values({
    id: hiddenTeamId,
    name: "Hidden Team",
    slug: "omitted-hidden-team",
    createdByUserId: ownerId,
  });
  await db.insert(teamMemberships).values({ teamId: hiddenTeamId, userId: outsiderId, role: "member" });
  await insertReleasedSkill(db);
  await repository.updateSharingSettings({ id: ownerId, roles: ["owner"] }, sharingEnabled);
  await db.insert(skillOrganizationGrants).values([
    {
      skillId,
      organizationId: organizationOneId,
      createdByUserId: ownerId,
      createdUnderPolicyRevisionId: policyOneId,
    },
    {
      skillId,
      organizationId: organizationTwoId,
      createdByUserId: ownerId,
      createdUnderPolicyRevisionId: policyTwoId,
    },
  ]);
  await db.insert(skillTeamGrants).values({ skillId, teamId: hiddenTeamId });

  const ownerView = await repository.getSkillSharing("organization-shared-skill", {
    id: ownerId,
    roles: ["owner"],
  });
  assert.deepEqual(ownerView.organizationGrants?.map((organization) => organization.id), [organizationOneId]);
  assert.deepEqual(ownerView.teamGrants, []);

  await repository.updateSkillSharing({
    actor: { id: ownerId, roles: ["owner"] },
    slug: "organization-shared-skill",
    visibility: "organization",
  });
  assert.equal((await repository.getVisibleSkillBySlug("organization-shared-skill", outsiderId))?.slug, "organization-shared-skill");

  await repository.updateSkillSharing({
    actor: { id: ownerId, roles: ["owner"] },
    slug: "organization-shared-skill",
    visibility: "team",
  });
  assert.equal((await repository.getVisibleSkillBySlug("organization-shared-skill", outsiderId))?.slug, "organization-shared-skill");

  await repository.updateSkillSharing({
    actor: { id: ownerId, roles: ["owner"] },
    slug: "organization-shared-skill",
    visibility: "private",
    teamIds: [],
    userEmails: [],
    organizationIds: [],
  });
  assert.equal((await db.select().from(skillTeamGrants).where(eq(skillTeamGrants.skillId, skillId))).length, 0);
  assert.equal((await db.select().from(skillOrganizationGrants).where(eq(skillOrganizationGrants.skillId, skillId))).length, 0);
});

test("Postgres organization-only sharing updates recheck a concurrently disabled instance setting", {
  timeout: 60_000,
  concurrency: false,
}, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const repository = new PostgresSkillRepository(db);
  await insertUser(db, ownerId, "settings-race-owner@example.com");
  await insertOrganization(db, organizationOneId, "Organization One", "settings-race-one", policyOneId);
  await db.insert(organizationMemberships).values({ organizationId: organizationOneId, userId: ownerId, role: "owner" });
  await insertReleasedSkill(db);
  await repository.updateSharingSettings({ id: ownerId, roles: ["owner"] }, sharingEnabled);
  await repository.updateSkillSharing({
    actor: { id: ownerId, roles: ["owner"] },
    slug: "organization-shared-skill",
    visibility: "organization",
    teamIds: [],
    userEmails: [],
    organizationIds: [organizationOneId],
  });

  const blockerPool = createPgPool(databaseUrl as string);
  const blocker = await blockerPool.connect();
  let blockerInTransaction = false;
  t.after(async () => {
    if (blockerInTransaction) await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await blockerPool.end();
  });
  await blocker.query("BEGIN");
  blockerInTransaction = true;
  await blocker.query(`
    UPDATE instance_settings
    SET value = jsonb_set(value, '{organizationVisibilityEnabled}', 'false'::jsonb, true)
    WHERE key = 'sharing'
  `);

  const pending = repository.updateSkillSharing({
    actor: { id: ownerId, roles: ["owner"] },
    slug: "organization-shared-skill",
    visibility: "organization",
    organizationIds: [organizationOneId],
  });
  await waitForBlockedSharingSettingsQuery(pool);
  await blocker.query("COMMIT");
  blockerInTransaction = false;

  await assert.rejects(
    pending,
    (error) => isAppError(error, "ORGANIZATION_SHARING_DISABLED"),
  );
  assert.deepEqual(
    (await db.select({ organizationId: skillOrganizationGrants.organizationId })
      .from(skillOrganizationGrants)
      .where(eq(skillOrganizationGrants.skillId, skillId))).map((grant) => grant.organizationId),
    [organizationOneId],
  );
});

test("Postgres organization skill grant limits apply to the complete target set transactionally", {
  timeout: 60_000,
}, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const repository = new PostgresSkillRepository(db);
  await insertUser(db, ownerId, "skill-limit-owner@example.com");
  await insertOrganization(db, organizationOneId, "Organization One", "skill-limit-one", policyOneId);
  await insertOrganization(db, organizationTwoId, "Organization Two", "skill-limit-two", policyTwoId);
  await db.insert(organizationMemberships).values([
    { organizationId: organizationOneId, userId: ownerId, role: "owner" },
    { organizationId: organizationTwoId, userId: ownerId, role: "owner" },
  ]);
  const limitedPolicy: OrganizationPolicyV1 = {
    ...defaultOrganizationPolicyV1,
    limits: {
      ...defaultOrganizationPolicyV1.limits,
      organizationGrantsPerSkill: 1,
    },
  };
  await db.insert(organizationPolicyRevisions).values({
    id: policyThreeId,
    organizationId: organizationOneId,
    revisionNumber: 2,
    schemaVersion: 1,
    policy: limitedPolicy,
    policySha256: organizationPolicyDigest(limitedPolicy),
    createdByUserId: ownerId,
  });
  await db.update(organizations)
    .set({ currentPolicyRevisionId: policyThreeId })
    .where(eq(organizations.id, organizationOneId));
  await insertReleasedSkill(db);
  await repository.updateSharingSettings({ id: ownerId, roles: ["owner"] }, sharingEnabled);

  await assert.rejects(
    repository.updateSkillSharing({
      actor: { id: ownerId, roles: ["author"] },
      slug: "organization-shared-skill",
      visibility: "organization",
      teamIds: [],
      userEmails: [],
      organizationIds: [organizationOneId, organizationTwoId],
    }),
    (error: unknown) => isAppError(error, "ORGANIZATION_SKILL_GRANT_LIMIT_EXCEEDED")
      && "details" in (error as object)
      && (error as { details?: { limit?: number } }).details?.limit === 1,
  );
  assert.equal(
    (await db.select().from(skillOrganizationGrants).where(eq(skillOrganizationGrants.skillId, skillId))).length,
    0,
  );
});

async function freshPool(t: TestContext) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for organization skill sharing tests.");
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  return pool;
}

async function waitForBlockedSharingSettingsQuery(pool: ReturnType<typeof createPgPool>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query ILIKE '%instance_settings%'
        AND query ILIKE '%for update%'
    `);
    if (result.rows[0]?.count !== "0") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the organization sharing transaction to lock instance settings.");
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
  db: ReturnType<typeof createDb>,
  id: string,
  name: string,
  slug: string,
  policyId: string,
): Promise<void> {
  await db.insert(organizations).values({ id, name, slug, createdByUserId: ownerId });
  await db.insert(organizationPolicyRevisions).values({
    id: policyId,
    organizationId: id,
    revisionNumber: 1,
    schemaVersion: 1,
    policy: defaultOrganizationPolicyV1,
    policySha256: "a".repeat(64),
    createdByUserId: ownerId,
  });
  await db.update(organizations).set({ currentPolicyRevisionId: policyId, status: "active" }).where(eq(organizations.id, id));
}

async function insertReleasedSkill(
  db: ReturnType<typeof createDb>,
  slug = "organization-shared-skill",
  visibility: "organization" | "public" | "authenticated" = "organization",
): Promise<void> {
  const skillAlreadyExists = (await db.select({ id: skills.id }).from(skills).where(eq(skills.slug, slug)))[0];
  if (skillAlreadyExists) return;
  const [skill] = await db.insert(skills).values({
    id: slug === "organization-shared-skill" ? skillId : undefined,
    slug,
    title: "Organization shared skill",
    summary: "A released organization sharing fixture.",
    lifecycleStatus: "approved",
    visibility,
    ownerUserId: ownerId,
  }).returning({ id: skills.id });
  assert.ok(skill);
  const [version] = await db.insert(skillVersions).values({
    id: slug === "organization-shared-skill" ? skillVersionId : undefined,
    skillId: skill.id,
    version: "1.0.0",
    lifecycleStatus: "approved",
    reviewStatus: "approved",
    securityStatus: "passed",
    publishedAt: new Date(),
  }).returning({ id: skillVersions.id });
  assert.ok(version);
  await db.insert(skillArtifacts).values({
    skillVersionId: version.id,
    storageKey: `tests/${slug}.json`,
    sha256: "b".repeat(64),
    byteSize: 2,
    contentType: "application/json",
    payload: { files: [] },
  });
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "TEST_DATABASE_URL must target a disposable database whose name includes test or ci.");
}

function isAppError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
