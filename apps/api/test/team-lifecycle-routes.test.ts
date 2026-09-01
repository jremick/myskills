import test from "node:test";
import assert from "node:assert/strict";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { TeamService } from "../src/teams/service.js";
import { MemoryTeamStore } from "../src/teams/memory-team-store.js";

test("team lifecycle routes enforce owner access and preserve the final owner", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const teamStore = new MemoryTeamStore();
  const app = buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: new AuthService(authStore),
    teamService: new TeamService(teamStore),
  });
  t.after(() => app.close());

  const ownerToken = await addUserAndLoginWithMfa(app, authStore, {
    id: "owner-user",
    email: "owner@example.com",
  });
  const memberToken = await addUserAndLoginWithMfa(app, authStore, {
    id: "member-user",
    email: "member@example.com",
  });
  const secondMemberToken = await addUserAndLogin(app, authStore, {
    id: "second-member-user",
    email: "second@example.com",
  });
  for (const user of [
    { id: "owner-user", email: "owner@example.com", name: "Owner" },
    { id: "member-user", email: "member@example.com", name: "Member" },
    { id: "second-member-user", email: "second@example.com", name: "Second Member" },
  ]) {
    teamStore.addKnownUser(user);
  }

  const created = await app.inject({
    method: "POST",
    url: "/v1/teams",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Platform" },
  });
  assert.equal(created.statusCode, 201);
  const teamId = created.json().team.id as string;

  const pending = await app.inject({
    method: "POST",
    url: `/v1/teams/${teamId}/invitations`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { email: "pending@example.com" },
  });
  assert.equal(pending.statusCode, 201);
  const pendingInvitationId = pending.json().invitation.id as string;

  const deniedRevoke = await app.inject({
    method: "DELETE",
    url: `/v1/teams/${teamId}/invitations/${pendingInvitationId}`,
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(deniedRevoke.statusCode, 403);
  assert.equal(deniedRevoke.json().error.code, "TEAM_OWNER_REQUIRED");

  const revoked = await app.inject({
    method: "DELETE",
    url: `/v1/teams/${teamId}/invitations/${pendingInvitationId}`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().invitation.status, "revoked");

  const memberInvitation = await inviteAndAccept(app, ownerToken, memberToken, teamId, "member@example.com");
  assert.equal(memberInvitation.status, "accepted");
  const secondInvitation = await inviteAndAccept(app, ownerToken, secondMemberToken, teamId, "second@example.com");
  assert.equal(secondInvitation.status, "accepted");

  const deniedRoleUpdate = await app.inject({
    method: "PUT",
    url: `/v1/teams/${teamId}/members/second-member-user`,
    headers: { authorization: `Bearer ${memberToken}` },
    payload: { role: "owner" },
  });
  assert.equal(deniedRoleUpdate.statusCode, 403);
  assert.equal(deniedRoleUpdate.json().error.code, "TEAM_OWNER_REQUIRED");

  const promoted = await app.inject({
    method: "PUT",
    url: `/v1/teams/${teamId}/members/member-user`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { role: "owner" },
  });
  assert.equal(promoted.statusCode, 200);
  assert.equal(promoted.json().member.id, "member-user");
  assert.equal(promoted.json().member.role, "owner");

  const demoted = await app.inject({
    method: "PUT",
    url: `/v1/teams/${teamId}/members/owner-user`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { role: "member" },
  });
  assert.equal(demoted.statusCode, 200);
  assert.equal(demoted.json().member.role, "member");

  const lastOwnerRoleChange = await app.inject({
    method: "PUT",
    url: `/v1/teams/${teamId}/members/member-user`,
    headers: { authorization: `Bearer ${memberToken}` },
    payload: { role: "member" },
  });
  assert.equal(lastOwnerRoleChange.statusCode, 409);
  assert.equal(lastOwnerRoleChange.json().error.code, "LAST_OWNER_REQUIRED");

  const removed = await app.inject({
    method: "DELETE",
    url: `/v1/teams/${teamId}/members/owner-user`,
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().member.id, "owner-user");

  const removedUserDashboard = await app.inject({
    method: "GET",
    url: "/v1/teams",
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(removedUserDashboard.statusCode, 200);
  assert.deepEqual(removedUserDashboard.json().teams, []);

  const lastOwnerRemoval = await app.inject({
    method: "DELETE",
    url: `/v1/teams/${teamId}/members/member-user`,
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(lastOwnerRemoval.statusCode, 409);
  assert.equal(lastOwnerRemoval.json().error.code, "LAST_OWNER_REQUIRED");
});

test("team lifecycle routes reject malformed identifiers and roles", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const teamStore = new MemoryTeamStore();
  const app = buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: new AuthService(authStore),
    teamService: new TeamService(teamStore),
  });
  t.after(() => app.close());

  const ownerToken = await addUserAndLogin(app, authStore, {
    id: "owner-user",
    email: "owner@example.com",
  });

  const malformedMember = await app.inject({
    method: "DELETE",
    url: "/v1/teams/team-1/members/not%20an%20id",
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(malformedMember.statusCode, 400);
  assert.equal(malformedMember.json().error.code, "INVALID_REQUEST_BODY");

  const malformedRole = await app.inject({
    method: "PUT",
    url: "/v1/teams/team-1/members/member-1",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { role: "administrator" },
  });
  assert.equal(malformedRole.statusCode, 400);
  assert.equal(malformedRole.json().error.code, "INVALID_TEAM_MEMBER_ROLE");
});

async function inviteAndAccept(
  app: ReturnType<typeof buildApp>,
  ownerToken: string,
  memberToken: string,
  teamId: string,
  email: string,
): Promise<{ status: string }> {
  const invited = await app.inject({
    method: "POST",
    url: `/v1/teams/${teamId}/invitations`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { email },
  });
  assert.equal(invited.statusCode, 201);
  const accepted = await app.inject({
    method: "POST",
    url: `/v1/teams/invitations/${invited.json().invitation.id}/accept`,
    headers: { authorization: `Bearer ${memberToken}` },
    payload: {},
  });
  assert.equal(accepted.statusCode, 200);
  return accepted.json().invitation;
}

async function addUserAndLogin(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  input: { id: string; email: string },
): Promise<string> {
  authStore.addUser({
    id: input.id,
    email: input.email,
    name: input.email.split("@")[0],
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["user"],
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: input.email,
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);
  return login.json().token;
}

async function addUserAndLoginWithMfa(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  input: { id: string; email: string },
): Promise<string> {
  const setupSession = await addUserAndLogin(app, authStore, input);
  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${setupSession}` },
    payload: {
      password: "correct horse battery staple",
    },
  });
  assert.equal(enrollment.statusCode, 201);

  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${setupSession}` },
    payload: {
      factorId: enrollment.json().enrollment.factorId,
      code: generateTotpCode(enrollment.json().enrollment.secret),
    },
  });
  assert.equal(confirm.statusCode, 200);

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: input.email,
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().mfaRequired, true);

  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: login.json().challengeToken,
      recoveryCode: confirm.json().mfa.recoveryCodes[0],
    },
  });
  assert.equal(verify.statusCode, 200);
  assert.equal(verify.json().user.mfaVerified, true);
  return verify.json().token as string;
}
