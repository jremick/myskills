import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { eq } from "drizzle-orm";
import { defaultOrganizationPolicyV1, organizationPolicyDigest } from "@myskills-app/core";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  organizationMemberships,
  organizationPolicyRevisions,
  organizations,
  skillArtifacts,
  skillArchitectures,
  skillTeamGrants,
  skillVersions,
  skills,
  teamMemberships,
  teams,
  users,
} from "../src/db/schema.js";
import { PostgresArchitectureStore } from "../src/architectures/postgres-store.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { PostgresTeamStore } from "../src/teams/postgres-team-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const policyId = "44444444-4444-4444-8444-444444444444";
const parentedTeamId = "55555555-5555-4555-8555-555555555555";
const standaloneTeamId = "66666666-6666-4666-8666-666666666666";
const parentedSkillId = "77777777-7777-4777-8777-777777777777";
const standaloneSkillId = "88888888-8888-4888-8888-888888888888";
const parentedVersionId = "99999999-9999-4999-8999-999999999999";
const parentedArchitectureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const externalMemberPolicyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("Postgres team access is revoked by parent organization state while standalone teams remain", {
  timeout: 60_000,
  concurrency: false,
}, async (t) => {
  const pool = await freshPool(t);
  assert.ok(databaseUrl);
  const db = createDb(pool);
  const teamStore = new PostgresTeamStore(db);
  const skillRepository = new PostgresSkillRepository(db);
  const submissionStore = new PostgresSubmissionStore(db);
  const architectureStore = new PostgresArchitectureStore(db);

  await insertUser(db, ownerId, "effective-owner@example.com");
  await insertUser(db, memberId, "effective-member@example.com");
  await db.insert(organizations).values({
    id: organizationId,
    name: "Effective Organization",
    slug: "effective-organization",
    createdByUserId: ownerId,
  });
  await db.insert(organizationPolicyRevisions).values({
    id: policyId,
    organizationId,
    revisionNumber: 1,
    schemaVersion: 1,
    policy: defaultOrganizationPolicyV1,
    policySha256: organizationPolicyDigest(defaultOrganizationPolicyV1),
    createdByUserId: ownerId,
  });
  await db.update(organizations).set({
    status: "active",
    currentPolicyRevisionId: policyId,
  }).where(eq(organizations.id, organizationId));
  await db.insert(organizationMemberships).values([
    { organizationId, userId: ownerId, role: "owner" },
    { organizationId, userId: memberId, role: "member" },
  ]);
  await db.insert(teams).values([
    {
      id: parentedTeamId,
      name: "Parented Team",
      slug: "parented-team",
      createdByUserId: ownerId,
      organizationId,
    },
    {
      id: standaloneTeamId,
      name: "Standalone Team",
      slug: "standalone-team",
      createdByUserId: ownerId,
    },
  ]);
  await db.insert(teamMemberships).values([
    { teamId: parentedTeamId, userId: ownerId, role: "owner" },
    { teamId: parentedTeamId, userId: memberId, role: "member" },
    { teamId: standaloneTeamId, userId: ownerId, role: "owner" },
    { teamId: standaloneTeamId, userId: memberId, role: "member" },
  ]);
  await insertReleasedSkill(db, {
    id: parentedSkillId,
    slug: "effective-parented-skill",
    versionId: parentedVersionId,
    ownerUserId: ownerId,
  });
  await insertReleasedSkill(db, {
    id: standaloneSkillId,
    slug: "effective-standalone-skill",
    ownerUserId: ownerId,
  });
  await db.insert(skillTeamGrants).values([
    { skillId: parentedSkillId, teamId: parentedTeamId },
    { skillId: standaloneSkillId, teamId: standaloneTeamId },
  ]);
  await db.insert(skillArchitectures).values({
    id: parentedArchitectureId,
    ownerTeamId: parentedTeamId,
    name: "Effective parented architecture",
    description: "External team policy regression fixture.",
    patternId: "flat",
  });

  assert.equal((await teamStore.findMembership({ teamId: parentedTeamId, userId: memberId }))?.role, "member");
  assert.deepEqual(
    (await teamStore.listTeamsForUser(memberId)).map((team) => team.id),
    [parentedTeamId, standaloneTeamId],
  );
  assert.equal((await skillRepository.getVisibleSkillBySlug("effective-parented-skill", memberId))?.slug, "effective-parented-skill");
  assert.equal((await skillRepository.getVisibleSkillBySlug("effective-standalone-skill", memberId))?.slug, "effective-standalone-skill");
  assert.equal((await skillRepository.getSkillVisibleToTeamBySlug("effective-parented-skill", parentedTeamId))?.slug, "effective-parented-skill");
  assert.ok(await submissionStore.getPublicRelease({ slug: "effective-parented-skill", version: "1.0.0", actorId: memberId }));
  assert.equal((await architectureStore.getArchitecture(memberId, parentedArchitectureId))?.id, parentedArchitectureId);

  await db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, organizationId));
  assert.equal(await teamStore.findMembership({ teamId: parentedTeamId, userId: memberId }), null);
  assert.deepEqual((await teamStore.listTeamsForUser(memberId)).map((team) => team.id), [standaloneTeamId]);
  assert.equal(await skillRepository.getVisibleSkillBySlug("effective-parented-skill", memberId), null);
  assert.equal(await skillRepository.getSkillVisibleToTeamBySlug("effective-parented-skill", parentedTeamId), null);
  assert.equal(await submissionStore.getPublicRelease({ slug: "effective-parented-skill", version: "1.0.0", actorId: memberId }), null);
  assert.equal((await skillRepository.getVisibleSkillBySlug("effective-standalone-skill", memberId))?.slug, "effective-standalone-skill");

  await db.update(organizations).set({ status: "active" }).where(eq(organizations.id, organizationId));
  await db.update(organizationMemberships).set({ removedAt: new Date() }).where(andUserMembership(memberId));
  assert.equal(await teamStore.findMembership({ teamId: parentedTeamId, userId: memberId }), null);
  assert.deepEqual((await teamStore.listTeamsForUser(memberId)).map((team) => team.id), [standaloneTeamId]);
  assert.equal(await skillRepository.getVisibleSkillBySlug("effective-parented-skill", memberId), null);
  assert.equal(await submissionStore.getPublicRelease({ slug: "effective-parented-skill", version: "1.0.0", actorId: memberId }), null);
  assert.equal(await architectureStore.getArchitecture(memberId, parentedArchitectureId), null);

  const externalMemberPolicy = {
    ...defaultOrganizationPolicyV1,
    teams: {
      ...defaultOrganizationPolicyV1.teams,
      requireOrganizationMembershipForTeamMembers: false,
    },
  };
  await db.insert(organizationPolicyRevisions).values({
    id: externalMemberPolicyId,
    organizationId,
    revisionNumber: 2,
    schemaVersion: 1,
    policy: externalMemberPolicy,
    policySha256: organizationPolicyDigest(externalMemberPolicy),
    createdByUserId: ownerId,
  });
  await db.update(organizations).set({ currentPolicyRevisionId: externalMemberPolicyId }).where(eq(organizations.id, organizationId));

  assert.equal((await teamStore.findMembership({ teamId: parentedTeamId, userId: memberId }))?.role, "member");
  assert.equal((await skillRepository.getVisibleSkillBySlug("effective-parented-skill", memberId))?.slug, "effective-parented-skill");
  assert.ok(await submissionStore.getPublicRelease({ slug: "effective-parented-skill", version: "1.0.0", actorId: memberId }));
  assert.equal((await architectureStore.getArchitecture(memberId, parentedArchitectureId))?.id, parentedArchitectureId);
});

