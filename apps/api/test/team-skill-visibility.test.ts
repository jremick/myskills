import assert from "node:assert/strict";
import test from "node:test";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

const releasedSkill = {
  title: "Shared skill",
  summary: "A released test skill.",
  lifecycleStatus: "approved" as const,
  latestVersion: "1.0.0",
  reviewStatus: "approved" as const,
  securityStatus: "passed" as const,
  platforms: [],
  tags: [],
};

test("team-scoped skill lookup only returns safe scopes and the exact team grant", async () => {
  const repository = new MemorySkillRepository([
    { ...releasedSkill, slug: "public-skill", visibility: "public" as const },
    { ...releasedSkill, slug: "authenticated-skill", visibility: "authenticated" as const },
    { ...releasedSkill, slug: "team-skill", visibility: "team" as const },
    { ...releasedSkill, slug: "private-skill", visibility: "private" as const, ownerUserId: "owner-1" },
    { ...releasedSkill, slug: "explicit-user-skill", visibility: "explicit-users" as const },
    { ...releasedSkill, slug: "organization-skill", visibility: "organization" as const },
    { ...releasedSkill, slug: "unreleased-skill", visibility: "public" as const, lifecycleStatus: "draft", latestVersion: null },
  ]);
  repository.addTeamGrant("team-skill", "team-a");
  repository.addTeamGrant("team-skill", "team-b");

  const visibleToTeam = await Promise.all([
    repository.getSkillVisibleToTeamBySlug("public-skill", "not-a-member"),
    repository.getSkillVisibleToTeamBySlug("authenticated-skill", "not-a-member"),
    repository.getSkillVisibleToTeamBySlug("team-skill", "team-a"),
    repository.getSkillVisibleToTeamBySlug("team-skill", "team-b"),
  ]);
  assert.deepEqual(visibleToTeam.map((skill) => skill?.slug), [
    "public-skill",
    "authenticated-skill",
    "team-skill",
    "team-skill",
  ]);
  assert.equal(visibleToTeam[2]?.access, undefined);

  for (const slug of ["private-skill", "explicit-user-skill", "organization-skill", "unreleased-skill"]) {
    assert.equal(await repository.getSkillVisibleToTeamBySlug(slug, "team-a"), null, slug);
  }
  assert.equal(await repository.getSkillVisibleToTeamBySlug("team-skill", "team-c"), null);
});

test("team-scoped lookup does not change actor-based lookup or inherit another team membership", async () => {
  const repository = new MemorySkillRepository([
    { ...releasedSkill, slug: "team-skill", visibility: "team" as const },
  ]);
  repository.addTeamGrant("team-skill", "team-a");
  repository.addTeamMembership("user-a", { id: "team-a", name: "Team A", role: "member" });

  assert.equal((await repository.getVisibleSkillBySlug("team-skill", "user-a"))?.slug, "team-skill");
  assert.equal(await repository.getSkillVisibleToTeamBySlug("team-skill", "team-b"), null);
  assert.equal((await repository.getSkillVisibleToTeamBySlug("team-skill", "team-a"))?.slug, "team-skill");
});

test("team-scoped lookup respects sharing settings for each allowed scope", async () => {
  const repository = new MemorySkillRepository([
    { ...releasedSkill, slug: "public-skill", visibility: "public" as const },
    { ...releasedSkill, slug: "authenticated-skill", visibility: "authenticated" as const },
    { ...releasedSkill, slug: "team-skill", visibility: "team" as const },
  ]);
  repository.addTeamGrant("team-skill", "team-a");

  await repository.updateSharingSettings({ id: "owner-1", roles: ["owner"] }, {
    publicVisibilityEnabled: false,
    authenticatedVisibilityEnabled: false,
    teamsEnabled: true,
    teamVisibilityEnabled: true,
    userVisibilityEnabled: true,
  });
  assert.equal(await repository.getSkillVisibleToTeamBySlug("public-skill", "team-a"), null);
  assert.equal(await repository.getSkillVisibleToTeamBySlug("authenticated-skill", "team-a"), null);
  assert.equal((await repository.getSkillVisibleToTeamBySlug("team-skill", "team-a"))?.slug, "team-skill");

  await repository.updateSharingSettings({ id: "owner-1", roles: ["owner"] }, {
    publicVisibilityEnabled: true,
    authenticatedVisibilityEnabled: true,
    teamsEnabled: false,
    teamVisibilityEnabled: true,
    userVisibilityEnabled: true,
  });
  assert.equal(await repository.getSkillVisibleToTeamBySlug("team-skill", "team-a"), null);
});
