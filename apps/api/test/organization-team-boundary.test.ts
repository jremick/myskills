import assert from "node:assert/strict";
import test from "node:test";
import { AppError, defaultOrganizationPolicyV1 } from "@myskills-app/core";
import { MemoryOrganizationStore } from "../src/organizations/memory-organization-store.js";
import { OrganizationService } from "../src/organizations/service.js";
import { MemoryTeamStore } from "../src/teams/memory-team-store.js";
import { TeamService } from "../src/teams/service.js";

const settings = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
} as const;

const owner = { id: "owner-user", email: "owner@example.com", name: "Owner" };
const admin = { id: "admin-user", email: "admin@example.com", name: "Admin" };
const member = { id: "member-user", email: "member@example.com", name: "Member" };
const outsider = { id: "outsider-user", email: "outsider@example.com", name: "Outsider" };

test("organization child teams preserve standalone compatibility and enforce scoped creation", async () => {
  const { organizationService, teamService, teamStore } = fixture();
  const organization = await createOrganization(organizationService);

  const standalone = await teamService.createTeam({ actor: owner, name: "Legacy Team", settings });
  assert.equal(standalone.organizationId, null);

  const child = await organizationService.createChildTeam({
    actor: owner,
    organizationId: organization.id,
    name: "Platform Team",
  });
  assert.equal(child.organizationId, organization.id);
  assert.deepEqual(child.members.map((candidate) => candidate.id), [owner.id]);
  assert.equal((await teamStore.listTeamsForUser(owner.id)).some((team) => team.organizationId === null), true);

  const adminInvite = await organizationService.inviteMember({
    actor: owner,
    organizationId: organization.id,
    email: admin.email,
    role: "admin",
  });
  await organizationService.acceptInvitation({ actor: admin, invitationId: adminInvite.id });
  const adminChild = await organizationService.createChildTeam({
    actor: admin,
    organizationId: organization.id,
    name: "Admin Team",
  });
  assert.equal(adminChild.organizationId, organization.id);

  const memberInvite = await organizationService.inviteMember({
    actor: owner,
    organizationId: organization.id,
    email: member.email,
  });
  await organizationService.acceptInvitation({ actor: member, invitationId: memberInvite.id });
  await assert.rejects(
    organizationService.createChildTeam({ actor: member, organizationId: organization.id, name: "Denied Team" }),
    (error: unknown) => error instanceof AppError
      && error.code === "ORGANIZATION_TEAM_CREATE_FORBIDDEN"
      && error.statusCode === 403,
  );

  await organizationService.appendPolicyRevision({
    actor: owner,
    organizationId: organization.id,
    policy: {
      ...defaultOrganizationPolicyV1,
      teams: { ...defaultOrganizationPolicyV1.teams, membersCanCreateTeams: true },
    },
    reason: "Allow organization members to create teams",
  });
  const memberChild = await organizationService.createChildTeam({
    actor: member,
    organizationId: organization.id,
    name: "Member Team",
  });
  assert.equal(memberChild.organizationId, organization.id);
});

test("organization team limits include adoption and serialize concurrent standalone adoptions", async () => {
  const { organizationService, teamService, teamStore } = fixture();
  const organization = await organizationService.createOrganization({
    actor: owner,
    name: "Limited Team Organization",
    slug: "limited-team-organization",
    policy: { limits: { teamsPerOrganization: 1 } },
  });
  const child = await organizationService.createChildTeam({
    actor: owner,
    organizationId: organization.id,
    name: "Existing Child Team",
  });
  assert.equal(child.organizationId, organization.id);
  const standalone = await teamService.createTeam({ actor: owner, name: "Over-cap Standalone", settings });
  await assert.rejects(
    organizationService.adoptStandaloneTeam({ actor: owner, organizationId: organization.id, teamId: standalone.id }),
    (error: unknown) => error instanceof AppError
      && error.code === "ORGANIZATION_TEAM_LIMIT_REACHED"
      && error.statusCode === 409,
  );
  assert.equal((await teamStore.listTeamsForUser(owner.id)).find((team) => team.id === standalone.id)?.organizationId, null);

  const raceOrganization = await organizationService.createOrganization({
    actor: owner,
    name: "Adoption Race Organization",
    slug: "adoption-race-organization",
    policy: { limits: { teamsPerOrganization: 1 } },
  });
  const raceTeams = await Promise.all([
    teamService.createTeam({ actor: owner, name: "Race Standalone One", settings }),
    teamService.createTeam({ actor: owner, name: "Race Standalone Two", settings }),
  ]);
  const results = await Promise.allSettled(raceTeams.map((team) => organizationService.adoptStandaloneTeam({
    actor: owner,
    organizationId: raceOrganization.id,
    teamId: team.id,
  })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason?.code === "ORGANIZATION_TEAM_LIMIT_REACHED").length, 1);
  assert.equal((await teamStore.listTeamsForUser(owner.id)).filter((team) => team.organizationId === raceOrganization.id).length, 1);
});