test("Postgres skill team grants recheck the complete effective membership set inside the replacement transaction", {
  timeout: 60_000,
  concurrency: false,
}, async (t) => {
  const pool = await freshPool(t);
  assert.ok(databaseUrl);
  const db = createDb(pool);
  const skillRepository = new PostgresSkillRepository(db);

  await insertUser(db, ownerId, "sharing-owner@example.com");
  await insertUser(db, memberId, "sharing-member@example.com");
  await db.insert(organizations).values({
    id: organizationId,
    name: "Sharing Organization",
    slug: "sharing-organization",
    createdByUserId: ownerId,
  });
  await db.insert(organizationPolicyRevisions).values({
    id: policyId,
    organizationId,
    revisionNumber: 1,
    schemaVersion: 1,
    policy: defaultOrganizationPolicyV1,
    policySha256: organizationPolicyDigest(defaultOrganizationPolicyV1),
    createdByUserId: ownerId,
  });
  await db.update(organizations).set({
    status: "active",
    currentPolicyRevisionId: policyId,
  }).where(eq(organizations.id, organizationId));
  await db.insert(organizationMemberships).values({ organizationId, userId: ownerId, role: "owner" });
  await db.insert(teams).values([
    {
      id: parentedTeamId,
      name: "Sharing Parented Team",
      slug: "sharing-parented-team",
      createdByUserId: ownerId,
      organizationId,
    },
    {
      id: standaloneTeamId,
      name: "Sharing Standalone Team",
      slug: "sharing-standalone-team",
      createdByUserId: ownerId,
    },
  ]);
  await db.insert(teamMemberships).values([
    { teamId: parentedTeamId, userId: ownerId, role: "owner" },
    { teamId: standaloneTeamId, userId: ownerId, role: "owner" },
  ]);
  await insertReleasedSkill(db, {
    id: parentedSkillId,
    slug: "sharing-race-skill",
    versionId: parentedVersionId,
    ownerUserId: ownerId,
  });
  await db.insert(skillTeamGrants).values([
    { skillId: parentedSkillId, teamId: parentedTeamId },
    { skillId: parentedSkillId, teamId: standaloneTeamId },
  ]);

  const blockerPool = createPgPool(databaseUrl);
  const blocker = await blockerPool.connect();
  let blockerInTransaction = false;
  t.after(async () => {
    if (blockerInTransaction) await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await blockerPool.end();
  });
  await blocker.query("BEGIN");
  blockerInTransaction = true;
  await blocker.query("SELECT id FROM teams WHERE id = $1 FOR UPDATE", [parentedTeamId]);

  const pending = skillRepository.updateSkillSharing({
    actor: { id: ownerId, roles: ["author"] },
    slug: "sharing-race-skill",
    visibility: "team",
    teamIds: [parentedTeamId, standaloneTeamId],
    userEmails: [],
  });
  await waitForBlockedTeamGrantQuery(pool);

  // The preflight teamsForUser query has already observed both memberships.
  // Delete one while the replacement transaction is waiting on the team row;
  // the transaction must reject the complete set after it acquires the lock.
  await pool.query(
    "DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2",
    [parentedTeamId, ownerId],
  );
  await blocker.query("ROLLBACK");
  blockerInTransaction = false;

  await assert.rejects(
    pending,
    (error) => isAppError(error, "TEAM_GRANT_NOT_AVAILABLE"),
  );
  assert.deepEqual(
    (await db.select({ teamId: skillTeamGrants.teamId }).from(skillTeamGrants)
      .where(eq(skillTeamGrants.skillId, parentedSkillId))
      .orderBy(skillTeamGrants.teamId)).map((grant) => grant.teamId),
    [parentedTeamId, standaloneTeamId],
  );

  // An empty complete set is an intentional revoke and does not require the
  // actor to remain a member of every previously granted team or the instance
  // team-sharing gate to remain enabled.
  await skillRepository.updateSharingSettings(
    { id: ownerId, roles: ["owner"] },
    {
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: true,
      teamsEnabled: false,
      teamVisibilityEnabled: false,
      userVisibilityEnabled: true,
      organizationVisibilityEnabled: false,
    },
  );
  await skillRepository.updateSkillSharing({
    actor: { id: ownerId, roles: ["author"] },
    slug: "sharing-race-skill",
    visibility: "private",
    teamIds: [],
    userEmails: [],
  });
  assert.equal(
    (await db.select().from(skillTeamGrants).where(eq(skillTeamGrants.skillId, parentedSkillId))).length,
    0,
  );
});

