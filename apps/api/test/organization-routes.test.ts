import assert from "node:assert/strict";
import test from "node:test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { defaultOrganizationPolicyV1 } from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemoryOrganizationStore } from "../src/organizations/memory-organization-store.js";
import { OrganizationService } from "../src/organizations/service.js";
import { MemoryTeamStore } from "../src/teams/memory-team-store.js";
import { TeamService } from "../src/teams/service.js";

type TestRole = "owner" | "admin" | "maintainer" | "author" | "user";
type TestUser = { id: string; email: string; name: string; roles: TestRole[] };

const owner: TestUser = {
  id: "owner-user",
  email: "owner@example.com",
  name: "Owner",
  roles: ["owner"],
};
const admin: TestUser = {
  id: "admin-user",
  email: "admin@example.com",
  name: "Admin",
  roles: ["user"],
};
const member: TestUser = {
  id: "member-user",
  email: "member@example.com",
  name: "Member",
  roles: ["user"],
};
const outsider: TestUser = {
  id: "outsider-user",
  email: "outsider@example.com",
  name: "Outsider",
  roles: ["user"],
};

test("organization routes cover scoped membership, policy rollback, teams, and session-only writes", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.app.close());

  const created = await fixture.app.inject({
    method: "POST",
    url: "/v1/organizations",
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
    payload: { name: "Platform Skills", slug: "platform-skills" },
  });
  assert.equal(created.statusCode, 201);
  const organization = created.json().organization as {
    id: string;
    currentPolicy: { id: string; revisionNumber: number };
  };
  assert.equal(organization.currentPolicy.revisionNumber, 1);

  const listed = await fixture.app.inject({
    method: "GET",
    url: "/v1/organizations",
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().organizations.map((item: { id: string }) => item.id), [organization.id]);

  const detail = await fixture.app.inject({
    method: "GET",
    url: `/v1/organizations/${organization.id}`,
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().organization.role, "owner");

  const adminInvitation = await fixture.app.inject({
    method: "POST",
    url: `/v1/organizations/${organization.id}/invitations`,
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
    payload: { email: admin.email, role: "admin" },
  });
  assert.equal(adminInvitation.statusCode, 201);
  const adminInvitationId = adminInvitation.json().invitation.id as string;

  const pending = await fixture.app.inject({
    method: "GET",
    url: "/v1/organizations/invitations",
    headers: { authorization: `Bearer ${fixture.tokens.admin}` },
  });
  assert.equal(pending.statusCode, 200);
  assert.deepEqual(pending.json().invitations.map((item: { id: string }) => item.id), [adminInvitationId]);

  const acceptedAdmin = await fixture.app.inject({
    method: "POST",
    url: `/v1/organizations/invitations/${adminInvitationId}/accept`,
    headers: { authorization: `Bearer ${fixture.tokens.admin}` },
    payload: {},
  });
  assert.equal(acceptedAdmin.statusCode, 200);
  assert.equal(acceptedAdmin.json().invitation.status, "accepted");

  const memberInvitation = await fixture.app.inject({
    method: "POST",
    url: `/v1/organizations/${organization.id}/invitations`,
    headers: { authorization: `Bearer ${fixture.tokens.admin}` },
    payload: { email: member.email },
  });
  assert.equal(memberInvitation.statusCode, 201);
  const memberInvitationId = memberInvitation.json().invitation.id as string;
  const acceptedMember = await fixture.app.inject({
    method: "POST",
    url: `/v1/organizations/invitations/${memberInvitationId}/accept`,
    headers: { authorization: `Bearer ${fixture.tokens.member}` },
    payload: {},
  });
  assert.equal(acceptedMember.statusCode, 200);

  const members = await fixture.app.inject({
    method: "GET",
    url: `/v1/organizations/${organization.id}/members`,
    headers: { authorization: `Bearer ${fixture.tokens.member}` },
  });
  assert.equal(members.statusCode, 200);
  assert.equal(members.json().members.length, 3);

  const memberInvitationList = await fixture.app.inject({
    method: "GET",
    url: `/v1/organizations/${organization.id}/invitations`,
    headers: { authorization: `Bearer ${fixture.tokens.member}` },
  });
  assert.equal(memberInvitationList.statusCode, 403);
  assert.equal(memberInvitationList.json().error.code, "ORGANIZATION_ADMIN_REQUIRED");

  const outsiderDetail = await fixture.app.inject({
    method: "GET",
    url: `/v1/organizations/${organization.id}`,
    headers: { authorization: `Bearer ${fixture.tokens.outsider}` },
  });
  assert.equal(outsiderDetail.statusCode, 404);
  assert.equal(outsiderDetail.json().error.code, "ORGANIZATION_NOT_FOUND");

  const apiTokenResponse = await fixture.app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
    payload: { name: "organization read", scopes: ["profile:read"] },
  });
  assert.equal(apiTokenResponse.statusCode, 201);
  const apiToken = apiTokenResponse.json().token.token as string;
  const apiRead = await fixture.app.inject({
    method: "GET",
    url: `/v1/organizations/${organization.id}`,
    headers: { authorization: `Bearer ${apiToken}` },
  });
  assert.equal(apiRead.statusCode, 403);
  assert.equal(apiRead.json().error.code, "SESSION_AUTH_REQUIRED");

  const promoted = await fixture.app.inject({
    method: "PUT",
    url: `/v1/organizations/${organization.id}/members/${member.id}`,
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
    payload: { role: "owner" },
  });
  assert.equal(promoted.statusCode, 200);

  const demoted = await fixture.app.inject({
    method: "PUT",
    url: `/v1/organizations/${organization.id}/members/${owner.id}`,
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
    payload: { role: "member" },
  });
  assert.equal(demoted.statusCode, 200);
  const lastOwner = await fixture.app.inject({
    method: "PUT",
    url: `/v1/organizations/${organization.id}/members/${member.id}`,
    headers: { authorization: `Bearer ${fixture.tokens.member}` },
    payload: { role: "member" },
  });
  assert.equal(lastOwner.statusCode, 409);
  assert.equal(lastOwner.json().error.code, "LAST_ORGANIZATION_OWNER_REQUIRED");

  const firstPolicyId = organization.currentPolicy.id;
  const appended = await fixture.app.inject({
    method: "POST",
    url: `/v1/organizations/${organization.id}/policy-revisions`,
    headers: { authorization: `Bearer ${fixture.tokens.member}` },
    payload: {
      policy: {
        sharing: { organizationArchitectureSharingEnabled: false },
      },
      reason: "Test policy rollback",
    },
  });
  assert.equal(appended.statusCode, 201);
  const secondPolicyId = appended.json().revision.id as string;
  assert.notEqual(secondPolicyId, firstPolicyId);

  const policies = await fixture.app.inject({
    method: "GET",
    url: `/v1/organizations/${organization.id}/policy-revisions`,
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
  });
  assert.equal(policies.statusCode, 200);
  assert.equal(policies.json().revisions.length, 2);

  const activated = await fixture.app.inject({
    method: "POST",
    url: `/v1/organizations/${organization.id}/policy-revisions/${firstPolicyId}/actions`,
    headers: { authorization: `Bearer ${fixture.tokens.member}` },
    payload: { action: "activate" },
  });
  assert.equal(activated.statusCode, 200);
  assert.equal(activated.json().revision.id, firstPolicyId);
  assert.equal(activated.json().changed, true);

  const child = await fixture.app.inject({
    method: "POST",
    url: `/v1/organizations/${organization.id}/teams`,
    headers: { authorization: `Bearer ${fixture.tokens.member}` },
    payload: { name: "Platform Team", slug: "platform-team" },
  });
  assert.equal(child.statusCode, 201);
  assert.equal(child.json().team.organizationId, organization.id);

  const childList = await fixture.app.inject({
    method: "GET",
    url: `/v1/organizations/${organization.id}/teams`,
    headers: { authorization: `Bearer ${fixture.tokens.member}` },
  });
  assert.equal(childList.statusCode, 200);
  assert.deepEqual(childList.json().teams.map((team: { id: string }) => team.id), [child.json().team.id]);

  const standaloneWithOrganization = await fixture.app.inject({
    method: "POST",
    url: "/v1/teams",
    headers: { authorization: `Bearer ${fixture.tokens.member}` },
    payload: { name: "Standalone", organizationId: organization.id },
  });
  assert.equal(standaloneWithOrganization.statusCode, 400);
  assert.equal(standaloneWithOrganization.json().error.code, "ORGANIZATION_TEAM_ROUTE_REQUIRED");

  const standalone = await fixture.app.inject({
    method: "POST",
    url: "/v1/teams",
    headers: { authorization: `Bearer ${fixture.tokens.member}` },
    payload: { name: "Standalone" },
  });
  assert.equal(standalone.statusCode, 201);
  const adopted = await fixture.app.inject({
    method: "PUT",
    url: `/v1/teams/${standalone.json().team.id}/organization`,
    headers: { authorization: `Bearer ${fixture.tokens.member}` },
    payload: { organizationId: organization.id },
  });
  assert.equal(adopted.statusCode, 200);
  assert.equal(adopted.json().team.organizationId, organization.id);

  const archived = await fixture.app.inject({
    method: "POST",
    url: `/v1/organizations/${organization.id}/actions`,
    headers: { authorization: `Bearer ${fixture.tokens.member}` },
    payload: { action: "archive" },
  });
  assert.equal(archived.statusCode, 200);
  assert.equal(archived.json().organization.status, "archived");
});

