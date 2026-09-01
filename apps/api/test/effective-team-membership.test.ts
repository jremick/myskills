import assert from "node:assert/strict";
import test from "node:test";
import type { SharingSettings } from "@myskills-app/core";
import { parseSkillManifest } from "@myskills-app/skill-package";
import { MemoryOrganizationStore } from "../src/organizations/memory-organization-store.js";
import { OrganizationService } from "../src/organizations/service.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { MemoryTeamStore } from "../src/teams/memory-team-store.js";
import { TeamService } from "../src/teams/service.js";

const settings: SharingSettings = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
};

const owner = { id: "effective-owner", email: "effective-owner@example.com", name: "Owner" };
const member = { id: "effective-member", email: "effective-member@example.com", name: "Member" };

test("organization-owned team membership fails closed on removal and suspension while standalone teams remain", async () => {
  const organizationStore = new MemoryOrganizationStore({ now: () => new Date("2026-08-30T00:00:00.000Z") });
  organizationStore.addKnownUser(owner);
  organizationStore.addKnownUser(member);
  const teamStore = new MemoryTeamStore({ organizationStore });
  teamStore.addKnownUser(owner);
  teamStore.addKnownUser(member);
  const organizationService = new OrganizationService(organizationStore, new TeamService(teamStore));
  const teamService = new TeamService(teamStore);
  const organization = await organizationService.createOrganization({ actor: owner, name: "Effective Membership", slug: "effective-membership" });
  const child = await organizationService.createChildTeam({ actor: owner, organizationId: organization.id, name: "Parented Team" });
  const invitation = await teamService.inviteMember({ actor: owner, teamId: child.id, email: member.email, settings });
  await organizationService.inviteMember({ actor: owner, organizationId: organization.id, email: member.email });
  const organizationInvitation = (await organizationStore.listInvitations({ organizationId: organization.id }))[0];
  assert.ok(organizationInvitation);
  await organizationService.acceptInvitation({ actor: member, invitationId: organizationInvitation.id });
  await teamService.acceptInvitation({ actor: member, invitationId: invitation.id, settings });

  assert.equal((await teamStore.findMembership({ teamId: child.id, userId: member.id }))?.role, "member");
  assert.equal((await teamService.listDashboard(member)).teams.some((team) => team.id === child.id), true);

  await organizationService.removeMember({ actor: owner, organizationId: organization.id, memberId: member.id });
  assert.equal(await teamStore.findMembership({ teamId: child.id, userId: member.id }), null);
  assert.equal((await teamService.listDashboard(member)).teams.some((team) => team.id === child.id), false);

  const standalone = await teamService.createTeam({ actor: owner, name: "Standalone Team", settings });
  const standaloneInvitation = await teamService.inviteMember({ actor: owner, teamId: standalone.id, email: member.email, settings });
  await teamService.acceptInvitation({ actor: member, invitationId: standaloneInvitation.id, settings });
  assert.equal((await teamStore.findMembership({ teamId: standalone.id, userId: member.id }))?.role, "member");

  await organizationService.archiveOrganization({ actor: owner, organizationId: organization.id });
  assert.equal(await teamStore.findMembership({ teamId: child.id, userId: owner.id }), null);
  assert.equal((await teamStore.findMembership({ teamId: standalone.id, userId: member.id }))?.role, "member");
});

test("memory skill and release visibility require effective parented-team membership", async () => {
  const repository = new MemorySkillRepository([{
    slug: "effective-team-skill",
    title: "Effective Team Skill",
    summary: "A team release.",
    lifecycleStatus: "approved",
    visibility: "team",
    latestVersion: "1.0.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [],
    tags: [],
    ownerUserId: owner.id,
  }]);
  repository.addOrganization({ id: "effective-org", name: "Effective Organization" });
  repository.addTeam({ id: "effective-team", organizationId: "effective-org" });
  repository.addTeamMembership(member.id, { id: "effective-team", name: "Effective Team", role: "member" });
  repository.addTeamGrant("effective-team-skill", "effective-team");
  repository.addOrganizationMembership(member.id, "effective-org", "member");
  await repository.updateSharingSettings({ id: owner.id, roles: ["owner"] }, settings);

  assert.equal((await repository.getVisibleSkillBySlug("effective-team-skill", member.id))?.slug, "effective-team-skill");
  assert.equal((await repository.listTeamSkillGroups({ id: member.id, roles: ["user"] })).length, 1);

  repository.removeOrganizationMembership(member.id, "effective-org");
  assert.equal(await repository.getVisibleSkillBySlug("effective-team-skill", member.id), null);
  assert.deepEqual(await repository.listTeamSkillGroups({ id: member.id, roles: ["user"] }), []);
  repository.addOrganizationMembership(member.id, "effective-org", "member");
  repository.setOrganizationStatus("effective-org", "suspended");
  assert.equal(await repository.getVisibleSkillBySlug("effective-team-skill", member.id), null);

  const submissionStore = new MemorySubmissionStore({
    sharingSettings: { ...settings },
    organizations: [{ id: "effective-org", status: "suspended" }],
    organizationMemberships: [{ userId: member.id, organizationId: "effective-org", role: "member" }],
    teams: [{ id: "effective-release-team", organizationId: "effective-org" }],
    teamMemberships: [{ userId: member.id, teamId: "effective-release-team" }],
    teamGrants: [{ slug: "effective-release", teamId: "effective-release-team" }],
  });
  const submissionService = new SubmissionService(submissionStore);
  const manifest = parseSkillManifest({
    name: "effective-release",
    title: "Effective Release",
    summary: "A team release.",
    version: "1.0.0",
    license: "Apache-2.0",
    visibility: "team",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
    tags: [],
  });
  const submitted = await submissionService.createSubmission({
    actor: { id: owner.id, roles: ["author"] },
    manifest,
    files: [
      { path: "skill.json", content: JSON.stringify(manifest) },
      { path: "README.md", content: "Team release." },
    ],
  });
  const review = await submissionService.getReviewSubmissionBundle({
    actor: { id: "effective-maintainer", roles: ["maintainer"] },
    submissionId: submitted.id,
  });
  assert.ok(review);
  await submissionService.performReviewAction({
    actor: { id: "effective-maintainer", roles: ["maintainer"] },
    submissionId: submitted.id,
    action: "approve",
    artifactSha256: review.artifact.sha256,
  });
  await submissionService.performReviewAction({
    actor: { id: "effective-maintainer", roles: ["maintainer"] },
    submissionId: submitted.id,
    action: "publish",
  });

  assert.equal(await submissionService.getPublicRelease({ slug: "effective-release", version: "1.0.0", actorId: member.id }), null);
  submissionStore.setOrganizationStatus("effective-org", "active");
  assert.ok(await submissionService.getPublicRelease({ slug: "effective-release", version: "1.0.0", actorId: member.id }));
  submissionStore.removeOrganizationMembership(member.id, "effective-org");
  assert.equal(await submissionService.getPublicBundle({ slug: "effective-release", version: "1.0.0", actorId: member.id }), null);
});