async function freshPool(t: TestContext) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for effective team membership tests.");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "TEST_DATABASE_URL must target a disposable database.");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  return pool;
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

async function insertReleasedSkill(
  db: ReturnType<typeof createDb>,
  input: { id: string; slug: string; ownerUserId: string; versionId?: string },
): Promise<void> {
  const [skill] = await db.insert(skills).values({
    id: input.id,
    slug: input.slug,
    title: input.slug,
    summary: "A released team skill.",
    lifecycleStatus: "approved",
    visibility: "team",
    ownerUserId: input.ownerUserId,
  }).returning({ id: skills.id });
  assert.ok(skill);
  const [version] = await db.insert(skillVersions).values({
    ...(input.versionId ? { id: input.versionId } : {}),
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
    storageKey: `tests/${input.slug}.json`,
    sha256: "a".repeat(64),
    byteSize: 2,
    contentType: "application/json",
    payload: { files: [] },
  });
}

function andUserMembership(userId: string) {
  return eq(organizationMemberships.userId, userId);
}

async function waitForBlockedTeamGrantQuery(pool: ReturnType<typeof createPgPool>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query ILIKE '%for update%'
        AND query ILIKE '%teams%'
    `);
    if (result.rows[0]?.count !== "0") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the skill-sharing transaction to reach the team lock barrier.");
}

function isAppError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