test("skill-sharing routes expose organization grants and enforce the instance gate", async (t) => {
  const fixture = await createFixture({ withSkill: true });
  t.after(() => fixture.app.close());

  const created = await fixture.app.inject({
    method: "POST",
    url: "/v1/organizations",
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
    payload: { name: "Skill Organization", slug: "skill-organization" },
  });
  assert.equal(created.statusCode, 201);
  const organizationId = created.json().organization.id as string;
  fixture.skillRepository.addOrganization({
    id: organizationId,
    name: "Skill Organization",
    slug: "skill-organization",
    policy: defaultOrganizationPolicyV1,
  });
  fixture.skillRepository.addOrganizationMembership(fixture.owner.id, organizationId, "owner");

  const enabled = await fixture.app.inject({
    method: "PUT",
    url: "/v1/admin/sharing",
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
    payload: {
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: true,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: true,
      organizationVisibilityEnabled: true,
    },
  });
  assert.equal(enabled.statusCode, 200);
  assert.equal(enabled.json().sharing.organizationVisibilityEnabled, true);

  const updated = await fixture.app.inject({
    method: "PUT",
    url: "/v1/skills/organization-helper/sharing",
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
    payload: { visibility: "organization", teamIds: [], userEmails: [], organizationIds: [organizationId] },
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json().sharing.organizationGrants.map((item: { id: string }) => item.id), [organizationId]);

  const details = await fixture.app.inject({
    method: "GET",
    url: "/v1/skills/organization-helper/sharing",
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
  });
  assert.equal(details.statusCode, 200);
  assert.deepEqual(details.json().sharing.availableOrganizations.map((item: { id: string }) => item.id), [organizationId]);

  const disabled = await fixture.app.inject({
    method: "PUT",
    url: "/v1/admin/sharing",
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
    payload: {
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: true,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: true,
      organizationVisibilityEnabled: false,
    },
  });
  assert.equal(disabled.statusCode, 200);

  const rejected = await fixture.app.inject({
    method: "PUT",
    url: "/v1/skills/organization-helper/sharing",
    headers: { authorization: `Bearer ${fixture.tokens.owner}` },
    payload: { visibility: "organization", teamIds: [], userEmails: [], organizationIds: [organizationId] },
  });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.json().error.code, "ORGANIZATION_SHARING_DISABLED");
});

