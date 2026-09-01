import assert from "node:assert/strict";
import test from "node:test";
import { AppError, defaultOrganizationPolicyV1, type SkillSharingOrganizationSummary } from "@myskills-app/core";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

const released = {
  title: "Organization skill",
  summary: "A released organization sharing fixture.",
  lifecycleStatus: "approved" as const,
  latestVersion: "1.0.0",
  reviewStatus: "approved" as const,
  securityStatus: "passed" as const,
  platforms: [],
  tags: [],
};

const orgOne: SkillSharingOrganizationSummary = {
  id: "org-one",
  name: "Organization One",
  slug: "organization-one",
  status: "active",
  role: "owner",
};

const orgTwo: SkillSharingOrganizationSummary = {
  id: "org-two",
  name: "Organization Two",
  slug: "organization-two",
  status: "active",
  role: "member",
};

function enabledSharing() {
  return {
    publicVisibilityEnabled: true,
    authenticatedVisibilityEnabled: true,
    teamsEnabled: true,
    teamVisibilityEnabled: true,
    userVisibilityEnabled: true,
    organizationVisibilityEnabled: true,
  };
}

test("organization skill sharing requires exact active membership and current policy", async () => {
  const repository = new MemorySkillRepository([
    { ...released, slug: "org-skill", visibility: "private" as const, ownerUserId: "skill-owner" },
  ]);
  repository.addOrganization(orgOne);
  repository.addOrganization(orgTwo,);
  repository.addOrganizationMembership("skill-owner", orgOne);
  repository.addOrganizationMembership("member-one", { ...orgOne, role: "member" });
  repository.addOrganizationMembership("member-two", { ...orgTwo, role: "member" });
  await repository.updateSharingSettings({ id: "instance-owner", roles: ["owner"] }, enabledSharing());

  await repository.updateSkillSharing({
    actor: { id: "skill-owner", roles: ["author"] },
    slug: "org-skill",
    visibility: "organization",
    teamIds: [],
    userEmails: [],
    organizationIds: [orgOne.id],
  });

  assert.equal((await repository.getVisibleSkillBySlug("org-skill", "member-one"))?.slug, "org-skill");
  assert.deepEqual(
    (await repository.getVisibleSkillBySlug("org-skill", "member-one"))?.access?.reasons,
    ["organization"],
  );
  assert.equal(await repository.getVisibleSkillBySlug("org-skill", "member-two"), null);
  assert.equal(await repository.getVisibleSkillBySlug("org-skill", "instance-owner"), null);
  assert.equal((await repository.getSkillVisibleToOrganizationBySlug("org-skill", orgOne.id))?.slug, "org-skill");
  assert.equal(await repository.getSkillVisibleToOrganizationBySlug("org-skill", orgTwo.id), null);

  const sharing = await repository.getSkillSharing("org-skill", { id: "skill-owner", roles: ["author"] });
  assert.deepEqual(sharing.availableOrganizations?.map((organization) => organization.id), [orgOne.id]);
  assert.deepEqual(sharing.organizationGrants?.map((organization) => organization.id), [orgOne.id]);

  repository.setOrganizationPolicy(orgOne.id, defaultOrganizationPolicyV1, "org-one:policy:2");
  assert.equal(await repository.getVisibleSkillBySlug("org-skill", "member-one"), null);
  assert.equal(await repository.getSkillVisibleToOrganizationBySlug("org-skill", orgOne.id), null);

  await repository.updateSkillSharing({
    actor: { id: "skill-owner", roles: ["author"] },
    slug: "org-skill",
    visibility: "organization",
    teamIds: [],
    userEmails: [],
    organizationIds: [orgOne.id],
  });
  assert.equal((await repository.getVisibleSkillBySlug("org-skill", "member-one"))?.slug, "org-skill");

  repository.setOrganizationPolicy(orgOne.id, {
    ...defaultOrganizationPolicyV1,
    sharing: { ...defaultOrganizationPolicyV1.sharing, organizationSkillSharingEnabled: false },
  });
  assert.equal(await repository.getVisibleSkillBySlug("org-skill", "member-one"), null);
  assert.equal(await repository.getSkillVisibleToOrganizationBySlug("org-skill", orgOne.id), null);
});

