import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { defaultOrganizationPolicyV1, organizationPolicyDigest, type SharingSettings } from "@myskills-app/core";
import { parseSkillManifest, type PackageInputFile } from "@myskills-app/skill-package";
import { eq } from "drizzle-orm";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  organizationMemberships,
  organizationPolicyRevisions,
  organizations,
  skillOrganizationGrants,
  skills,
  users,
} from "../src/db/schema.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const unrelatedOrgMemberId = "33333333-3333-4333-8333-333333333333";
const maintainerId = "44444444-4444-4444-8444-444444444444";
const organizationId = "55555555-5555-4555-8555-555555555555";
const unrelatedOrganizationId = "66666666-6666-4666-8666-666666666666";
const policyRevisionId = "77777777-7777-4777-8777-777777777777";
const disabledPolicyRevisionId = "88888888-8888-4888-8888-888888888888";
const enabledPolicyRevisionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const sharingEnabled: SharingSettings = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
  organizationVisibilityEnabled: true,
};

test("Postgres organization release metadata and bundles require exact current org access", {
  timeout: 60_000,
}, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const submissionService = new SubmissionService(new PostgresSubmissionStore(db));
  const skillRepository = new PostgresSkillRepository(db);

  await insertUser(db, ownerId, "organization-release-owner@example.com");
  await insertUser(db, memberId, "organization-release-member@example.com");
  await insertUser(db, unrelatedOrgMemberId, "unrelated-organization-member@example.com");
  await insertUser(db, maintainerId, "organization-release-maintainer@example.com");
  await insertOrganization(db, organizationId, "Organization One", "organization-one", policyRevisionId, ownerId);
  await insertOrganization(db, unrelatedOrganizationId, "Organization Two", "organization-two", "99999999-9999-4999-8999-999999999999", ownerId);
  await db.insert(organizationMemberships).values([
    { organizationId, userId: ownerId, role: "owner" },
    { organizationId, userId: memberId, role: "member" },
    { organizationId: unrelatedOrganizationId, userId: unrelatedOrgMemberId, role: "member" },
  ]);
  await skillRepository.updateSharingSettings({ id: ownerId, roles: ["owner"] }, sharingEnabled);

  const submitted = await submissionService.createSubmission({
    actor: { id: ownerId, roles: ["author"] },
    ...organizationPackageInput(),
  });
  assert.equal(submitted.visibility, "organization");
  const reviewBundle = await submissionService.getReviewSubmissionBundle({
    actor: { id: maintainerId, roles: ["maintainer"] },
    submissionId: submitted.id,
  });
  assert.ok(reviewBundle);
  await submissionService.performReviewAction({
    actor: { id: maintainerId, roles: ["maintainer"] },
    submissionId: submitted.id,
    action: "approve",
    artifactSha256: reviewBundle.artifact.sha256,
  });
  await submissionService.performReviewAction({
    actor: { id: maintainerId, roles: ["maintainer"] },
    submissionId: submitted.id,
    action: "publish",
  });

  const releaseInput = { slug: "organization-release", version: "1.0.0" };
  assert.ok(await submissionService.getPublicRelease({ ...releaseInput, actorId: ownerId }));
  assert.equal(await submissionService.getPublicRelease({ ...releaseInput, actorId: memberId }), null);
  assert.equal(await submissionService.getPublicRelease({ ...releaseInput, actorId: unrelatedOrgMemberId }), null);
  assert.equal(await submissionService.getPublicRelease(releaseInput), null);

  const [skill] = await db.select({ id: skills.id }).from(skills).where(eq(skills.slug, releaseInput.slug));
  assert.ok(skill);
  await db.insert(skillOrganizationGrants).values({
    skillId: skill.id,
    organizationId,
    createdByUserId: ownerId,
    createdUnderPolicyRevisionId: policyRevisionId,
  });

  assert.ok(await submissionService.getPublicRelease({ ...releaseInput, actorId: memberId }));
  const memberBundle = await submissionService.getPublicBundle({ ...releaseInput, actorId: memberId, platform: "codex" });
  assert.ok(memberBundle);
  assert.equal(memberBundle.payload.files.some((file) => file.path === "README.md"), true);
  assert.deepEqual(
    (await submissionService.listSkillReleases({
      slug: releaseInput.slug,
      actor: { id: memberId, roles: ["user"] },
    })).map((release) => release.version),
    ["1.0.0"],
  );
  assert.equal(await submissionService.getPublicRelease({ ...releaseInput, actorId: unrelatedOrgMemberId }), null);
  assert.equal(await submissionService.getPublicBundle({ ...releaseInput, actorId: unrelatedOrgMemberId }), null);

  const enabledPolicy = {
    ...defaultOrganizationPolicyV1,
    limits: {
      ...defaultOrganizationPolicyV1.limits,
      teamsPerOrganization: defaultOrganizationPolicyV1.limits.teamsPerOrganization - 1,
    },
  };
  await db.insert(organizationPolicyRevisions).values({
    id: enabledPolicyRevisionId,
    organizationId,
    revisionNumber: 2,
    schemaVersion: 1,
    policy: enabledPolicy,
    policySha256: organizationPolicyDigest(enabledPolicy),
    createdByUserId: ownerId,
  });
  await db.update(organizations)
    .set({ currentPolicyRevisionId: enabledPolicyRevisionId })
    .where(eq(organizations.id, organizationId));
  assert.equal(await submissionService.getPublicRelease({ ...releaseInput, actorId: memberId }), null);
  assert.equal(await submissionService.getPublicBundle({ ...releaseInput, actorId: memberId }), null);

  await db.delete(skillOrganizationGrants).where(eq(skillOrganizationGrants.skillId, skill.id));
  await db.insert(skillOrganizationGrants).values({
    skillId: skill.id,
    organizationId,
    createdByUserId: ownerId,
    createdUnderPolicyRevisionId: enabledPolicyRevisionId,
  });
  assert.ok(await submissionService.getPublicRelease({ ...releaseInput, actorId: memberId }));
  assert.ok(await submissionService.getPublicBundle({ ...releaseInput, actorId: memberId, platform: "codex" }));

  await db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, organizationId));
  assert.equal(await submissionService.getPublicRelease({ ...releaseInput, actorId: memberId }), null);
  assert.equal(await submissionService.getPublicBundle({ ...releaseInput, actorId: memberId }), null);
  assert.ok(await submissionService.getPublicBundle({ ...releaseInput, actorId: ownerId }));

  await db.update(organizations).set({ status: "active" }).where(eq(organizations.id, organizationId));
  await db.insert(organizationPolicyRevisions).values({
    id: disabledPolicyRevisionId,
    organizationId,
    revisionNumber: 3,
    schemaVersion: 1,
    policy: {
      ...defaultOrganizationPolicyV1,
      sharing: {
        ...defaultOrganizationPolicyV1.sharing,
        organizationSkillSharingEnabled: false,
      },
    },
    policySha256: organizationPolicyDigest({
      ...defaultOrganizationPolicyV1,
      sharing: {
        ...defaultOrganizationPolicyV1.sharing,
        organizationSkillSharingEnabled: false,
      },
    }),
    createdByUserId: ownerId,
  });
  await db.update(organizations).set({ currentPolicyRevisionId: disabledPolicyRevisionId }).where(eq(organizations.id, organizationId));
  assert.equal(await submissionService.getPublicRelease({ ...releaseInput, actorId: memberId }), null);
  assert.equal(await submissionService.getPublicBundle({ ...releaseInput, actorId: memberId }), null);
  assert.ok(await submissionService.getPublicRelease({ ...releaseInput, actorId: ownerId }));

  await db.update(organizations).set({ currentPolicyRevisionId: policyRevisionId }).where(eq(organizations.id, organizationId));
  await skillRepository.updateSharingSettings({ id: ownerId, roles: ["owner"] }, {
    ...sharingEnabled,
    organizationVisibilityEnabled: false,
  });
  assert.equal(await submissionService.getPublicRelease({ ...releaseInput, actorId: memberId }), null);
  assert.equal(await submissionService.getPublicBundle({ ...releaseInput, actorId: memberId }), null);
  assert.ok(await submissionService.getPublicRelease({ ...releaseInput, actorId: ownerId }));

  await skillRepository.updateSharingSettings({ id: ownerId, roles: ["owner"] }, sharingEnabled);
  await db.update(organizationMemberships)
    .set({ removedAt: new Date() })
    .where(eq(organizationMemberships.userId, memberId));
  assert.equal(await submissionService.getPublicRelease({ ...releaseInput, actorId: memberId }), null);
  assert.equal(await submissionService.getPublicBundle({ ...releaseInput, actorId: memberId }), null);
  assert.ok(await submissionService.getPublicBundle({ ...releaseInput, actorId: ownerId }));
});