test("adoption is owner/admin scoped, requires all current members, and is one-way", async () => {
  const { organizationService, teamService } = fixture();
  const organization = await createOrganization(organizationService);

  const standalone = await teamService.createTeam({ actor: owner, name: "Adoptable Team", settings });
  const teamMemberInvite = await teamService.inviteMember({ actor: owner, teamId: standalone.id, email: member.email, settings });
  await teamService.acceptInvitation({ actor: member, invitationId: teamMemberInvite.id, settings });

  await assert.rejects(
    organizationService.adoptStandaloneTeam({ actor: owner, organizationId: organization.id, teamId: standalone.id }),
    (error: unknown) => error instanceof AppError
      && error.code === "ORGANIZATION_TEAM_MEMBERSHIP_REQUIRED"
      && error.statusCode === 409,
  );
  assert.equal((await teamService.listDashboard(owner)).teams.find((team) => team.id === standalone.id)?.organizationId, null);

  const memberOrgInvite = await organizationService.inviteMember({
    actor: owner,
    organizationId: organization.id,
    email: member.email,
  });
  await organizationService.acceptInvitation({ actor: member, invitationId: memberOrgInvite.id });
  const adopted = await organizationService.adoptStandaloneTeam({
    actor: owner,
    organizationId: organization.id,
    teamId: standalone.id,
  });
  assert.equal(adopted.organizationId, organization.id);
  assert.equal((await teamService.listDashboard(member)).teams.find((team) => team.id === standalone.id)?.organizationId, organization.id);

  await assert.rejects(
    organizationService.adoptStandaloneTeam({ actor: owner, organizationId: organization.id, teamId: standalone.id }),
    (error: unknown) => error instanceof AppError
      && error.code === "TEAM_ALREADY_PARENTED"
      && error.statusCode === 409,
  );
});

test("adoption rejects cross-organization actors and policy-disabled adoption", async () => {
  const { organizationService, teamService } = fixture();
  const organization = await createOrganization(organizationService);
  const otherOrganization = await organizationService.createOrganization({
    actor: outsider,
    name: "Other Organization",
    slug: "other-organization",
  });
  const standalone = await teamService.createTeam({ actor: owner, name: "Scoped Team", settings });

  await assert.rejects(
    organizationService.adoptStandaloneTeam({ actor: outsider, organizationId: organization.id, teamId: standalone.id }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_NOT_FOUND",
  );
  assert.equal((await teamService.listDashboard(owner)).teams.find((team) => team.id === standalone.id)?.organizationId, null);

  await organizationService.appendPolicyRevision({
    actor: owner,
    organizationId: organization.id,
    policy: {
      ...defaultOrganizationPolicyV1,
      teams: { ...defaultOrganizationPolicyV1.teams, allowStandaloneTeamAdoption: false },
    },
  });
  await assert.rejects(
    organizationService.adoptStandaloneTeam({ actor: owner, organizationId: organization.id, teamId: standalone.id }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_TEAM_ADOPTION_DISABLED",
  );
  assert.equal((await organizationService.getOrganization(outsider, otherOrganization.id))?.role, "owner");
});

test("parented team invitations require active organization membership before mutation", async () => {
  const { organizationService, teamService } = fixture();
  const organization = await createOrganization(organizationService);
  const child = await organizationService.createChildTeam({ actor: owner, organizationId: organization.id, name: "Membership Team" });
  const invitation = await teamService.inviteMember({ actor: owner, teamId: child.id, email: outsider.email, settings });

  await assert.rejects(
    teamService.acceptInvitation({ actor: outsider, invitationId: invitation.id, settings }),
    (error: unknown) => error instanceof AppError
      && error.code === "ORGANIZATION_MEMBERSHIP_REQUIRED"
      && error.statusCode === 403,
  );
  assert.equal((await teamService.listDashboard(outsider)).teams.some((team) => team.id === child.id), false);
  assert.equal((await teamService.listDashboard(outsider)).invitations.some((item) => item.id === invitation.id), true);

  const organizationInvite = await organizationService.inviteMember({
    actor: owner,
    organizationId: organization.id,
    email: outsider.email,
  });
  await organizationService.acceptInvitation({ actor: outsider, invitationId: organizationInvite.id });
  await teamService.acceptInvitation({ actor: outsider, invitationId: invitation.id, settings });
  assert.equal((await teamService.listDashboard(outsider)).teams.some((team) => team.id === child.id), true);
});

test("parented team invitations allow external members when organization policy permits them", async () => {
  const { organizationService, teamService } = fixture();
  const organization = await organizationService.createOrganization({
    actor: owner,
    name: "External Team Organization",
    slug: "external-team-organization",
    policy: {
      teams: { requireOrganizationMembershipForTeamMembers: false },
    },
  });
  const child = await organizationService.createChildTeam({
    actor: owner,
    organizationId: organization.id,
    name: "External Members Team",
  });
  const invitation = await teamService.inviteMember({
    actor: owner,
    teamId: child.id,
    email: outsider.email,
    settings,
  });

  await teamService.acceptInvitation({ actor: outsider, invitationId: invitation.id, settings });

  assert.deepEqual(
    (await teamService.listDashboard(outsider)).teams.map((team) => team.id),
    [child.id],
  );
});

async function createOrganization(service: OrganizationService) {
  return service.createOrganization({
    actor: owner,
    name: "Platform Organization",
    slug: "platform-organization",
  });
}

function fixture(): {
  organizationService: OrganizationService;
  teamService: TeamService;
  teamStore: MemoryTeamStore;
} {
  const organizationStore = new MemoryOrganizationStore({ now: () => new Date("2026-08-30T00:00:00.000Z") });
  const teamStore = new MemoryTeamStore({ organizationStore });
  for (const user of [owner, admin, member, outsider]) {
    organizationStore.addKnownUser(user);
    teamStore.addKnownUser(user);
  }
  const teamService = new TeamService(teamStore);
  return {
    organizationService: new OrganizationService(organizationStore, teamService),
    teamService,
    teamStore,
  };
}