test("organization grants validate before replacing existing grants and do not enumerate organizations", async () => {
  const repository = new MemorySkillRepository([
    { ...released, slug: "org-skill", visibility: "private" as const, ownerUserId: "skill-owner" },
  ]);
  repository.addOrganization(orgOne);
  repository.addOrganization(orgTwo);
  repository.addOrganizationMembership("skill-owner", orgOne);
  await repository.updateSharingSettings({ id: "instance-owner", roles: ["owner"] }, enabledSharing());
  await repository.updateSkillSharing({
    actor: { id: "skill-owner", roles: ["author"] },
    slug: "org-skill",
    visibility: "organization",
    teamIds: [],
    userEmails: [],
    organizationIds: [orgOne.id],
  });

  for (const organizationId of [orgTwo.id, "missing-organization"]) {
    await assert.rejects(
      repository.updateSkillSharing({
        actor: { id: "skill-owner", roles: ["author"] },
        slug: "org-skill",
        visibility: "organization",
        teamIds: [],
        userEmails: [],
        organizationIds: [organizationId],
      }),
      (error) => error instanceof AppError && error.code === "ORGANIZATION_GRANT_NOT_AVAILABLE",
    );
  }
  assert.equal((await repository.getSkillVisibleToOrganizationBySlug("org-skill", orgOne.id))?.slug, "org-skill");

  await assert.rejects(
    repository.updateSkillSharing({
      actor: { id: "skill-owner", roles: ["author"] },
      slug: "org-skill",
      visibility: "organization",
      teamIds: [],
      userEmails: [],
      organizationIds: [],
    }),
    (error) => error instanceof AppError && error.code === "ORGANIZATION_GRANT_REQUIRED",
  );
});

test("organization skill grant limits apply to the complete target set without replacing existing grants", async () => {
  const limitedPolicy = {
    ...defaultOrganizationPolicyV1,
    limits: {
      ...defaultOrganizationPolicyV1.limits,
      organizationGrantsPerSkill: 1,
    },
  };
  const repository = new MemorySkillRepository([
    { ...released, slug: "limited-org-skill", visibility: "private" as const, ownerUserId: "skill-owner" },
  ]);
  repository.addOrganization({ ...orgOne, policy: limitedPolicy });
  repository.addOrganization(orgTwo);
  repository.addOrganizationMembership("skill-owner", orgOne);
  repository.addOrganizationMembership("skill-owner", { ...orgTwo, role: "owner" });
  await repository.updateSharingSettings({ id: "instance-owner", roles: ["owner"] }, enabledSharing());

  const actor = { id: "skill-owner", roles: ["author"] as const };
  await repository.updateSkillSharing({
    actor,
    slug: "limited-org-skill",
    visibility: "organization",
    teamIds: [],
    userEmails: [],
    organizationIds: [orgOne.id],
  });

  await assert.rejects(
    repository.updateSkillSharing({
      actor,
      slug: "limited-org-skill",
      visibility: "organization",
      teamIds: [],
      userEmails: [],
      organizationIds: [orgOne.id, orgTwo.id],
    }),
    (error) => error instanceof AppError
      && error.code === "ORGANIZATION_SKILL_GRANT_LIMIT_EXCEEDED"
      && error.statusCode === 409
      && error.details?.limit === 1,
  );
  assert.equal((await repository.getSkillVisibleToOrganizationBySlug("limited-org-skill", orgOne.id))?.slug, "limited-org-skill");
  assert.equal(await repository.getSkillVisibleToOrganizationBySlug("limited-org-skill", orgTwo.id), null);
});

test("organization discovery keeps public and authenticated scope behavior and defaults off", async () => {
  const repository = new MemorySkillRepository([
    { ...released, slug: "public-skill", visibility: "public" as const },
    { ...released, slug: "authenticated-skill", visibility: "authenticated" as const },
    { ...released, slug: "org-skill", visibility: "organization" as const, ownerUserId: "skill-owner" },
  ]);
  repository.addOrganization(orgOne);
  repository.addOrganizationMembership("member-one", { ...orgOne, role: "member" });
  repository.addOrganizationGrant("org-skill", orgOne.id);

  assert.equal((await repository.getSkillVisibleToOrganizationBySlug("public-skill", orgOne.id))?.slug, "public-skill");
  assert.equal((await repository.getSkillVisibleToOrganizationBySlug("authenticated-skill", orgOne.id))?.slug, "authenticated-skill");
  assert.equal(await repository.getSkillVisibleToOrganizationBySlug("org-skill", orgOne.id), null);
  assert.equal(await repository.getVisibleSkillBySlug("org-skill", "member-one"), null);
  assert.equal((await repository.getSharingSettings()).organizationVisibilityEnabled, false);
});