async function createFixture(options: { withSkill?: boolean } = {}) {
  const authStore = new MemoryAuthStore("closed");
  const organizationStore = new MemoryOrganizationStore();
  const teamStore = new MemoryTeamStore({ organizationStore });
  const teamService = new TeamService(teamStore);
  const organizationService = new OrganizationService(organizationStore, teamService);
  const skillRepository = new MemorySkillRepository(options.withSkill ? [{
    slug: "organization-helper",
    title: "Organization Helper",
    summary: "Organization route fixture.",
    lifecycleStatus: "approved",
    visibility: "private",
    latestVersion: "1.0.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [],
    tags: [],
    ownerUserId: owner.id,
  }] : []);
  for (const user of [owner, admin, member, outsider]) {
    authStore.addUser({
      id: user.id,
      email: user.email,
      name: user.name,
      status: "active",
      emailVerifiedAt: new Date(),
      roles: user.roles,
      passwordHash: await hashPassword("correct horse battery staple"),
    });
    organizationStore.addKnownUser(user);
    teamStore.addKnownUser(user);
  }
  const app = buildApp({
    skillRepository,
    authService: new AuthService(authStore),
    teamService,
    organizationService,
  });
  const tokens = {
    owner: await addUserAndLoginWithMfa(app, owner),
    admin: await addUserAndLoginWithMfa(app, admin),
    member: await addUserAndLoginWithMfa(app, member),
    outsider: await addUserAndLoginWithMfa(app, outsider),
  };
  return { app, owner, skillRepository, tokens };
}

async function addUserAndLoginWithMfa(app: ReturnType<typeof buildApp>, user: TestUser): Promise<string> {
  const setup = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: user.email, password: "correct horse battery staple" },
  });
  assert.equal(setup.statusCode, 200);
  const setupToken = setup.json().token as string;
  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${setupToken}` },
    payload: { password: "correct horse battery staple" },
  });
  assert.equal(enrollment.statusCode, 201);
  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${setupToken}` },
    payload: {
      factorId: enrollment.json().enrollment.factorId,
      code: generateTotpCode(enrollment.json().enrollment.secret),
    },
  });
  assert.equal(confirm.statusCode, 200);
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: user.email, password: "correct horse battery staple" },
  });
  assert.equal(login.statusCode, 200);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: login.json().challengeToken,
      recoveryCode: confirm.json().mfa.recoveryCodes[0],
    },
  });
  assert.equal(verify.statusCode, 200);
  return verify.json().token as string;
}