async function freshPool(t: TestContext) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for organization release visibility tests.");
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

async function insertOrganization(
  db: ReturnType<typeof createDb>,
  id: string,
  name: string,
  slug: string,
  policyId: string,
  createdByUserId: string,
): Promise<void> {
  await db.insert(organizations).values({ id, name, slug, createdByUserId });
  await db.insert(organizationPolicyRevisions).values({
    id: policyId,
    organizationId: id,
    revisionNumber: 1,
    schemaVersion: 1,
    policy: defaultOrganizationPolicyV1,
    policySha256: organizationPolicyDigest(defaultOrganizationPolicyV1),
    createdByUserId,
  });
  await db.update(organizations).set({ currentPolicyRevisionId: policyId, status: "active" }).where(eq(organizations.id, id));
}

function organizationPackageInput(): {
  manifest: ReturnType<typeof parseSkillManifest>;
  files: PackageInputFile[];
} {
  const manifest = parseSkillManifest({
    name: "organization-release",
    title: "Organization Release",
    summary: "A release scoped to an organization.",
    version: "1.0.0",
    license: "Apache-2.0",
    visibility: "organization",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
    tags: ["organization"],
  });
  return {
    manifest,
    files: [
      { path: "skill.json", content: JSON.stringify(manifest) },
      { path: "README.md", content: "Organization-only release." },
    ],
  };
}
